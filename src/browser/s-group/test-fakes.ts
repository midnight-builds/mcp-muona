// Scripted fakes shared by the S-group session tests: no Playwright, no network.

import { afterEach, beforeEach, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSettingsDb, setSetting } from "../../store/settings.ts";
import { SessionExpiredError, type SessionExpiredReason } from "./errors.ts";
import type {
	ApiObservation,
	CallbackExchange,
	CallbackFlowObservation,
	CallbackFlowTarget,
	Cancel,
	Clock,
	CsrfObservation,
	IdpDriver,
	IdpScreen,
	PageObservation,
	SessionStore,
	SiteDriver,
	StrongAuthProgress,
} from "./ports.ts";
import { createSGroupSession, type SGroupSession } from "./session.ts";
import { SAVED_EMAIL_SETTING_KEY, settingsSessionStore } from "./store.ts";

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const START = Date.parse("2026-10-29T05:00:00Z");
export const EMAIL = "user@example.com";

type Timer = { id: number; at: number; interval: number | null; fn: () => Promise<void> | void };

export class ManualClock implements Clock {
	private t: number;
	private timers: Timer[] = [];
	private nextId = 1;
	private earlyBy = 0;

	constructor(start: number) {
		this.t = start;
	}

	now(): number {
		return this.t;
	}

	every(ms: number, fn: () => Promise<void> | void): Cancel {
		return this.add(ms, ms, fn);
	}

	after(ms: number, fn: () => Promise<void> | void): Cancel {
		return this.add(ms, null, fn);
	}

	pending(): number {
		return this.timers.length;
	}

	// Real timers may fire a little before Date.now() reaches their due time;
	// the next timer that comes due runs this much early, once.
	fireNextEarlyBy(ms: number): void {
		this.earlyBy = ms;
	}

	// Runs every timer that comes due, awaiting each callback so a test can
	// assert on what the tick did right after advancing.
	async advance(ms: number): Promise<void> {
		const target = this.t + ms;
		for (;;) {
			const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.t = due.at - this.earlyBy;
			this.earlyBy = 0;
			if (due.interval === null) {
				this.timers = this.timers.filter((timer) => timer.id !== due.id);
			} else {
				due.at += due.interval;
			}
			await due.fn();
		}
		this.t = target;
	}

	private add(ms: number, interval: number | null, fn: () => Promise<void> | void): Cancel {
		const id = this.nextId++;
		this.timers.push({ id, at: this.t + ms, interval, fn });
		return () => {
			this.timers = this.timers.filter((timer) => timer.id !== id);
		};
	}
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function ticks(n = 5): Promise<void> {
	for (let i = 0; i < n; i++) await tick();
}

// A scripted s-etukortti.fi: one app session that is alive or not, and the
// CSRF token it last handed out. Auth is judged when a request is made, so a
// held request answers for the moment it was sent.
export class FakeSite implements SiteDriver {
	alive = true;
	// Simulates a site that hands out tokens yet rejects every API call.
	rejectAllApiCalls = false;
	fastPathThrows = false;
	fastPathError: Error | null = null;
	apiStatus: number | null = null;
	apiBody: unknown = { value: "ok" };
	validToken: string | null = null;
	csrfFetches = 0;
	csrfSniffs = 0;
	apiCalls: { path: string; token: string }[] = [];
	holds = new Map<string, Promise<void>>();
	closed = 0;
	private issued = 0;
	private closeListeners: (() => void)[] = [];

	// Holds the fast-path CSRF fetch; like a real request, its answer reflects
	// the app session as it was when the request was sent.
	csrfHold: Promise<void> | null = null;

	async fetchCsrfToken(): Promise<CsrfObservation> {
		this.csrfFetches++;
		const aliveWhenSent = this.alive;
		await tick();
		if (this.csrfHold) await this.csrfHold;
		if (this.fastPathError) throw this.fastPathError;
		if (this.fastPathThrows) throw new Error("fetch failed");
		if (!aliveWhenSent) return { kind: "logged_out", detail: "CSRF endpoint returned HTTP 401." };
		return this.issue();
	}

