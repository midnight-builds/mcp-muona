// S-ostoslista (SOK shopping-list app) client. The API is an AWS AppSync
// GraphQL endpoint behind a Lambda authorizer; endpoints and the auth flow
// were mapped from the Android APK (data-capture/s-ostoslista/README.md).
//
// Login piggybacks on the S-Etukortti browser profile: both services use the
// tunnistus.s-ryhma.fi IdP, so a live SSO session there completes the
// S-ostoslista OIDC flow without any human step. If the SSO session is gone we
// stop and report — OTP/strong auth stays with the human (see CLAUDE.md).

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import * as z from "zod/v4";
import { logger } from "../logger.ts";
import {
	type CallbackFlowTarget,
	RELOGIN_COOLDOWN_MS,
	remainingMinutes,
	type SilentIdpFlowOutcome,
	sGroup,
} from "./s-group/index.ts";

export const API_URL = "https://api.s-ostoslista.fi/graphql";
export const AUTH_ORIGIN = "https://kirjautuminen.s-ostoslista.fi";
const API_TIMEOUT = 20_000;
const REFRESH_SKEW_MS = 120_000;

// Said whenever an automatic login is impossible, and only by NotLoggedInError,
// so no message carries it twice. Never suggests cancelling a pending login:
// its one-time code has already been emailed.
// No `bun run login` either: stopping the server throws away a login page
// handed over from S-ostoslista along with its emailed code.
export const LOGIN_HINT =
	"The human must finish the S-Etukortti login with the s_etukortti_login_* tools, " +
	"which revives the S-tunnus SSO session; after that S-ostoslista calls log in by themselves.";

export class NotLoggedInError extends Error {
	constructor(detail: string) {
		super(`${detail} ${LOGIN_HINT}`);
		this.name = "NotLoggedInError";
	}
}

export class GraphqlError extends Error {
	readonly errorTypes: string[];
	constructor(messages: string[], errorTypes: string[]) {
		super(`S-ostoslista GraphQL error: ${messages.join("; ")}`);
		this.name = "GraphqlError";
		this.errorTypes = errorTypes;
	}
}

// Not a NotLoggedInError on purpose: a silent login cannot fix it, and
// fetching a fresh anonymous token would orphan the lists for good.
export class AnonymousIdentityLostError extends Error {
	constructor(kept: string) {
		super(
			`The S-ostoslista token file was unreadable and was kept as ${kept}. Its anonymous token ` +
				"owns Muona's shopping lists, so no new one is fetched automatically. Restore the " +
				"anonymousToken from that file into the token file, or delete the kept file to start " +
				"over with a new identity (Muona loses its lists; shared lists can be re-joined).",
		);
		this.name = "AnonymousIdentityLostError";
	}
}

function tokenPath(): string {
	return (
		process.env.S_OSTOSLISTA_TOKEN_PATH ??
		join(import.meta.dirname, "..", "..", "data", "s-ostoslista-tokens.json")
	);
}

// The AppSync API key ships inside the public app (EXPO_PUBLIC_OSTOSLISTA_API_KEY);
// kept in .env anyway so it can be rotated without a code change.
function apiKey(): string {
	const key = process.env.S_OSTOSLISTA_API_KEY;
	if (!key) throw new Error("S_OSTOSLISTA_API_KEY is not set (see data-capture/s-ostoslista)");
	return key;
}

export type CallbackResult =
	| { kind: "nonce"; nonce: string }
	| { kind: "failed"; reason: "expired" | "error" | "cancelled" };

// Mirrors the app's LoginScreen onNavigationStateChange: only the final
// /callback carries ?response=…&nonce=…; the earlier OIDC ?code= hop does not.
export function parseCallbackUrl(raw: string): CallbackResult | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.origin !== AUTH_ORIGIN || url.pathname !== "/callback") return null;
	const response = url.searchParams.get("response");
	if (response === "expired" || response === "error" || response === "cancelled") {
		return { kind: "failed", reason: response };
	}
	const nonce = url.searchParams.get("nonce");
	return nonce ? { kind: "nonce", nonce } : null;
}

