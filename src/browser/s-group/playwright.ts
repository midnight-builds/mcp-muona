// Playwright adapter for the S-group session module: owns the one persistent
// browser context (shared by everything that touches S-group sites) and turns
// its pages and requests into plain observations for the core.

import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import * as z from "zod/v4";
import { logger } from "../../logger.ts";
import { chromium } from "../chromium.ts";
import { acquireProfileLock, type ProfileLock } from "../profile-lock.ts";
import type { ApiObservation, CsrfObservation, PageObservation, SiteDriver } from "./ports.ts";

export const ORIGIN = "https://s-etukortti.fi";
export const RECEIPTS_PAGE = `${ORIGIN}/bonusostot-ja-kuitit`;
const API_ORIGIN = "https://api.s-etukortti.fi";
const API_TIMEOUT = 20_000;
const CSRF_CAPTURE_TIMEOUT = 30_000;
// The header may show "Kirjaudu" briefly while a valid session hydrates, so
// that weak signal is only trusted after this long.
const WEAK_LOGGED_OUT_GRACE_MS = 6_000;
const PAGE_CAPTURE_TIMEOUT = 30_000;

// Separate profile from the k-ruoka session: that one deletes its data dir on
// browser failures, which must never wipe a manually established login here.
export const dataDir =
	process.env.S_ETUKORTTI_DATA_DIR ??
	join(import.meta.dirname, "..", "..", "..", ".browser-data-s-etukortti");

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let context: BrowserContext | null = null;
let launchPromise: Promise<BrowserContext> | null = null;
const contextClosedListeners: (() => void)[] = [];

// Held for the life of the process (released on exit): the server and
// `bun run login` must never open this profile at the same time.
let profileLock: ProfileLock | null = null;

export type ScreenSize = { width: number; height: number };

export function parseScreenSize(raw: string | undefined): ScreenSize | null {
	const match = /^(\d+)x(\d+)$/.exec(raw ?? "");
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width > 0 && height > 0 ? { width, height } : null;
}

// With a virtual display configured (Xvfb + S_ETUKORTTI_SCREEN_SIZE) the
// browser always runs headed on it, sized to a phone-shaped screen, so the
// remote login screen can show the live login tab without relaunching the
// browser mid-login.
function launchOptions() {
	const screen = process.env.DISPLAY ? parseScreenSize(process.env.S_ETUKORTTI_SCREEN_SIZE) : null;
	if (screen) {
		return {
			headless: false,
			viewport: null,
			args: [`--window-size=${screen.width},${screen.height}`, "--window-position=0,0"],
			userAgent: USER_AGENT,
			locale: "fi-FI",
		};
	}
	return { headless: true, userAgent: USER_AGENT, locale: "fi-FI" };
}

async function doLaunch(): Promise<BrowserContext> {
	const options = launchOptions();
	logger.info(
		{ dataDir, headless: options.headless, display: process.env.DISPLAY },
		"Launching S-Etukortti browser",
	);
	// Throws ProfileLockedError when another live process owns the profile;
	// launching anyway would let both browsers write the same cookie jar.
	profileLock ??= acquireProfileLock(dataDir);
	const lock = profileLock;
	try {
		return await chromium.launchPersistentContext(dataDir, options);
	} catch (err) {
		// Unlike the k-ruoka session we never delete the profile: it holds the
		// manually established login. Holding the profile lock means no live
		// process owns Chromium's singleton files, so clearing them is safe.
		logger.warn({ err }, "S-Etukortti browser launch failed, clearing locks and retrying");
		lock.removeStaleChromiumLocks();
		return chromium.launchPersistentContext(dataDir, options);
	}
}

export async function getContext(): Promise<BrowserContext> {
	if (context) return context;
	if (!launchPromise) {
		launchPromise = doLaunch()
			.then((ctx) => {
				context = ctx;
				ctx.on("close", () => {
					context = null;
					for (const listener of contextClosedListeners) listener();
				});
				return ctx;
			})
			.finally(() => {
				launchPromise = null;
			});
	}
	return launchPromise;
}

function isLoggedOutUrl(url: string): boolean {
	return url.includes("tunnistus.s-ryhma.fi") || new URL(url).pathname.startsWith("/login");
}

// URL and "Sivua ei löydy" are definitive logged-out signals. A visible
// "Kirjaudu" link is weaker, see WEAK_LOGGED_OUT_GRACE_MS.
async function looksLoggedOut(page: Page, options?: { includeWeak?: boolean }): Promise<boolean> {
	if (isLoggedOutUrl(page.url())) return true;
	const title = await page.title().catch(() => "");
	if (title.includes("Sivua ei löydy")) return true;
	if (!options?.includeWeak) return false;
	return page
		.getByRole("link", { name: "Kirjaudu" })
		.first()
		.isVisible({ timeout: 1_000 })
		.catch(() => false);
}

