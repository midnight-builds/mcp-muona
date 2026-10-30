// The S-Etukortti login as phase logic over IdP screens. Human logins are
// driven step by step from MCP tools, the CLI and the remote screen; the
// relogin's silent login runs the same flow and, when it reaches a human step,
// hands its open page over instead of throwing the emailed code away. OTP,
// captcha and strong auth are never automated: the code only feeds in what a
// human typed.

import { logger } from "../../logger.ts";
import type { LoginKind } from "../../store/login-history.ts";
import { SessionExpiredError } from "./errors.ts";
import type { IdpLease } from "./lease.ts";
import {
	type Cancel,
	type Clock,
	type IdpDriver,
	type IdpScreen,
	type LoginPhase,
	PHASES_NEEDING_HUMAN,
	type SessionStore,
} from "./ports.ts";

export type LoginState = {
	phase: LoginPhase;
	email?: string;
	error?: string;
	captchaImageBase64?: string;
	strongAuthMethods?: string[];
	pageInfo?: string;
	// Set while start() is still opening the page or submitting the email
	// (phase idle): the login exists, its next step is not known yet.
	starting?: boolean;
};

export type StartOptions = { restart?: boolean };

export interface LoginSteps {
	// While a relogin is in flight this waits for it and returns logged_in if
	// it succeeded (no new one-time code). While a human login is active it
	// returns that login's state, unless restart is set.
	start(email: string, opts?: StartOptions): Promise<LoginState>;
	submitCaptcha(text: string): Promise<LoginState>;
	submitOtp(code: string): Promise<LoginState>;
	chooseStrongAuthMethod(method: string): Promise<LoginState>;
	fillStrongAuthPhone(phoneNumber: string): Promise<LoginState>;
	// Clamped to 30–300 s (default 180). A timeout leaves the login pending.
	waitForStrongAuthCompletion(timeoutSeconds?: number): Promise<LoginState>;
	// Ends a human login; never touches a silent relogin in flight.
	cancel(): Promise<LoginState>;
	state(): Promise<LoginState>;
	// For the remote login screen: while the human works on it nothing else
	// reaches the login, so this keeps the stale reaper off a strong-auth login.
	holdForRemoteScreen(): Promise<LoginPhase>;
	bringToFront(): Promise<boolean>;
}

export type SilentLoginResult = { phase: LoginPhase; error?: string };

export type LoginFlow = {
	steps: LoginSteps;
	// Runs under the exclusive IdP lease. Ends logged_in, failed, or in the
	// human step it was handed over at.
	silentLogin(email: string): Promise<SilentLoginResult>;
	humanLoginActive(): Promise<boolean>;
};

export type LoginFlowDeps = {
	idp: IdpDriver;
	store: SessionStore;
	clock: Clock;
	lease: IdpLease;
	// Confirms a landing through a fresh app-session token; never relogins.
	verifyLanded(): Promise<{ loggedIn: true } | { loggedIn: false; reason: string }>;
	reloginInFlight(): Promise<void> | null;
	// Called on every completed login, so the relogin gate can tell that a
	// failed relogin before it no longer says anything about the session.
	// by: the relogin's own silent login, or a login driven through the steps.
	loginCompleted(by: CompletedBy): void;
};

export type CompletedBy = "silent_login" | "login_steps";

export const STALE_LOGIN_MS = 10 * 60 * 1000;
const MIN_STRONG_AUTH_WAIT_SECONDS = 30;
const MAX_STRONG_AUTH_WAIT_SECONDS = 300;
const DEFAULT_STRONG_AUTH_WAIT_SECONDS = 180;

function clampStrongAuthWaitSeconds(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_STRONG_AUTH_WAIT_SECONDS;
	return Math.min(MAX_STRONG_AUTH_WAIT_SECONDS, Math.max(MIN_STRONG_AUTH_WAIT_SECONDS, seconds));
}