	async sniffCsrfToken(): Promise<CsrfObservation> {
		this.csrfSniffs++;
		await tick();
		return this.issue();
	}

	async apiGet(
		path: string,
		_params: Record<string, string>,
		token: string,
	): Promise<ApiObservation> {
		this.apiCalls.push({ path, token });
		const authorized = this.alive && !this.rejectAllApiCalls && token === this.validToken;
		await tick();
		const hold = this.holds.get(path);
		if (hold) await hold;
		if (this.apiStatus !== null) return { kind: "http_error", status: this.apiStatus };
		if (!authorized) return { kind: "unauthorized", status: 401 };
		return { kind: "ok", body: this.apiBody };
	}

	// The page fires these responses in order; the first one the matcher accepts
	// is the captured body, like the real page's own traffic.
	pageResponses: string[] = ["https://api.example/other", "https://api.example/list?limit=1"];
	pageBody: unknown = { items: [1] };
	pageError: Error | null = null;
	pageCaptures: { url: string; timeoutMs: number | undefined }[] = [];
	pageHold: Promise<void> | null = null;

	async capturePage(
		url: string,
		match: (responseUrl: string) => boolean,
		timeoutMs?: number,
	): Promise<PageObservation> {
		this.pageCaptures.push({ url, timeoutMs });
		const aliveWhenLoaded = this.alive && !this.rejectAllApiCalls;
		await tick();
		if (this.pageHold) await this.pageHold;
		if (this.pageError) throw this.pageError;
		if (!aliveWhenLoaded) {
			return { kind: "logged_out", detail: "Redirected to tunnistus.s-ryhma.fi." };
		}
		if (!this.pageResponses.some(match)) throw new Error("page loaded but the response never came");
		return { kind: "ok", body: this.pageBody };
	}

	onContextClosed(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	emitContextClosed(): void {
		for (const listener of this.closeListeners) listener();
	}

	async close(): Promise<void> {
		this.closed++;
	}

	expire(): void {
		this.alive = false;
		this.validToken = null;
	}

	private issue(): CsrfObservation {
		if (!this.alive) return { kind: "logged_out", detail: "CSRF endpoint returned HTTP 401." };
		this.issued++;
		this.validToken = `t${this.issued}`;
		return { kind: "token", token: this.validToken };
	}
}

export const STRONG_AUTH_METHODS = ["Mobiilivarmenne", "S-Pankki", "Nordea"];

// A scripted tunnistus.s-ryhma.fi. Landing back on the app revives the fake
// site's app session, like a real completed login does.
export class FakeIdp implements IdpDriver {
	// What the IdP shows after the email. sso_alive: the S-tunnus SSO session
	// is still valid and the login completes silently.
	afterEmail: "sso_alive" | "otp" | "captcha" | "strong_auth" | "unexpected" | "throw" =
		"sso_alive";
	afterOtp: "app" | "strong_auth" = "app";
	correctCaptcha = "ABCD";
	correctOtp = "123456";
	strongAuthApproved = false;
	stepThrows: Error | null = null;
	// false: the IdP lands back on the app but the app session stays dead.
	landingRevivesSite = true;
	// Held inside submitEmail, i.e. while the IdP is being driven.
	hold: Promise<void> | null = null;
	// Held inside close(), after the page is already taken (like the adapter).
	closeHold: Promise<void> | null = null;

	opens = 0;
	emails: string[] = [];
	otpEmails = 0;
	closes = 0;
	fronted = 0;
	pageOpen = false;
	waits: number[] = [];
	// A page opened while another flow's page is still open: two flows driving
	// the IdP at once.
	overlaps = 0;
	// Where a callback flow (S-ostoslista) lands once the IdP lets it through.
	callbackUrl = "https://kirjautuminen.s-ostoslista.fi/callback?response=ok&nonce=n1";
	callbackFlows: string[] = [];
	// Opens asked to go through the IdP whatever the app session says; the
	// real adapter drops the s-etukortti.fi cookies for that.
	forcedOpens = 0;
	// false: a broken adapter that lands on the app despite the force.
	honoursForceIdp = true;
	// A one-time code accepted by the IdP starts a new S-tunnus SSO session,
	// after which every flow's email submit completes silently.
	humanLoginRevivesSso = false;
	// The callback flow stays on the IdP after the email with no screen the
	// adapter recognises.
	callbackFlowStuck = false;
	// An alive SSO session can answer /login's authorize request itself and
	// bounce straight back to the app before any email form is shown.
	ssoBouncesWithoutEmailForm = false;
	// The open page belongs to this callback flow: finishing a human step on it
	// lands on the target's callback, not on the app.
	pageTarget: CallbackFlowTarget | null = null;