const JwtPayloadSchema = z.object({ exp: z.number() });

export function decodeJwtExpiry(token: string): number | null {
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const parsed = JwtPayloadSchema.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		return parsed.success ? parsed.data.exp : null;
	} catch {
		return null;
	}
}

export function needsRefresh(expSeconds: number | null, nowMs: number): boolean {
	if (expSeconds === null) return true;
	return expSeconds * 1000 - nowMs < REFRESH_SKEW_MS;
}

export function buildAuthorization(anonymousToken: string, accessToken: string | null): string {
	return accessToken ? `${anonymousToken},${accessToken}` : anonymousToken;
}

export const TokenResponseSchema = z.object({
	accessToken: z.string().min(1),
	idToken: z.string().min(1),
	refreshToken: z.string().min(1),
});

const StoredTokensSchema = z.object({
	anonymousToken: z.string().nullable(),
	registered: TokenResponseSchema.extend({
		accessTokenExpiresAt: z.number().nullable(),
		loggedInAt: z.string(),
		refreshedAt: z.string().nullable(),
	}).nullable(),
});
type StoredTokens = z.infer<typeof StoredTokensSchema>;

let cache: StoredTokens | null = null;

// Tests swap the token file via S_OSTOSLISTA_TOKEN_PATH; the in-memory copy must follow.
export function resetTokenCache(): void {
	cache = null;
}

function loadTokens(): StoredTokens {
	if (cache) return cache;
	const path = tokenPath();
	if (!existsSync(path)) {
		cache = { anonymousToken: null, registered: null };
		return cache;
	}
	// I/O errors (EACCES, EMFILE, …) propagate: the file may be fine, and
	// treating it as corrupt would throw away the identity that owns the lists.
	const text = readFileSync(path, "utf8");
	let raw: unknown = null;
	try {
		raw = JSON.parse(text);
	} catch {
		// Truncated or hand-edited file: treated like a schema mismatch below.
	}
	const parsed = StoredTokensSchema.safeParse(raw);
	if (parsed.success) {
		cache = parsed.data;
		return cache;
	}
	// Keep the file for manual recovery rather than letting the next save
	// overwrite it, but carry on with its anonymous token if that part is intact.
	const aside = `${path}.corrupt-${Date.now()}`;
	renameSync(path, aside);
	const salvaged = SalvageSchema.safeParse(raw);
	const anonymousToken = salvaged.success ? salvaged.data.anonymousToken : null;
	logger.error(
		{ path, aside, anonymousTokenKept: anonymousToken !== null },
		"S-ostoslista token file unreadable, kept aside; starting logged out",
	);
	cache = { anonymousToken, registered: null };
	if (anonymousToken) saveTokens(cache);
	return cache;
}

const SalvageSchema = z.object({ anonymousToken: z.string().min(1) });

function keptAsideTokenFile(): string | null {
	const path = tokenPath();
	const prefix = `${basename(path)}.corrupt-`;
	if (!existsSync(dirname(path))) return null;
	const kept = readdirSync(dirname(path)).find((f) => f.startsWith(prefix));
	return kept ? join(dirname(path), kept) : null;
}

// Refresh tokens are equivalent to a live login, hence 0600 like the browser
// profile. Written to a fresh temp file and renamed so a crash mid-write can't
// leave a truncated file in place of the only valid refresh token.
function saveTokens(tokens: StoredTokens): void {
	const path = tokenPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	cache = tokens;
}

function expiryIso(exp: number | null): string | null {
	return exp === null ? null : new Date(exp * 1000).toISOString();
}

const GraphqlEnvelopeSchema = z.object({
	data: z.unknown().optional(),
	errors: z
		.array(z.object({ message: z.string(), errorType: z.string().optional() }))
		.optional()
		.nullable(),
});

