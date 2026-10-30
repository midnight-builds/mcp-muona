// Core of the S-group session module: owns the S-Etukortti app session (the
// CSRF token cell), relogin and its gate, the IdP lease, the login steps and
// keepalive. Data fetchers only see get() and capture(); they never learn
// that sessions, tokens or relogins exist.

import * as z from "zod/v4";
import { logger } from "../../logger.ts";
import { ProfileLockedError } from "../profile-lock.ts";
import { LOGIN_INSTRUCTIONS, SessionExpiredError } from "./errors.ts";
import { decideRelogin, type ReloginDecision } from "./gate.ts";
import { createIdpLease, type LeaseReport } from "./lease.ts";
import { createLoginFlow, type LoginSteps, type SilentLoginResult } from "./login.ts";
import {
	type CallbackFlowTarget,
	type CsrfObservation,
	type LoginPhase,
	PHASES_NEEDING_HUMAN,
	type SGroupConfig,
	type SGroupPorts,
} from "./ports.ts";
import {
	createSilentIdpFlows,
	type SilentIdpFlowName,
	type SilentIdpFlowOutcome,
} from "./silent-flow.ts";

export type SessionStatus =
	| { loggedIn: true }
	| {
			loggedIn: false;
			reason: string;
			instructions: string;
			expiredReason?: SessionExpiredError["reason"];
	  };

export type KeepaliveInfo = {
	at: string;
	ok: boolean;
	// skipped: a human login was in progress, so the tick left the session alone.
	outcome: "refreshed" | "recovered" | "skipped" | "failed";
	error?: string;
} | null;

export type AutoReloginInfo = {
	lastAttemptAt: string | null;
	lastOutcome: LoginPhase | null;
	blockedReason: string | null;
};

export type SessionReport = {
	keepalive: KeepaliveInfo;
	autoRelogin: AutoReloginInfo;
	appSession: { hasToken: boolean; tokenGeneration: number; keepaliveArmed: boolean };
	idpLease: LeaseReport;
};

export interface SGroupSession {
	// Authenticated GET against api.s-etukortti.fi. An expired app session is
	// recovered with one shared relogin and the call retried once; anything
	// that still fails surfaces as SessionExpiredError with a reason. Network
	// errors, non-auth HTTP errors and schema mismatches pass through as-is.
	get<S extends z.ZodType>(
		path: string,
		params: Record<string, string>,
		schema: S,
	): Promise<z.infer<S>>;
	// Navigates a page in the shared browser and resolves with the JSON body of
	// the first response whose URL matches, for SPAs whose API only answers to
	// the page's own auth. Expiry is recovered and retried exactly like get();
	// a page that never makes the call (timeout) or fails to load passes
	// through unchanged and is not retried.
	capture(
		url: string,
		match: (responseUrl: string) => boolean,
		opts?: { timeoutMs?: number },
	): Promise<unknown>;
	probe(): Promise<SessionStatus>;
	report(): SessionReport;
	// Human login steps. A human login holds the IdP lease from start until it
	// ends (logged_in, failed, cancel, or 10 idle minutes); meanwhile page
	// navigations fail fast with login_in_progress and relogins are declined.
	login: LoginSteps;
	// Another service's silent login through the shared IdP, under the same
	// gate and the exclusive IdP lease as the relogin; waits (bounded) for
	// other silent flows, never for a human. Declines, a human step and IdP
	// failures are outcomes; only a broken browser throws. A human step sets
	// the relogin block and closes the page: the human logs in to S-Etukortti.
	runSilentIdpFlow(
		flow: SilentIdpFlowName,
		target: CallbackFlowTarget,
	): Promise<SilentIdpFlowOutcome>;
	close(): Promise<void>;
}

const PROBE_PATH = "/api/v1/bonus-levels";

type Seen =
	| { kind: "token"; token: string; generation: number }
	| { kind: "logged_out"; generation: number; detail: string };

type Attempt<T> = { kind: "ok"; value: T } | { kind: "unauthorized"; detail: string };