	constructor(private site: FakeSite) {}

	async open(opts?: { forceIdp?: boolean }): Promise<IdpScreen> {
		if (this.pageOpen) this.overlaps++;
		this.opens++;
		this.pageOpen = true;
		this.pageTarget = null;
		if (opts?.forceIdp) {
			this.forcedOpens++;
			if (this.honoursForceIdp) this.site.expire();
		}
		await tick();
		if (this.site.alive) return { kind: "returned_to_app", viaIdp: false };
		if (this.ssoBouncesWithoutEmailForm && this.afterEmail === "sso_alive") {
			this.site.alive = true;
			return { kind: "returned_to_app", viaIdp: true };
		}
		return { kind: "email_form" };
	}

	async submitEmail(email: string): Promise<IdpScreen> {
		this.requireOpen();
		this.emails.push(email);
		await tick();
		if (this.hold) await this.hold;
		switch (this.afterEmail) {
			case "sso_alive":
				return this.land();
			case "otp":
				this.otpEmails++;
				return { kind: "otp" };
			case "captcha":
				return { kind: "captcha", imageBase64: "Y2FwdGNoYQ==" };
			case "strong_auth":
				return this.strongAuth();
			case "unexpected":
				return { kind: "unexpected", snapshot: "main: Jotain meni pieleen" };
			case "throw":
				throw new Error("browser crashed");
		}
	}

	// Another service's OIDC flow through the same IdP: it shares the SSO
	// session (afterEmail) but never touches the S-Etukortti app session.
	async runCallbackFlow(
		target: CallbackFlowTarget,
		email: string,
	): Promise<CallbackFlowObservation> {
		if (this.pageOpen) this.overlaps++;
		this.opens++;
		this.pageOpen = true;
		this.pageTarget = target;
		this.callbackFlows.push(target.startUrl);
		await tick();
		this.emails.push(email);
		if (this.hold) await this.hold;
		const where = "tunnistus.s-ryhma.fi/login";
		if (this.callbackFlowStuck) {
			return {
				kind: "failed",
				reason: "unexpected_idp_page",
				detail: `Stuck on ${where} without a recognised login step.`,
			};
		}
		switch (this.afterEmail) {
			case "sso_alive":
				if (!target.isCallback(this.callbackUrl)) {
					return { kind: "failed", reason: "timeout", detail: "No callback was reached." };
				}
				return { kind: "callback", url: this.callbackUrl };
			case "otp":
				this.otpEmails++;
				return { kind: "human_step", screen: { kind: "otp" }, where };
			case "captcha":
				return {
					kind: "human_step",
					screen: { kind: "captcha", imageBase64: "Y2FwdGNoYQ==" },
					where,
				};
			case "strong_auth":
				return { kind: "human_step", screen: this.strongAuth(), where };
			case "unexpected":
				return { kind: "failed", reason: "unexpected_idp_page", detail: `Stuck on ${where}` };
			case "throw":
				throw new Error("browser crashed");
		}
	}

	async submitCaptcha(text: string): Promise<IdpScreen> {
		this.requireOpen();
		await tick();
		if (this.stepThrows) throw this.stepThrows;
		if (text !== this.correctCaptcha) return { kind: "captcha", imageBase64: "bmV3IGNhcHRjaGE=" };
		this.otpEmails++;
		return { kind: "otp" };
	}

	async submitOtp(code: string): Promise<IdpScreen> {
		this.requireOpen();
		await tick();
		if (this.stepThrows) throw this.stepThrows;
		if (code !== this.correctOtp)
			return { kind: "otp_rejected", snapshot: "Koodi on virheellinen" };
		if (this.humanLoginRevivesSso) this.afterEmail = "sso_alive";
		if (this.afterOtp === "strong_auth") return this.strongAuth();
		return this.land();
	}