export function extractGraphqlData<T>(json: unknown, schema: z.ZodType<T>): T {
	const envelope = GraphqlEnvelopeSchema.parse(json);
	const errors = envelope.errors ?? [];
	if (errors.length > 0) {
		// AppSync returns field-level errors next to data that still parses
		// (e.g. one product failing to resolve after a write). The write did
		// happen; failing here would invite a duplicating retry.
		const partial = envelope.data == null ? null : schema.safeParse(envelope.data);
		if (partial?.success) {
			logger.warn(
				{ errors: errors.map((e) => e.message) },
				"S-ostoslista returned data with field errors",
			);
			return partial.data;
		}
		throw new GraphqlError(
			errors.map((e) => e.message),
			errors.flatMap((e) => (e.errorType ? [e.errorType] : [])),
		);
	}
	return schema.parse(envelope.data);
}

function operationName(query: string): string {
	return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

async function postGraphql(
	query: string,
	variables: Record<string, unknown>,
	headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(API_URL, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Non-JSON bodies only happen on gateway errors; status carries the signal.
	}
	return { status: res.status, json };
}

const AnonymousTokenDataSchema = z.object({ anonymousUserToken: z.string().min(1) });

let anonymousPromise: Promise<string> | null = null;

async function fetchAnonymousToken(): Promise<string> {
	const { status, json } = await postGraphql(
		"query anonymousUserToken { anonymousUserToken }",
		{},
		{ "x-api-key": apiKey() },
	);
	if (status !== 200) throw new Error(`anonymousUserToken failed: HTTP ${status}`);
	const token = extractGraphqlData(json, AnonymousTokenDataSchema).anonymousUserToken;
	const exp = decodeJwtExpiry(token);
	saveTokens({ ...loadTokens(), anonymousToken: token });
	logger.info({ expiresAt: expiryIso(exp) }, "S-ostoslista anonymous token obtained");
	return token;
}

// Shopping lists belong to the anonymous token, not to the S-tunnus (verified
// live 2026-10-30: a fresh anonymous token with the same registered login sees
// none of them). So it is fetched once and never replaced — not on a 401, not
// near its expiry (currently ~100 years out); a new one would orphan every list.
async function ensureAnonymousToken(): Promise<string> {
	const current = loadTokens().anonymousToken;
	if (current) {
		const exp = decodeJwtExpiry(current);
		if (exp !== null && needsRefresh(exp, Date.now())) {
			logger.error(
				{ expiresAt: expiryIso(exp) },
				"S-ostoslista anonymous token expiring; keeping it, since a new one would orphan the lists",
			);
		}
		return current;
	}
	const kept = keptAsideTokenFile();
	if (kept) {
		logger.error({ kept }, "S-ostoslista anonymous token lost; refusing to fetch a new one");
		throw new AnonymousIdentityLostError(kept);
	}
	logger.info("S-ostoslista has no anonymous token yet, fetching one");
	if (!anonymousPromise) {
		anonymousPromise = fetchAnonymousToken().finally(() => {
			anonymousPromise = null;
		});
	}
	return anonymousPromise;
}

function storeRegistered(tokens: z.infer<typeof TokenResponseSchema>, refreshed: boolean): void {
	const previous = loadTokens().registered;
	const exp = decodeJwtExpiry(tokens.accessToken);
	saveTokens({
		...loadTokens(),
		registered: {
			...tokens,
			accessTokenExpiresAt: exp,
			loggedInAt: refreshed && previous ? previous.loggedInAt : new Date().toISOString(),
			refreshedAt: refreshed ? new Date().toISOString() : null,
		},
	});
}

let refreshPromise: Promise<string> | null = null;

function ageHours(iso: string | null | undefined): number | null {
	if (!iso) return null;
	return Math.round(((Date.now() - Date.parse(iso)) / 3_600_000) * 10) / 10;
}

async function doRefresh(refreshToken: string): Promise<string> {
	// Refresh-chain ages tell how long a login survives without a browser.
	const previous = loadTokens().registered;
	const chain = {
		loginAgeHours: ageHours(previous?.loggedInAt),
		hoursSinceLastRefresh: ageHours(previous?.refreshedAt ?? previous?.loggedInAt),
	};
	logger.info(chain, "Refreshing S-ostoslista access token");
	const res = await fetch(`${AUTH_ORIGIN}/refresh`, {
		method: "POST",
		headers: { "Content-Type": "text/plain" },
		body: refreshToken,
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	const text = await res.text();
	// Only an explicit rejection means the refresh token is dead. Gateway
	// errors, throttling and timeouts keep it: dropping it would force a
	// re-login over a transient blip.
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		logger.warn(
			{ status: res.status, refreshChainEnded: true, ...chain },
			"S-ostoslista token refresh rejected — dropping stored login",
		);
		saveTokens({ ...loadTokens(), registered: null });
		throw new NotLoggedInError(`S-ostoslista token refresh rejected (HTTP ${res.status}).`);
	}
	if (!res.ok || !text) {
		logger.warn(
			{ status: res.status, emptyBody: !text },
			"S-ostoslista token refresh failed transiently — keeping stored login",
		);
		throw new Error(`S-ostoslista token refresh failed (HTTP ${res.status}); try again later.`);
	}
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// Reported below.
	}
	const parsed = TokenResponseSchema.safeParse(body);
	if (!parsed.success) {
		// The server may already have rotated the refresh token, so the stored
		// one is likely dead now; log the shape so the schema can be fixed.
		const keys = body && typeof body === "object" ? Object.keys(body) : [];
		logger.error({ keys }, "S-ostoslista refresh returned an unexpected body");
		throw new Error(`S-ostoslista refresh returned unexpected body (keys: ${keys.join(",")})`);
	}
	const tokens = parsed.data;
	storeRegistered(tokens, true);
	const exp = decodeJwtExpiry(tokens.accessToken);
	logger.info(
		{
			expiresAt: expiryIso(exp),
			refreshTokenRotated: tokens.refreshToken !== refreshToken,
			...chain,
		},
		"S-ostoslista access token refreshed",
	);
	return tokens.accessToken;
}

async function ensureAccessToken(force = false): Promise<string> {
	// About to refresh: re-read from disk first, since another process (e.g. a
	// dev instance on the same data dir) may have rotated the refresh token.
	const cached = loadTokens().registered;
	if (
		!refreshPromise &&
		(force || needsRefresh(cached?.accessTokenExpiresAt ?? null, Date.now()))
	) {
		resetTokenCache();
	}
	const registered = loadTokens().registered;
	if (!registered) throw new NotLoggedInError("Not logged in to S-ostoslista.");
	if (!force && !needsRefresh(registered.accessTokenExpiresAt, Date.now())) {
		return registered.accessToken;
	}
	if (!refreshPromise) {
		refreshPromise = doRefresh(registered.refreshToken).finally(() => {
			refreshPromise = null;
		});
	}
	return refreshPromise;
}

function isUnauthorized(status: number, json: unknown): boolean {
	if (status === 401 || status === 403) return true;
	const parsed = GraphqlEnvelopeSchema.safeParse(json);
	// With data present the operation ran; resending it would repeat a write.
	return (
		parsed.success &&
		parsed.data.data == null &&
		(parsed.data.errors ?? []).some((e) => e.errorType === "UnauthorizedException")
	);
}

// Every data call goes through here. When it ends not logged in, one silent
// login and one retry follow, so a login that needs no human needs no separate
// step. Never more than one flow per call: a second failure is final.
export async function gql<T>(
	query: string,
	variables: Record<string, unknown>,
	schema: z.ZodType<T>,
	options?: { requireLogin?: boolean },
): Promise<T> {
	try {
		return await gqlOnce(query, variables, schema, options);
	} catch (err) {
		if (!(err instanceof NotLoggedInError) || options?.requireLogin === false) throw err;
		logger.info(
			{ op: operationName(query), reason: err.message },
			"S-ostoslista not logged in, starting an automatic silent login",
		);
		await loginAutomatically();
		return gqlOnce(query, variables, schema, options);
	}
}

// Refresh-before-expiry, plus one retry with fresh tokens if AppSync still
// says unauthorized (e.g. server-side revoke).
async function gqlOnce<T>(
	query: string,
	variables: Record<string, unknown>,
	schema: z.ZodType<T>,
	options?: { requireLogin?: boolean },
): Promise<T> {
	const requireLogin = options?.requireLogin ?? true;
	const op = operationName(query);
	const started = Date.now();

	const attempt = async (force: boolean) => {
		const anon = await ensureAnonymousToken();
		const access = requireLogin ? await ensureAccessToken(force) : null;
		return postGraphql(query, variables, { authorization: buildAuthorization(anon, access) });
	};

	let { status, json } = await attempt(false);
	if (isUnauthorized(status, json)) {
		logger.warn(
			{ op, status },
			"S-ostoslista call unauthorized, refreshing the access token and retrying",
		);
		({ status, json } = await attempt(true));
		if (requireLogin && isUnauthorized(status, json)) {
			logger.warn({ op, status }, "S-ostoslista still unauthorized after token renewal");
			throw new NotLoggedInError("S-ostoslista rejected the renewed tokens.");
		}
	}
	if (status !== 200 && json === null) {
		throw new Error(`S-ostoslista ${op} failed: HTTP ${status}`);
	}
	const data = extractGraphqlData(json, schema);
	logger.info({ op, status, ms: Date.now() - started }, "S-ostoslista GraphQL call");
	return data;
}

export type LoginOutcome =
	| { ok: true; accessTokenExpiresAt: string | null }
	| {
			ok: false;
			reason:
				| "etukortti_login_busy"
				| "no_saved_email"
				| "needs_human"
				| "unexpected_idp_page"
				| "callback_failed"
				| "verify_failed"
				| "timeout";
			detail: string;
	  };

let loginPromise: Promise<LoginOutcome> | null = null;

export type RunLoginFlow = (target: CallbackFlowTarget) => Promise<SilentIdpFlowOutcome>;

const LOGIN_TARGET: CallbackFlowTarget = {
	startUrl: `${AUTH_ORIGIN}/login`,
	isCallback: (url) => parseCallbackUrl(url) !== null,
	// A flow that stopped at a human step lands here once the human finishes it
	// through the s_etukortti_login_* tools.
	async exchangeCallback(url) {
		logger.info("S-ostoslista login: callback from a handed-over human login");
		const outcome = await exchangeCallback(url);
		return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail };
	},
};