// The SPA sends x-csrf-token on every API call; sniff it from the page's own
// traffic since the token is not exposed anywhere else we can rely on.
async function sniffCsrfToken(): Promise<CsrfObservation> {
	const ctx = await getContext();
	const page = await ctx.newPage();
	try {
		const captured = new Promise<string>((resolve) => {
			page.on("request", (request) => {
				if (!request.url().startsWith(API_ORIGIN)) return;
				const token = request.headers()["x-csrf-token"];
				if (token) resolve(token);
			});
		});

		await page.goto(RECEIPTS_PAGE, { waitUntil: "domcontentloaded", timeout: 45_000 });

		// Poll for logged-out signals while waiting for the token so an expired
		// session is detected in seconds instead of the full capture timeout.
		const start = Date.now();
		const deadline = start + CSRF_CAPTURE_TIMEOUT;
		let token: string | null = null;
		while (Date.now() < deadline) {
			token = await Promise.race([captured, page.waitForTimeout(1_500).then(() => null)]);
			if (token) break;
			const includeWeak = Date.now() - start > WEAK_LOGGED_OUT_GRACE_MS;
			if (await looksLoggedOut(page, { includeWeak })) {
				return { kind: "logged_out", detail: "Not logged in to s-etukortti.fi." };
			}
		}

		if (!token) {
			throw new Error(
				"Could not capture x-csrf-token from s-etukortti.fi — the page loaded but made no API calls",
			);
		}
		return { kind: "token", token };
	} finally {
		await page.close().catch(() => {});
	}
}

// Opens a fresh page, navigates to `url` and waits for the page's own
// request matching `match` (e.g. an SPA call that needs the SPA's bearer auth
// and cannot be replayed from outside).
async function capturePage(
	url: string,
	match: (responseUrl: string) => boolean,
	timeoutMs = PAGE_CAPTURE_TIMEOUT,
): Promise<PageObservation> {
	const ctx = await getContext();
	const page = await ctx.newPage();
	try {
		let resolveCaptured: ((body: unknown) => void) | undefined;
		let rejectCaptured: ((err: unknown) => void) | undefined;
		const captured = new Promise<unknown>((resolve, reject) => {
			resolveCaptured = resolve;
			rejectCaptured = reject;
		});

		page.on("response", (response) => {
			if (!match(response.url())) return;
			response.json().then(resolveCaptured, rejectCaptured);
		});

		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

		// Poll for the logged-out URL while waiting so an expired session is
		// detected in seconds instead of the full capture timeout.
		const deadline = Date.now() + timeoutMs;
		let body: unknown;
		while (Date.now() < deadline) {
			body = await Promise.race([captured, page.waitForTimeout(1_500).then(() => undefined)]);
			if (body !== undefined) break;
			if (isLoggedOutUrl(page.url())) {
				return { kind: "logged_out", detail: "Not logged in to s-etukortti.fi." };
			}
		}

		if (body === undefined) {
			throw new Error(
				`Could not capture the awaited response from ${url} — the page loaded but the call never completed`,
			);
		}
		return { kind: "ok", body };
	} finally {
		await page.close().catch(() => {});
	}
}

const CsrfTokenBodySchema = z.object({ token: z.string() });

// Fast path for CSRF capture: the endpoint also happens to work with a plain
// fetch() carrying the session cookies, skipping the page navigation that
// sniffCsrfToken() needs. IMPORTANT: this must stay a native fetch() and
// not go through Playwright's ctx.request — that crashes under Bun parsing
// this endpoint's set-cookie header (verified live).
async function fetchCsrfToken(): Promise<CsrfObservation> {
	const ctx = await getContext();
	const cookies = await ctx.cookies(API_ORIGIN);
	const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

	const response = await fetch(`${API_ORIGIN}/api/v1/useraccount/auth/csrf`, {
		headers: {
			Cookie: cookieHeader,
			Origin: ORIGIN,
			Referer: `${ORIGIN}/`,
			Accept: "application/json",
		},
		// Every caller shares this refresh; a hung request would stall them all.
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (response.status === 401 || response.status === 403) {
		return {
			kind: "logged_out",
			detail: `S-Etukortti CSRF endpoint returned HTTP ${response.status}.`,
		};
	}
	if (!response.ok) {
		throw new Error(`S-Etukortti CSRF endpoint HTTP ${response.status}`);
	}

	const body: unknown = await response.json().catch(() => null);
	const parsed = CsrfTokenBodySchema.safeParse(body);
	if (parsed.success) return { kind: "token", token: parsed.data.token };

	const headerToken = response.headers.get("x-csrf-token");
	if (headerToken) return { kind: "token", token: headerToken };

	throw new Error(
		"S-Etukortti CSRF endpoint returned an unparsable body and no x-csrf-token header",
	);
}

async function apiGet(
	path: string,
	params: Record<string, string>,
	csrfToken: string,
): Promise<ApiObservation> {
	const ctx = await getContext();
	const url = new URL(path, API_ORIGIN);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const response = await ctx.request.get(url.toString(), {
		headers: {
			"x-csrf-token": csrfToken,
			"x-language": "fi",
			Origin: ORIGIN,
			Referer: `${ORIGIN}/`,
			Accept: "application/json",
		},
		timeout: API_TIMEOUT,
	});

	const status = response.status();
	if (status === 401 || status === 403) return { kind: "unauthorized", status };
	if (!response.ok()) return { kind: "http_error", status };
	const body: unknown = await response.json();
	return { kind: "ok", body };
}

async function closeContext(): Promise<void> {
	if (context) {
		await context.close().catch(() => {});
	}
	context = null;
}

export const playwrightSiteDriver: SiteDriver = {
	fetchCsrfToken,
	sniffCsrfToken,
	apiGet,
	capturePage,
	onContextClosed(listener) {
		contextClosedListeners.push(listener);
	},
	close: closeContext,
};