	async chooseStrongAuthMethod(method: string): Promise<string> {
		this.requireOpen();
		await tick();
		if (!STRONG_AUTH_METHODS.includes(method)) {
			throw new Error(`No strong-authentication method named "${method}" was found on the page`);
		}
		return `provider page for ${method}`;
	}

	async fillStrongAuthPhone(phoneNumber: string): Promise<string> {
		this.requireOpen();
		await tick();
		return `verification code shown for ${phoneNumber}`;
	}

	async waitForReturn(timeoutMs: number): Promise<StrongAuthProgress> {
		this.requireOpen();
		this.waits.push(timeoutMs);
		await tick();
		if (!this.strongAuthApproved) return { kind: "pending", pageInfo: "waiting for approval" };
		return this.land();
	}

	async close(): Promise<void> {
		if (this.pageOpen) this.closes++;
		this.pageOpen = false;
		this.pageTarget = null;
		if (this.closeHold) await this.closeHold;
	}

	async bringToFront(): Promise<boolean> {
		if (!this.pageOpen) return false;
		this.fronted++;
		return true;
	}

	private land(): { kind: "returned_to_app" } | { kind: "callback"; url: string } {
		// The IdP sends the human back to whichever service started the flow.
		if (this.pageTarget) return { kind: "callback", url: this.callbackUrl };
		if (this.landingRevivesSite) this.site.alive = true;
		return { kind: "returned_to_app" };
	}

	private strongAuth(): Extract<IdpScreen, { kind: "strong_auth" }> {
		return {
			kind: "strong_auth",
			methods: STRONG_AUTH_METHODS,
			pageInfo: 'heading "Tunnistaudu pankkitunnuksillasi"',
		};
	}

	private requireOpen(): void {
		if (!this.pageOpen) throw new Error("login page is closed");
	}
}

export type Harness = { site: FakeSite; idp: FakeIdp; clock: ManualClock; session: SGroupSession };

export function harness(opts?: {
	keepaliveHours?: number;
	// Wraps the real store, e.g. to act at the moment a login is recorded.
	store?: (site: FakeSite) => SessionStore;
}): Harness {
	const site = new FakeSite();
	const idp = new FakeIdp(site);
	const clock = new ManualClock(START);
	const session = createSGroupSession(
		{ site, idp, clock, store: opts?.store?.(site) ?? settingsSessionStore },
		{ keepaliveHours: opts?.keepaliveHours ?? 6 },
	);
	return { site, idp, clock, session };
}

export async function expectExpired(
	promise: Promise<unknown>,
	reason: SessionExpiredReason,
): Promise<void> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(SessionExpiredError);
	if (err instanceof SessionExpiredError) expect(err.reason).toBe(reason);
}

// A fresh temp settings DB per test, with a saved login email so relogins are
// possible unless a test says otherwise.
export function useTempSettingsDb(): void {
	let dbPath = "";
	beforeEach(() => {
		dbPath = join(tmpdir(), `muona-sgroup-test-${randomUUID()}.sqlite`);
		process.env.MUONA_DB_PATH = dbPath;
		setSetting(SAVED_EMAIL_SETTING_KEY, EMAIL);
	});

	afterEach(() => {
		closeSettingsDb();
		for (const suffix of ["", "-wal", "-shm"]) {
			const path = `${dbPath}${suffix}`;
			if (existsSync(path)) rmSync(path);
		}
		delete process.env.MUONA_DB_PATH;
	});
}

// An S-ostoslista callback flow target that records what a handed-over
// login's callback delivered.
export function ostoslistaTarget(
	result: CallbackExchange = { ok: true },
): CallbackFlowTarget & { exchanged: string[] } {
	const exchanged: string[] = [];
	return {
		startUrl: "https://kirjautuminen.s-ostoslista.fi/login",
		isCallback: (url) => url.includes("/callback?") && url.includes("nonce="),
		exchanged,
		async exchangeCallback(url) {
			exchanged.push(url);
			await tick();
			return result;
		},
	};
}