// The browser part (IdP, email submit, gate, IdP lease, relogin block) is the
// S-group session's; this side turns its outcome into tokens.
export async function loginWith(runFlow: RunLoginFlow): Promise<LoginOutcome> {
	logger.info("S-ostoslista login: starting the silent SSO flow");
	const outcome = await runFlow(LOGIN_TARGET);
	switch (outcome.kind) {
		case "declined":
			logger.info({ reason: outcome.reason }, "S-ostoslista login declined");
			if (outcome.reason === "login_in_progress") {
				return {
					ok: false,
					reason: "etukortti_login_busy",
					detail:
						"An S-Etukortti login is in progress: finish it with the s_etukortti_login_* " +
						"tools, then retry. Do not cancel it; its one-time code has already been emailed. " +
						outcome.detail,
				};
			}
			if (outcome.reason === "no_saved_email") {
				return {
					ok: false,
					reason: "no_saved_email",
					detail:
						"No saved S-tunnus email. Log in to S-Etukortti once via the " +
						"s_etukortti_login_* tools (that saves the email), then retry.",
				};
			}
			// Blocked: an earlier automatic flow already reached a human step
			// (and maybe mailed a code), so only a human login moves this on.
			return {
				ok: false,
				reason: "needs_human",
				detail: `Automatic logins are blocked: ${outcome.detail}`,
			};
		case "needs_human":
			return {
				ok: false,
				reason: "needs_human",
				detail: `The S-tunnus SSO session has expired. ${outcome.detail}`,
			};
		case "failed":
			return { ok: false, reason: outcome.reason, detail: outcome.detail };
		case "callback":
			return exchangeCallback(outcome.url);
	}
}