export function createSGroupSession(ports: SGroupPorts, cfg: SGroupConfig): SGroupSession {
	const { site, store, clock, idp } = ports;
	const lease = createIdpLease(clock);
	const flow = createLoginFlow({
		idp,
		store,
		clock,
		lease,
		verifyLanded,
		reloginInFlight: () => reloginInFlight,
		loginCompleted: (by) => {
			lastCompletedSeq = ++eventSeq;
			// A human or manual login is a new start: whatever the relogin hold
			// assumed about the app session no longer holds.
			if (by === "login_steps") lastReloginSucceededAt = null;
		},
	});
	const runSilentIdpFlow = createSilentIdpFlows({
		idp,
		store,
		clock,
		lease,
		humanLoginActive: () => flow.humanLoginActive(),
	});

	// I1: one token cell. Only refreshToken() writes a token into it; anyone
	// may invalidate, but only for the generation they actually used.
	const cell: { token: string | null; generation: number } = { token: null, generation: 0 };
	let refreshInFlight: { promise: Promise<Seen>; fresh: boolean } | null = null;
	let reloginInFlight: Promise<void> | null = null;
	let lastAttempt: { at: number; outcome: LoginPhase | null } | null = null;
	// Relogin attempts and completed logins in the order they happened; the
	// clock cannot order two events in the same millisecond.
	let eventSeq = 0;
	let lastAttemptSeq = 0;
	let lastCompletedSeq = 0;
	let lastReloginSucceededAt: number | null = null;
	// What the latest CSRF refresh observed, to tell a refused app session
	// (token issued, API says 401/403) from one that is gone.
	let lastRefresh: Seen["kind"] | null = null;
	let keepalive: KeepaliveInfo = null;
	let cancelKeepalive: (() => void) | null = null;

	site.onContextClosed(() => invalidate(cell.generation, "browser context closed"));

	function invalidate(generation: number, why: string): void {
		if (cell.generation !== generation || cell.token === null) return;
		cell.token = null;
		logger.info({ generation, why }, "S-Etukortti CSRF token invalidated");
	}

	// Page navigations may bounce to the IdP, so they share the IdP lease.
	async function onPage<T>(purpose: string, navigate: () => Promise<T>): Promise<T> {
		const release = await lease.acquireShared(purpose);
		try {
			return await navigate();
		} finally {
			release();
		}
	}

	function sniffToken(): Promise<CsrfObservation> {
		return onPage("csrf_sniff", () => site.sniffCsrfToken());
	}

	async function observeToken(via: "prefer_fast" | "page"): Promise<CsrfObservation> {
		if (via === "page") return sniffToken();
		try {
			return await site.fetchCsrfToken();
		} catch (err) {
			// The page sniff opens the same profile and would only fail the same way.
			if (err instanceof ProfileLockedError) throw err;
			logger.warn(
				{ err },
				"Fast S-Etukortti CSRF fetch failed, falling back to page-sniff capture",
			);
			return sniffToken();
		}
	}

	// fresh: the caller needs a token issued after a login it just completed.
	// A non-fresh refresh in flight may have been sent before that login
	// landed and would answer "logged out", so a fresh caller waits it out
	// and starts its own. Logins never overlap, so fresh refreshes can share.
	async function refreshToken(via: "prefer_fast" | "page", fresh = false): Promise<Seen> {
		while (refreshInFlight && fresh && !refreshInFlight.fresh) {
			await refreshInFlight.promise.catch(() => undefined);
		}
		if (!refreshInFlight) {
			const promise = observeToken(via)
				.then((observation): Seen => {
					lastRefresh = observation.kind;
					if (observation.kind === "logged_out") {
						invalidate(cell.generation, "app session logged out");
						return { kind: "logged_out", generation: cell.generation, detail: observation.detail };
					}
					cell.generation += 1;
					cell.token = observation.token;
					logger.info({ generation: cell.generation, via }, "S-Etukortti CSRF token captured");
					armKeepalive();
					return { kind: "token", token: observation.token, generation: cell.generation };
				})
				.finally(() => {
					if (refreshInFlight?.promise === promise) refreshInFlight = null;
				});
			refreshInFlight = { promise, fresh };
		}
		return refreshInFlight.promise;
	}

	function currentToken(): Promise<Seen> {
		if (cell.token !== null) {
			return Promise.resolve({ kind: "token", token: cell.token, generation: cell.generation });
		}
		return refreshToken("prefer_fast");
	}

	// A login that just landed is confirmed by the app issuing a token. Fresh:
	// an earlier token request may still answer "logged out". Never relogins,
	// since it may run inside the relogin itself.
	async function verifyLanded(): Promise<{ loggedIn: true } | { loggedIn: false; reason: string }> {
		const seen = await refreshToken("prefer_fast", true);
		if (seen.kind === "token") return { loggedIn: true };
		return {
			loggedIn: false,
			reason: `Login completed but the app session is still logged out: ${seen.detail}`,
		};
	}

	// I2/I3: every caller that hit the expiry awaits this same promise.
	function relogin(): Promise<void> {
		if (!reloginInFlight) {
			reloginInFlight = runRelogin().finally(() => {
				reloginInFlight = null;
			});
		}
		return reloginInFlight;
	}

	async function decide(): Promise<ReloginDecision> {
		return decideRelogin(
			{
				blockedReason: store.getReloginBlock(),
				lastAttempt,
				loginCompletedSinceAttempt: lastCompletedSeq > lastAttemptSeq,
				lastReloginSucceededAt,
				appSessionRefused: lastRefresh === "token",
				savedEmail: store.getSavedEmail(),
				humanLoginActive: await flow.humanLoginActive(),
			},
			clock.now(),
		);
	}

	async function runRelogin(): Promise<void> {
		let decision = await decide();
		if (decision.kind === "decline" && decision.reason === "still_unauthorized") {
			// Only a token refresh tells a refused app session from one that is
			// really gone (logged out elsewhere), which a relogin does fix.
			logger.info("Relogin held after a recent success; checking whether the app session is gone");
			const seen = await refreshToken("prefer_fast").catch((err: unknown) => {
				logger.warn({ err }, "CSRF refresh for the relogin hold failed; keeping the hold");
				return null;
			});
			if (seen?.kind === "logged_out") {
				logger.info("App session is logged out right after a successful relogin; relogin allowed");
				decision = await decide();
			} else if (seen?.kind === "token") {
				// A new generation: the caller's retry uses the new token. A stale
				// CSRF token is fixed by that; a persistent 403 fails the retry
				// with still_unauthorized. Neither needs an IdP flow.
				logger.info(
					{
						generation: seen.generation,
						lastOutcome: decision.hold?.lastOutcome,
						remainingMinutes: decision.hold?.remainingMinutes,
					},
					"Relogin held after a recent success; retrying with the new token",
				);
				return;
			}
		}
		if (decision.kind === "decline") {
			logger.info(
				{
					reason: decision.reason,
					detail: decision.detail,
					lastOutcome: decision.hold?.lastOutcome,
					remainingMinutes: decision.hold?.remainingMinutes,
				},
				"Relogin declined",
			);
			throw new SessionExpiredError(decision.reason, decision.detail);
		}

		const email = decision.email;
		// Recorded before the attempt so one that throws still counts as failed.
		const previousAttempt = lastAttempt;
		const previousAttemptSeq = lastAttemptSeq;
		const attemptAt = clock.now();
		lastAttempt = { at: attemptAt, outcome: null };
		lastAttemptSeq = ++eventSeq;
		const ages = store.loginAges();
		logger.info(
			{
				email,
				hoursSinceHumanLogin: ages?.hoursSinceHumanLogin ?? null,
				hoursSinceSilentLogin: ages?.hoursSinceSilentLogin ?? null,
			},
			"S-Etukortti app session expired; attempting relogin with a silent login",
		);

		let result: SilentLoginResult;
		try {
			result = await flow.silentLogin(email);
		} catch (err) {
			// A human login took the IdP first: a decline, not a failed attempt.
			if (err instanceof SessionExpiredError) {
				lastAttempt = previousAttempt;
				lastAttemptSeq = previousAttemptSeq;
				throw err;
			}
			logger.warn({ err }, "Relogin attempt threw; will retry after cooldown");
			const message = err instanceof Error ? err.message : String(err);
			throw new SessionExpiredError("relogin_failed", `Relogin failed: ${message}`);
		}
		lastAttempt = { at: attemptAt, outcome: result.phase };

		// The login verified itself with a fresh token, which bumped the
		// generation before anyone is released: a late caller still holding the
		// dead token retries instead of relogging again.
		if (result.phase === "logged_in") {
			lastReloginSucceededAt = clock.now();
			logger.info("Relogin succeeded (S-tunnus SSO session was still alive)");
			return;
		}

		if (PHASES_NEEDING_HUMAN.includes(result.phase)) {
			const reason =
				`Automatic re-login stopped at ${result.phase}: OTP, captcha and strong ` +
				"authentication are never automated. A human must finish the login via the " +
				"s_etukortti_login_* tools (or `bun run login` with the server stopped).";
			store.setReloginBlock(reason);
			const agesNow = store.loginAges();
			// The SSO died somewhere after the last login that touched the IdP;
			// these two ages bracket its lifetime (see store/login-history.ts).
			logger.warn(
				{
					phase: result.phase,
					ssoExpired: true,
					hoursSinceHumanLogin: agesNow?.hoursSinceHumanLogin ?? null,
					hoursSinceSilentLogin: agesNow?.hoursSinceSilentLogin ?? null,
				},
				"Relogin needs a human step: handed over, relogin blocked until a login completes",
			);
			throw new SessionExpiredError("needs_human", reason);
		}

		logger.warn(
			{ phase: result.phase, error: result.error },
			"Relogin failed; will retry after cooldown",
		);
		throw new SessionExpiredError(
			"relogin_failed",
			`Relogin failed: ${result.error ?? `ended in ${result.phase}`}`,
		);
	}

	// I2: a caller whose failure is already stale (someone refreshed after the
	// token it used) just retries; otherwise it joins the one shared relogin.
	async function recover(seenGeneration: number): Promise<void> {
		if (cell.generation !== seenGeneration) {
			logger.info(
				{ seenGeneration, generation: cell.generation },
				"S-Etukortti app session already recovered by another caller; retrying",
			);
			return;
		}
		await relogin();
	}

	async function withAppSession<T>(op: (token: string) => Promise<Attempt<T>>): Promise<T> {
		let lastDetail = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			const seen = await currentToken();
			if (seen.kind === "token") {
				const result = await op(seen.token);
				if (result.kind === "ok") return result.value;
				invalidate(seen.generation, result.detail);
				lastDetail = result.detail;
			} else {
				lastDetail = seen.detail;
			}
			if (attempt === 2) break;
			await recover(seen.generation);
		}
		logger.warn(
			{ detail: lastDetail },
			"S-Etukortti app session still unauthorized after recovery",
		);
		throw new SessionExpiredError(
			"still_unauthorized",
			`${lastDetail} (still unauthorized after recovering the app session)`,
		);
	}

	async function apiAttempt<S extends z.ZodType>(
		path: string,
		params: Record<string, string>,
		schema: S,
		token: string,
	): Promise<Attempt<z.infer<S>>> {
		const observation = await site.apiGet(path, params, token);
		if (observation.kind === "unauthorized") {
			return {
				kind: "unauthorized",
				detail: `S-Etukortti API returned HTTP ${observation.status}.`,
			};
		}
		if (observation.kind === "http_error") {
			throw new Error(`S-Etukortti API HTTP ${observation.status} for ${path}`);
		}
		return { kind: "ok", value: schema.parse(observation.body) };
	}

	async function capture(
		url: string,
		match: (responseUrl: string) => boolean,
		opts?: { timeoutMs?: number },
	): Promise<unknown> {
		let lastDetail = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			// The generation seen before navigating: if another caller's relogin
			// moves it while the page loads, the retry needs no relogin of its own.
			const generation = cell.generation;
			logger.info({ url, attempt }, "S-Etukortti page capture started");
			const observation = await onPage("capture", () =>
				site.capturePage(url, match, opts?.timeoutMs),
			);
			if (observation.kind === "ok") return observation.body;
			lastDetail = observation.detail;
			logger.info(
				{ url, attempt, detail: lastDetail },
				"S-Etukortti page capture found a logged-out page",
			);
			// The page lives in the same browser as the API token, so it is stale too.
			invalidate(generation, lastDetail);
			if (attempt === 2) break;
			await recover(generation);
			logger.info({ url }, "S-Etukortti app session recovered; retrying page capture");
		}
		logger.warn(
			{ url, detail: lastDetail },
			"S-Etukortti page capture still unauthorized after recovery",
		);
		throw new SessionExpiredError(
			"still_unauthorized",
			`${lastDetail} (still unauthorized after recovering the app session)`,
		);
	}

	async function probe(): Promise<SessionStatus> {
		try {
			// Only whether the call is authorized matters, not what it returns.
			await withAppSession((token) => apiAttempt(PROBE_PATH, {}, z.unknown(), token));
			return { loggedIn: true };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof SessionExpiredError) {
				logger.info(
					{ reason, expiredReason: err.reason },
					"S-Etukortti session probe: not logged in",
				);
			} else {
				// A network error, 5xx or schema change says nothing about the login.
				logger.warn({ err }, "S-Etukortti session probe failed");
			}
			return {
				loggedIn: false,
				reason,
				instructions: LOGIN_INSTRUCTIONS,
				...(err instanceof SessionExpiredError ? { expiredReason: err.reason } : {}),
			};
		}
	}

	// Armed lazily on the first issued token, never at construction, so that
	// importing the composition root never drives a browser.
	function armKeepalive(): void {
		if (cancelKeepalive) return;
		cancelKeepalive = clock.every(cfg.keepaliveHours * 60 * 60 * 1000, keepaliveTick);
		logger.info({ hours: cfg.keepaliveHours }, "S-Etukortti keepalive armed");
	}

	// Keeps the app session alive by exercising the real browser session (a
	// page navigation) rather than the cheapest token fetch. An expiry gets the
	// same gated relogin as any caller; whatever it decides is only recorded,
	// for session_status to surface to a human.
	async function keepaliveTick(): Promise<void> {
		const at = () => new Date(clock.now()).toISOString();
		try {
			const seen = await refreshToken("page");
			if (seen.kind === "token") {
				keepalive = { at: at(), ok: true, outcome: "refreshed" };
				logger.info(
					{ generation: seen.generation },
					"S-Etukortti keepalive refreshed the app session",
				);
				return;
			}
			await recover(seen.generation);
			const after = await currentToken();
			if (after.kind === "logged_out") {
				keepalive = { at: at(), ok: false, outcome: "failed", error: after.detail };
				logger.warn(
					{ detail: after.detail },
					"S-Etukortti keepalive failed: still logged out after the relogin",
				);
				return;
			}
			keepalive = { at: at(), ok: true, outcome: "recovered" };
			logger.info("S-Etukortti keepalive recovered the app session via relogin");
		} catch (err) {
			// Same predicate as the gate: while a human login is active (holding
			// the lease, verifying its landing or queued for the lease) the tick
			// waits for the next one. A lease timeout or denial without one fails.
			if (
				err instanceof SessionExpiredError &&
				err.reason === "login_in_progress" &&
				(await flow.humanLoginActive())
			) {
				// Navigating now could reset the human's IdP step; the next tick retries.
				keepalive = { at: at(), ok: true, outcome: "skipped" };
				logger.info("S-Etukortti keepalive skipped: a human login is in progress");
				return;
			}
			const error = err instanceof Error ? err.message : String(err);
			keepalive = { at: at(), ok: false, outcome: "failed", error };
			logger.warn({ err }, "S-Etukortti keepalive failed");
		}
	}

	return {
		get(path, params, schema) {
			return withAppSession((token) => apiAttempt(path, params, schema, token));
		},

		capture,

		probe,

		login: flow.steps,

		runSilentIdpFlow,

		report() {
			return {
				keepalive,
				autoRelogin: {
					lastAttemptAt: lastAttempt ? new Date(lastAttempt.at).toISOString() : null,
					lastOutcome: lastAttempt?.outcome ?? null,
					blockedReason: store.getReloginBlock(),
				},
				appSession: {
					hasToken: cell.token !== null,
					tokenGeneration: cell.generation,
					keepaliveArmed: cancelKeepalive !== null,
				},
				idpLease: lease.report(),
			};
		},

		async close() {
			cancelKeepalive?.();
			cancelKeepalive = null;
			cell.token = null;
			await site.close();
		},
	};
}
