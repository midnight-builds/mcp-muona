// Seams of the S-group session module. Adapters return plain observations,
// never Playwright objects, so the core can be driven by scripted fakes.

import type { LoginAges, LoginKind } from "../../store/login-history.ts";

export type LoginPhase =
	| "idle"
	| "awaiting_captcha"
	| "awaiting_otp"
	| "awaiting_strong_auth"
	| "logged_in"
	| "failed";

// A login sitting in one of these is waiting on a human step.
export const PHASES_NEEDING_HUMAN: readonly LoginPhase[] = [
	"awaiting_otp",
	"awaiting_captcha",
	"awaiting_strong_auth",
];

export type CsrfObservation =
	| { kind: "token"; token: string }
	| { kind: "logged_out"; detail: string };

// Anything else than 401/403 is not an auth signal and must not trigger a
// relogin, hence the separate http_error kind.
export type ApiObservation =
	| { kind: "ok"; body: unknown }
	| { kind: "unauthorized"; status: number }
	| { kind: "http_error"; status: number };

// A navigated page either produced the awaited response or showed a
// logged-out signal. A page that simply never answered is an Error, not an
// observation: it is no auth signal and must not trigger a relogin.
export type PageObservation =
	| { kind: "ok"; body: unknown }
	| { kind: "logged_out"; detail: string };

export interface SiteDriver {
	// Cheap path: a plain HTTP request carrying the profile's cookies.
	fetchCsrfToken(): Promise<CsrfObservation>;
	// Expensive path: loads an app page and sniffs the token from its own
	// traffic. Exercises the real browser session, which keepalive relies on.
	sniffCsrfToken(): Promise<CsrfObservation>;
	apiGet(path: string, params: Record<string, string>, csrfToken: string): Promise<ApiObservation>;
	// Opens a page in the shared context, navigates to `url` and returns the JSON
	// body of the first response whose URL `match` accepts.
	capturePage(
		url: string,
		match: (responseUrl: string) => boolean,
		timeoutMs?: number,
	): Promise<PageObservation>;
	// The browser went away; any token taken from it is suspect.
	onContextClosed(listener: () => void): void;
	close(): Promise<void>;
}

export interface SessionStore {
	getReloginBlock(): string | null;
	setReloginBlock(reason: string): void;
	clearReloginBlock(): void;
	getSavedEmail(): string | null;
	loginAges(): LoginAges | null;
	saveEmail(email: string): void;
	// Returns the ages as they were just before this login, for the lifetime log.
	recordLogin(kind: LoginKind, nowMs: number): LoginAges | null;
}

export type Cancel = () => void;

export interface Clock {
	now(): number;
	every(ms: number, fn: () => Promise<void> | void): Cancel;
	after(ms: number, fn: () => Promise<void> | void): Cancel;
}

// What the identity provider shows after a step, read off the login page by
// the adapter. Every selector, DOM heuristic and wait stays in the adapter;
// the core only decides what each screen means for the login phase.
export type IdpScreen =
	// Back on s-etukortti.fi: the IdP let the login through. viaIdp (set by
	// open() only) tells an alive SSO answering /login's redirect apart from an
	// app session that was still valid and never needed the IdP.
	| { kind: "returned_to_app"; viaIdp?: boolean }
	// Back on another service's callback: a callback flow that stopped at a
	// human step was handed over, and the human finished it at the IdP.
	| { kind: "callback"; url: string }
	| { kind: "email_form" }
	| { kind: "otp" }
	| { kind: "captcha"; imageBase64: string }
	| { kind: "strong_auth"; methods: string[]; pageInfo: string }
	| { kind: "otp_rejected"; snapshot: string }
	// Snapshots are already redacted (see redact.ts).
	| { kind: "unexpected"; snapshot: string };

export type HumanStepScreen = Extract<IdpScreen, { kind: "otp" | "captcha" | "strong_auth" }>;

export type StrongAuthProgress =
	| { kind: "returned_to_app" }
	| { kind: "callback"; url: string }
	| { kind: "pending"; pageInfo: string };

// Another S-group service's OIDC login through the same IdP (S-ostoslista).
// isCallback picks the final redirect back to that service; what it carries
// is the service's business, so the URL is handed back unparsed.
export type CallbackFlowTarget = {
	startUrl: string;
	isCallback(url: string): boolean;
	// A flow that stopped at a human step is handed over to the human login,
	// so the one-time code already mailed is not wasted. When the human
	// finishes, the callback is delivered here: the caller that started the
	// flow got needs_human long ago.
	exchangeCallback(url: string): Promise<CallbackExchange>;
};

export type CallbackExchange = { ok: true } | { ok: false; detail: string };

export type CallbackFlowObservation =
	| { kind: "callback"; url: string }
	// The IdP wants a one-time code, captcha or strong auth; the page stays on
	// it until close(). Still on the IdP after the email with no recognised
	// screen is a failed unexpected_idp_page, never a human step.
	| { kind: "human_step"; screen: HumanStepScreen; where: string }
	| { kind: "failed"; reason: "unexpected_idp_page" | "timeout"; detail: string };

// Drives the one login page in the shared browser. Only one flow uses it at a
// time (the core holds the IdP lease), so the adapter keeps that page itself;
// open() replaces any earlier one. A step that cannot run (input vanished,
// unknown method, page crashed) throws.
export interface IdpDriver {
	// Opens a fresh page at the app's /login: returned_to_app when the app
	// session is already alive, email_form once the IdP asks for the email.
	// forceIdp: drop the app session first (only the s-etukortti.fi cookies,
	// never the IdP's), so the login has to go through the IdP.
	open(opts?: { forceIdp?: boolean }): Promise<IdpScreen>;
	submitEmail(email: string): Promise<IdpScreen>;
	submitCaptcha(text: string): Promise<IdpScreen>;
	submitOtp(code: string): Promise<IdpScreen>;
	// Both return a redacted snapshot of the provider page that follows.
	chooseStrongAuthMethod(method: string): Promise<string>;
	fillStrongAuthPhone(phoneNumber: string): Promise<string>;
	waitForReturn(timeoutMs: number): Promise<StrongAuthProgress>;
	// Opens a fresh page (replacing any earlier one, like open()) at
	// target.startUrl, submits the email if the IdP asks for it and waits for
	// the callback. Stops at the first human step; never types anything else.
	// Until the page is replaced or closed, the steps above report reaching
	// target's callback as { kind: "callback" } rather than returned_to_app.
	runCallbackFlow(target: CallbackFlowTarget, email: string): Promise<CallbackFlowObservation>;
	close(): Promise<void>;
	bringToFront(): Promise<boolean>;
}

export type SGroupPorts = {
	site: SiteDriver;
	store: SessionStore;
	clock: Clock;
	idp: IdpDriver;
};

export type SGroupConfig = {
	keepaliveHours: number;
};