async function exchangeCallback(url: string): Promise<LoginOutcome> {
	const result = parseCallbackUrl(url);
	if (!result) {
		logger.warn("S-ostoslista login: callback URL without a nonce or response");
		return { ok: false, reason: "callback_failed", detail: "Callback carried no nonce." };
	}
	if (result.kind === "failed") {
		logger.warn({ response: result.reason }, "S-ostoslista login: callback reported failure");
		return { ok: false, reason: "callback_failed", detail: `Callback response=${result.reason}` };
	}

	logger.info("S-ostoslista login: exchanging nonce at /verify");
	const res = await fetch(`${AUTH_ORIGIN}/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(result.nonce),
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// Reported below via status and key list.
	}
	const tokens = TokenResponseSchema.safeParse(body);
	if (!res.ok || !tokens.success) {
		const keys = body && typeof body === "object" ? Object.keys(body) : [];
		logger.warn(
			{
				status: res.status,
				keys,
				error: z.object({ error: z.string() }).safeParse(body).data?.error,
			},
			"S-ostoslista login: /verify did not return tokens",
		);
		return {
			ok: false,
			reason: "verify_failed",
			detail: `/verify HTTP ${res.status}, body keys: ${keys.join(",") || "none"}`,
		};
	}

	storeRegistered(tokens.data, false);
	const exp = expiryIso(decodeJwtExpiry(tokens.data.accessToken));
	logger.info({ accessTokenExpiresAt: exp }, "S-ostoslista login succeeded, tokens stored");
	return { ok: true, accessTokenExpiresAt: exp };
}

// Flow and clock are a seam: production uses the S-group session and wall
// time, tests inject fakes (the real flow drives a browser).
type AutoLoginDeps = { runFlow: RunLoginFlow; now: () => number };

const defaultAutoLogin: AutoLoginDeps = {
	runFlow: (target) => sGroup.runSilentIdpFlow("ostoslista", target),
	now: () => Date.now(),
};

let autoLoginDeps = defaultAutoLogin;
// The failed flow behind the cooldown: when, and its reason ("threw" when it
// never returned one).
let flowFailure: { at: number; reason: string } | null = null;

// A failed flow means something is off with the IdP page or network; trying
// again on every call would hammer it (and mail codes if it half-works). The
// S-Etukortti relogin's cooldown: both fail on the same IdP and network.
const FLOW_COOLDOWN_MS = RELOGIN_COOLDOWN_MS;

// Replacing the deps also forgets the cooldown, so tests start clean.
export function setAutoLogin(deps: AutoLoginDeps): void {
	autoLoginDeps = deps;
	flowFailure = null;
}

// Failures that say the flow itself broke, not that a human is needed (the
// persisted relogin block covers needs_human and blocked).
function isFlowFailure(outcome: Extract<LoginOutcome, { ok: false }>): boolean {
	return (
		outcome.reason !== "needs_human" &&
		outcome.reason !== "etukortti_login_busy" &&
		outcome.reason !== "no_saved_email"
	);
}

function login(): Promise<LoginOutcome> {
	if (!loginPromise) {
		loginPromise = (async () => {
			try {
				const outcome = await loginWith(autoLoginDeps.runFlow);
				if (outcome.ok) {
					logger.info(
						{ accessTokenExpiresAt: outcome.accessTokenExpiresAt },
						"S-ostoslista automatic login succeeded",
					);
				} else if (isFlowFailure(outcome)) {
					flowFailure = { at: autoLoginDeps.now(), reason: outcome.reason };
					logger.info(
						{
							reason: outcome.reason,
							detail: outcome.detail,
							cooldownMinutes: FLOW_COOLDOWN_MS / 60_000,
						},
						"S-ostoslista automatic login failed, cooling down",
					);
				} else {
					logger.warn(
						{ reason: outcome.reason },
						"S-ostoslista automatic login stopped at a human step",
					);
				}
				return outcome;
			} catch (err) {
				flowFailure = { at: autoLoginDeps.now(), reason: "threw" };
				logger.warn(
					{ err, cooldownMinutes: FLOW_COOLDOWN_MS / 60_000 },
					"S-ostoslista automatic login threw, cooling down",
				);
				throw err;
			}
		})().finally(() => {
			loginPromise = null;
		});
	}
	return loginPromise;
}

async function loginAutomatically(): Promise<void> {
	if (!loginPromise && flowFailure !== null) {
		const now = autoLoginDeps.now();
		const until = flowFailure.at + FLOW_COOLDOWN_MS;
		if (now < until) {
			const minutes = remainingMinutes(until, now);
			logger.info(
				{ lastOutcome: flowFailure.reason, remainingMinutes: minutes },
				"S-ostoslista automatic login skipped: cooling down",
			);
			throw new NotLoggedInError(
				`The last automatic S-ostoslista login failed; cooling down for ${minutes} more minute(s).`,
			);
		}
	}
	let outcome: LoginOutcome;
	try {
		outcome = await login();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new NotLoggedInError(`Automatic S-ostoslista login failed: ${reason}.`);
	}
	if (!outcome.ok) throw new NotLoggedInError(outcome.detail);
}

const UserDataSchema = z.object({
	user: z
		.object({
			id: z.string(),
			type: z.enum(["ANONYMOUS_USER", "REGISTERED_USER"]),
			firstName: z.string().nullish(),
			customershipRole: z.string().nullish(),
		})
		.nullable(),
});

export type OstoslistaStatus = {
	loggedIn: boolean;
	userType: string | null;
	firstName: string | null;
	accessTokenExpiresAt: string | null;
	loggedInAt: string | null;
	refreshedAt: string | null;
	error?: string;
	// What to do about it; only when not already said by the error.
	hint?: string;
};

export async function getStatus(): Promise<OstoslistaStatus> {
	// Read after the call: the call may have logged in by itself.
	const snapshot = () => {
		const registered = loadTokens().registered;
		return {
			accessTokenExpiresAt: expiryIso(registered?.accessTokenExpiresAt ?? null),
			loggedInAt: registered?.loggedInAt ?? null,
			refreshedAt: registered?.refreshedAt ?? null,
		};
	};
	try {
		const { user } = await gql(
			"query user { user { id type firstName customershipRole } }",
			{},
			UserDataSchema,
		);
		const loggedIn = user?.type === "REGISTERED_USER";
		if (!loggedIn) {
			logger.info(
				{ userType: user?.type ?? null },
				"S-ostoslista answered without a registered user",
			);
		}
		return {
			loggedIn,
			...(loggedIn ? {} : { hint: LOGIN_HINT }),
			userType: user?.type ?? null,
			firstName: user?.firstName ?? null,
			...snapshot(),
		};
	} catch (err) {
		logger.warn({ err }, "S-ostoslista status check failed");
		const error = err instanceof Error ? err.message : String(err);
		return {
			loggedIn: false,
			userType: null,
			firstName: null,
			...snapshot(),
			error,
			// A NotLoggedInError already carries the hint.
			...(err instanceof NotLoggedInError ? {} : { hint: LOGIN_HINT }),
		};
	}
}

const PricingSchema = z
	.object({
		currentPrice: z.number().nullish(),
		regularPrice: z.number().nullish(),
		comparisonPrice: z.number().nullish(),
		campaignPrice: z.number().nullish(),
		campaignPriceValidUntil: z.string().nullish(),
	})
	.nullish();

export const ProductSchema = z.object({
	id: z.string().nullish(),
	name: z.string().nullish(),
	ean: z.string().nullish(),
	brandName: z.string().nullish(),
	available: z.boolean().nullish(),
	approxPrice: z.boolean().nullish(),
	priceUnit: z.string().nullish(),
	comparisonUnit: z.string().nullish(),
	pricing: PricingSchema,
	location: z
		.object({
			aisle: z.string().nullish(),
			label: z.string().nullish(),
			name: z.string().nullish(),
		})
		.nullish(),
});

const ShoppingListItemSchema = z.object({
	__typename: z.string().optional(),
	id: z.string(),
	name: z.string(),
	collected: z.boolean().nullish(),
	// Free-text items (ShoppingListItem)
	products: z.array(z.object({ ean: z.string(), quantity: z.number() })).nullish(),
	// Product-resolved items (ProductResolvedShoppingListItem)
	ean: z.string().nullish(),
	quantity: z.number().nullish(),
	quantityUnit: z.string().nullish(),
	sokId: z.string().nullish(),
	product: ProductSchema.nullish(),
});

export const ShoppingListSchema = z.object({
	id: z.string(),
	name: z.string(),
	mode: z.string().nullish(),
	storeId: z.string().nullish(),
	shared: z.boolean(),
	permissions: z.array(z.string()),
	modifiedAt: z.string(),
	store: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
	items: z.array(ShoppingListItemSchema),
});

export const ShoppingListsDataSchema = z.object({ shoppingLists: z.array(ShoppingListSchema) });
export type ShoppingList = z.infer<typeof ShoppingListSchema>;

export const PRODUCT_FIELDS = `
	id name ean brandName available approxPrice priceUnit comparisonUnit
	pricing { currentPrice regularPrice comparisonPrice campaignPrice campaignPriceValidUntil }
	location { aisle label name }
`;

// Selection set matching ShoppingListSchema; every list-returning query and
// mutation uses it so the result parses the same way.
export const SHOPPING_LIST_FIELDS = `
	id name mode storeId shared permissions modifiedAt
	store { id name }
	items {
		__typename id name collected
		... on ShoppingListItem { products { ean quantity } }
		... on ProductResolvedShoppingListItem {
			ean quantity quantityUnit sokId
			product { ${PRODUCT_FIELDS} }
		}
	}
`;

const SHOPPING_LISTS_QUERY = `
	query GetShoppingLists {
		shoppingLists { ${SHOPPING_LIST_FIELDS} }
	}
`;

export async function fetchShoppingLists(): Promise<ShoppingList[]> {
	const data = await gql(SHOPPING_LISTS_QUERY, {}, ShoppingListsDataSchema);
	return data.shoppingLists;
}

export const PastProductsDataSchema = z.object({
	pastProducts: z
		.array(
			z.object({
				isWeeklyProduct: z.boolean(),
				latestQuantity: z.number(),
				totalCount: z.number(),
				product: ProductSchema,
			}),
		)
		.nullable(),
});
export type PastProduct = NonNullable<
	z.infer<typeof PastProductsDataSchema>["pastProducts"]
>[number];

const PAST_PRODUCTS_QUERY = `
	query PastProducts($storeId: String!) {
		pastProducts(storeId: $storeId) {
			isWeeklyProduct latestQuantity totalCount
			product { ${PRODUCT_FIELDS} }
		}
	}
`;

export async function fetchPastProducts(storeId: string): Promise<PastProduct[]> {
	const data = await gql(PAST_PRODUCTS_QUERY, { storeId }, PastProductsDataSchema);
	return data.pastProducts ?? [];
}