type Attempt = LoginState & {
	// Results of a step that outlived its attempt (cancel, restart, reap) are dropped.
	id: number;
	// Allows exactly one retype of a mistyped OTP before giving up.
	otpAttempts: number;
	// The login went through the IdP (submitted the email). One that landed
	// straight from a still-valid app session proves nothing about the SSO.
	viaIdp?: boolean;
	touchedAt: number | null;
};

const CLEARED = {
	error: undefined,
	captchaImageBase64: undefined,
	strongAuthMethods: undefined,
	pageInfo: undefined,
} as const;

type HumanStepScreen = Extract<IdpScreen, { kind: "otp" | "captcha" | "strong_auth" }>;

function isHumanStep(screen: IdpScreen): screen is HumanStepScreen {
	return screen.kind === "otp" || screen.kind === "captcha" || screen.kind === "strong_auth";
}

export function createLoginFlow(deps: LoginFlowDeps): LoginFlow {
	const { idp, store, clock, lease } = deps;
	let nextId = 1;
	let state: Attempt = { id: 0, phase: "idle", otpAttempts: 0, touchedAt: null };
	let cancelReaper: Cancel | null = null;
	let stepsInFlight = 0;
	// The human attempt that owns, or is still acquiring, the IdP lease. Kept
	// apart from the lease itself: an attempt waiting in the lease drain or
	// verifying its landing must still count as the active login, so cancel,
	// a second start and the relogin gate all see it.
	let humanAttemptId: number | null = null;
	// The exclusive IdP lease grant the human login holds, and the attempt it
	// belongs to. Only this grant is ever released for a human login: a start
	// that gave up while waiting frees its own grant, never a newer start's.
	let humanLease: { id: number; release: () => void } | null = null;
	// A landed human login verifying itself; nothing may discard it meanwhile.
	let landing: Promise<void> | null = null;

	const humanActive = () => humanAttemptId !== null;
	// May this attempt drive the login page right now?
	const drives = (id: number) =>
		humanAttemptId === id &&
		state.id === id &&
		humanLease?.id === id &&
		lease.holder() === "human_login";

	function snapshot(): LoginState {
		return {
			phase: state.phase,
			email: state.email,
			error: state.error,
			captchaImageBase64: state.captchaImageBase64,
			strongAuthMethods: state.strongAuthMethods,
			pageInfo: state.pageInfo,
			starting: state.starting,
		};
	}

	function fresh(partial: Partial<Attempt>): void {
		const previous = state.phase;
		state = { id: nextId++, phase: "idle", otpAttempts: 0, touchedAt: null, ...partial };
		stopReaper();
		if (state.phase !== previous) {
			logger.info({ from: previous, to: state.phase }, "S-Etukortti login phase changed");
		}
	}

	function update(id: number, partial: Partial<Attempt>): boolean {
		if (id !== state.id) return false;
		const previous = state.phase;
		state = { ...state, ...partial };
		if (state.phase !== previous) {
			logger.info(
				{ from: previous, to: state.phase, email: state.email },
				"S-Etukortti login phase changed",
			);
		}
		return true;
	}

	function stopReaper(): void {
		cancelReaper?.();
		cancelReaper = null;
	}

	function armReaper(ms: number): void {
		stopReaper();
		cancelReaper = clock.after(ms, () => reapIfStale());
	}

	// Restarts the 10 minutes. A timer rather than a check on the next call, so
	// a forgotten login frees the IdP lease even if nobody calls in again.
	function touch(id: number): void {
		if (id !== state.id) return;
		state.touchedAt = clock.now();
		armReaper(STALE_LOGIN_MS);
	}

	function releaseHumanLease(): void {
		const held = humanLease;
		humanLease = null;
		held?.release();
	}

	async function releaseHumanPage(): Promise<void> {
		humanAttemptId = null;
		// close() takes the page synchronously, so a login opened right after
		// the release never has its new page closed by this one.
		const closing = idp.close();
		releaseHumanLease();
		await closing;
	}

	// A login left sitting (agent forgot about it, human wandered off) is
	// discarded rather than holding a browser tab and the IdP lease forever.
	async function reapIfStale(): Promise<void> {
		if (!PHASES_NEEDING_HUMAN.includes(state.phase) || state.touchedAt === null) return;
		if (stepsInFlight > 0) {
			// A step waiting on the IdP is not abandoned; it touches the login when done.
			touch(state.id);
			return;
		}
		const idleMs = clock.now() - state.touchedAt;
		if (idleMs < STALE_LOGIN_MS) {
			// Timers can fire a little before the clock reaches their deadline;
			// without a new timer such a login would never be reaped.
			armReaper(STALE_LOGIN_MS - idleMs);
			return;
		}
		logger.info(
			{ phase: state.phase, idleMinutes: Math.round(idleMs / 60_000) },
			"Discarding stale S-Etukortti login attempt",
		);
		const ownsPage = humanActive();
		fresh({
			error: "Previous login attempt expired after 10 minutes of inactivity; start over.",
		});
		if (ownsPage) await releaseHumanPage();
	}

	function recordLifetime(kind: LoginKind): void {
		const before = store.recordLogin(kind, clock.now());
		logger.info(
			{
				kind,
				previousHumanLoginHoursAgo: before?.hoursSinceHumanLogin ?? null,
				previousSilentLoginHoursAgo: before?.hoursSinceSilentLogin ?? null,
			},
			kind === "human"
				? "S-Etukortti login completed by a human (SSO had expired)"
				: "S-Etukortti login completed silently (SSO session still alive)",
		);
	}

	function complete(id: number, kind: LoginKind, by: CompletedBy): void {
		if (!update(id, { phase: "logged_in", ...CLEARED })) return;
		stopReaper();
		recordCompletion(state.viaIdp === true, kind, by);
	}

	function recordCompletion(viaIdp: boolean, kind: LoginKind, by: CompletedBy): void {
		deps.loginCompleted(by);
		if (!viaIdp) {
			// The block means the SSO is dead; clearing it on an app-session
			// landing re-armed the automatic flows and mailed another code.
			if (store.getReloginBlock() !== null) {
				logger.warn(
					"S-Etukortti login landed without visiting the IdP while the relogin block is set; " +
						"block kept, nothing recorded",
				);
			} else {
				logger.info("S-Etukortti login landed on a still-valid app session; nothing recorded");
			}
			return;
		}
		store.clearReloginBlock();
		recordLifetime(kind);
	}

	async function terminate(id: number, error: string): Promise<void> {
		if (!update(id, { phase: "failed", ...CLEARED, error })) return;
		stopReaper();
		await releaseHumanPage();
	}

	async function fail(id: number, err: unknown): Promise<void> {
		if (id !== state.id) return;
		const message = err instanceof Error ? err.message : String(err);
		logger.error({ err, phase: state.phase }, "S-Etukortti login step failed");
		await terminate(id, message);
	}

	function enterHumanStep(id: number, screen: HumanStepScreen): void {
		if (screen.kind === "otp") {
			update(id, { phase: "awaiting_otp", ...CLEARED });
		} else if (screen.kind === "captcha") {
			update(id, {
				phase: "awaiting_captcha",
				...CLEARED,
				captchaImageBase64: screen.imageBase64,
			});
		} else {
			update(id, {
				phase: "awaiting_strong_auth",
				...CLEARED,
				strongAuthMethods: screen.methods,
				pageInfo: screen.pageInfo,
			});
		}
		touch(id);
	}

	// The IdP let the login through. A login straight from a human step means
	// OTP/strong auth was needed; anything else rode the still-valid SSO session.
	async function land(id: number): Promise<void> {
		if (id !== state.id) return;
		const kind: LoginKind = PHASES_NEEDING_HUMAN.includes(state.phase) ? "human" : "silent_sso";
		// The IdP is done with, so the page and lease go (verifying may need a
		// page navigation), but the attempt stays active until verified: a
		// cancel or start in between must not throw away a completed login.
		const closing = idp.close();
		releaseHumanLease();
		const verified = (async () => {
			try {
				await closing;
				const status = await deps.verifyLanded();
				if (status.loggedIn) {
					complete(id, kind, "login_steps");
				} else {
					logger.warn({ reason: status.reason }, "S-Etukortti login landed but did not verify");
					update(id, { phase: "failed", ...CLEARED, error: status.reason });
				}
			} catch (err) {
				// start() and cancel() wait on this landing: they must get the
				// failed state, not the raw error.
				logger.error({ err }, "S-Etukortti login landed but its verification threw");
				const message = err instanceof Error ? err.message : String(err);
				update(id, { phase: "failed", ...CLEARED, error: message });
			}
		})();
		landing = verified;
		try {
			await verified;
		} finally {
			landing = null;
			if (humanAttemptId === id) humanAttemptId = null;
		}
	}

	async function apply(id: number, screen: IdpScreen): Promise<void> {
		if (id !== state.id) return;
		switch (screen.kind) {
			case "returned_to_app":
				await land(id);
				return;
			case "otp":
			case "captcha":
			case "strong_auth":
				enterHumanStep(id, screen);
				return;
			case "otp_rejected": {
				const attempts = state.otpAttempts + 1;
				if (attempts >= 2) {
					update(id, { otpAttempts: attempts });
					await terminate(id, `Code rejected: ${screen.snapshot}`);
					return;
				}
				logger.info("S-Etukortti one-time code rejected; one retype allowed");
				update(id, {
					otpAttempts: attempts,
					phase: "awaiting_otp",
					error: `Code may be incorrect, you can retry once: ${screen.snapshot}`,
				});
				touch(id);
				return;
			}
			case "email_form":
				await terminate(id, "The login page asked for the email address again.");
				return;
			case "unexpected":
				await terminate(id, screen.snapshot);
				return;
		}
	}

	async function step(
		phase: LoginPhase,
		guardError: string,
		run: (id: number) => Promise<void>,
	): Promise<LoginState> {
		await reapIfStale();
		if (state.phase !== phase || !drives(state.id)) {
			return { phase: state.phase, email: state.email, error: guardError };
		}
		const id = state.id;
		stepsInFlight++;
		try {
			await run(id);
		} catch (err) {
			await fail(id, err);
		} finally {
			stepsInFlight--;
		}
		return snapshot();
	}

	async function start(email: string, opts?: StartOptions): Promise<LoginState> {
		await reapIfStale();
		const relogin = deps.reloginInFlight();
		if (relogin) {
			logger.info("S-Etukortti login start waiting for the relogin in flight");
			const succeeded = await relogin.then(
				() => true,
				() => false,
			);
			if (succeeded) {
				logger.info("Relogin in flight succeeded; login start needs no new one-time code");
				return snapshot();
			}
		}

		if (landing) {
			logger.info("S-Etukortti login start waiting for the landed login to verify");
			await landing;
			return snapshot();
		}

		const restarting = humanActive();
		if (restarting) {
			// A start still in the lease drain or opening its page has nothing to
			// restart yet, and restarting it would navigate during the drain.
			if (!opts?.restart || state.starting || !drives(state.id)) {
				logger.info(
					{ phase: state.phase, starting: state.starting ?? false },
					"S-Etukortti login already in progress; returning its state",
				);
				return snapshot();
			}
			logger.info({ phase: state.phase }, "S-Etukortti login restarted on request");
		}

		// The attempt exists before the lease wait, so a cancel or a second
		// start during the wait sees it.
		fresh({ email, starting: true });
		const id = state.id;
		humanAttemptId = id;
		if (restarting) {
			// The new attempt takes over the old one's grant, so a cancel while
			// the old page closes releases it.
			if (humanLease) humanLease = { id, release: humanLease.release };
			// The new attempt id already drops whatever the old page's step returns.
			await idp.close();
			if (!drives(id)) {
				logger.info(
					"S-Etukortti login restart abandoned: cancelled while the old page was closing",
				);
				return snapshot();
			}
		} else {
			let release: () => void;
			try {
				release = await lease.acquireExclusive("human_login");
			} catch (err) {
				if (humanAttemptId === id) {
					humanAttemptId = null;
					update(id, { starting: undefined });
				}
				throw err;
			}
			if (humanAttemptId !== id || state.id !== id) {
				// Cancelled while waiting: give this grant straight back, open nothing.
				logger.info(
					{ cancelled: humanAttemptId !== id },
					"S-Etukortti login start abandoned: cancelled or superseded while waiting for the IdP lease",
				);
				// Superseded (a silent login took over the login state) but still
				// marked active: left set, every relogin and silent flow would be
				// declined as login_in_progress forever.
				if (humanAttemptId === id) humanAttemptId = null;
				release();
				return snapshot();
			}
			humanLease = { id, release };
		}
		logger.info({ email, restart: opts?.restart ?? false }, "S-Etukortti login started");
		// Best-effort: a failed write only disables future relogins.
		store.saveEmail(email);

		// While blocked the SSO session is known dead: a still-valid app
		// session must not let this login skip the IdP and clear the block.
		const forceIdp = store.getReloginBlock() !== null;
		if (forceIdp) logger.info("Relogin block set: S-Etukortti login forced through the IdP");

		stepsInFlight++;
		try {
			let screen = await idp.open({ forceIdp });
			if (screen.kind === "returned_to_app" && screen.viaIdp) update(id, { viaIdp: true });
			if (screen.kind === "email_form" && drives(id)) {
				update(id, { viaIdp: true });
				screen = await idp.submitEmail(email);
				logger.info({ email }, "S-Etukortti login email submitted");
			}
			update(id, { starting: undefined });
			await apply(id, screen);
		} catch (err) {
			update(id, { starting: undefined });
			await fail(id, err);
		} finally {
			stepsInFlight--;
		}
		return snapshot();
	}

	async function silentLogin(email: string): Promise<SilentLoginResult> {
		const release = await lease.acquireExclusive("silent_relogin");
		// A silent flow we queued behind (S-ostoslista) may have just stopped at
		// a human step; driving the IdP now would mail a second one-time code.
		const blocked = store.getReloginBlock();
		if (blocked) {
			release();
			logger.info("Relogin declined after the IdP lease wait: the relogin block was set meanwhile");
			throw new SessionExpiredError("blocked", `Relogin blocked until a human login: ${blocked}`);
		}
		let ownsLease = true;
		const releaseSilent = async () => {
			ownsLease = false;
			const closing = idp.close();
			release();
			await closing;
		};
		try {
			let screen = await idp.open();
			const viaIdp =
				screen.kind === "email_form" ||
				(screen.kind === "returned_to_app" && screen.viaIdp === true);
			if (screen.kind === "email_form") {
				screen = await idp.submitEmail(email);
				logger.info({ email }, "Relogin submitted the saved email");
			}

			if (screen.kind === "returned_to_app") {
				await releaseSilent();
				const status = await deps.verifyLanded();
				if (!status.loggedIn) return { phase: "failed", error: status.reason };
				if (humanActive()) {
					// A human start took the lease once we let it go. Replacing its
					// attempt here would leave it driving a login nobody tracks; it
					// lands on the now-valid app session by itself.
					logger.info(
						{ phase: state.phase },
						"Relogin succeeded while a human login started; its attempt is left alone",
					);
					recordCompletion(viaIdp, "silent_sso", "silent_login");
				} else {
					fresh({ email, viaIdp });
					complete(state.id, "silent_sso", "silent_login");
				}
				return { phase: "logged_in" };
			}

			if (isHumanStep(screen)) {
				// The one-time code (if any) is already in the user's inbox; keeping
				// the page lets a human finish with it instead of mailing another.
				lease.transfer("silent_relogin", "human_login");
				ownsLease = false;
				fresh({ email, viaIdp: true });
				humanAttemptId = state.id;
				humanLease = { id: state.id, release };
				enterHumanStep(state.id, screen);
				logger.warn(
					{ phase: state.phase, email },
					"Relogin stopped at a human step; its login page is handed over to a human login",
				);
				return { phase: state.phase };
			}

			const error =
				screen.kind === "email_form"
					? "The login page asked for the email address again."
					: screen.snapshot;
			return { phase: "failed", error };
		} finally {
			if (ownsLease) await releaseSilent();
		}
	}

	const steps: LoginSteps = {
		start,

		submitCaptcha: (text) =>
			step(
				"awaiting_captcha",
				"No captcha challenge is pending. Call s_etukortti_login_start first.",
				async (id) => apply(id, await idp.submitCaptcha(text)),
			),

		submitOtp: (code) =>
			step(
				"awaiting_otp",
				"No one-time code is pending. Call s_etukortti_login_start first.",
				async (id) => apply(id, await idp.submitOtp(code)),
			),

		chooseStrongAuthMethod: (method) =>
			step(
				"awaiting_strong_auth",
				"No strong-authentication method selection is pending. Call s_etukortti_login_start first.",
				async (id) => {
					const pageInfo = await idp.chooseStrongAuthMethod(method);
					logger.info({ method }, "S-Etukortti strong-authentication method chosen");
					update(id, { error: undefined, pageInfo });
					touch(id);
				},
			),

		fillStrongAuthPhone: (phoneNumber) =>
			step(
				"awaiting_strong_auth",
				"No strong-authentication phone number step is pending. Call s_etukortti_login_start first.",
				async (id) => {
					const pageInfo = await idp.fillStrongAuthPhone(phoneNumber);
					logger.info("S-Etukortti strong-authentication phone number submitted");
					update(id, { error: undefined, pageInfo });
					touch(id);
				},
			),

		waitForStrongAuthCompletion: (timeoutSeconds) =>
			step(
				"awaiting_strong_auth",
				"No strong-authentication approval is pending. Call s_etukortti_login_start first.",
				async (id) => {
					const seconds = clampStrongAuthWaitSeconds(timeoutSeconds);
					const progress = await idp.waitForReturn(seconds * 1_000);
					if (progress.kind === "returned_to_app") {
						await land(id);
						return;
					}
					// Not approved yet: stay pending so the agent can just wait again.
					logger.info({ seconds }, "S-Etukortti strong authentication not completed yet");
					update(id, {
						error: "Strong authentication not completed yet",
						pageInfo: progress.pageInfo,
					});
					touch(id);
				},
			),

		async cancel() {
			if (landing) {
				logger.info("S-Etukortti login cancel ignored: the login already landed and is verifying");
				await landing;
				return snapshot();
			}
			if (humanActive()) {
				logger.info(
					{ phase: state.phase, starting: state.starting ?? false },
					"S-Etukortti login cancelled",
				);
				const ownsPage = humanLease !== null;
				fresh({});
				// A start still waiting for the lease gives it back itself.
				if (ownsPage) await releaseHumanPage();
				else humanAttemptId = null;
			} else {
				if (lease.holder() !== null) {
					logger.info(
						{ holder: lease.holder() },
						"S-Etukortti login cancel: no human login; the running silent login is left alone",
					);
				}
				fresh({});
			}
			return snapshot();
		},

		async state() {
			await reapIfStale();
			return snapshot();
		},

		async holdForRemoteScreen() {
			await reapIfStale();
			if (state.phase === "awaiting_strong_auth" && drives(state.id)) touch(state.id);
			return state.phase;
		},

		async bringToFront() {
			if (!drives(state.id)) return false;
			return idp.bringToFront();
		},
	};

	return {
		steps,
		silentLogin,
		async humanLoginActive() {
			await reapIfStale();
			return humanActive();
		},
	};
}
