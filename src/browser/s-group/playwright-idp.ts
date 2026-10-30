// Playwright adapter for the IdP driver: drives the one login page in the
// shared S-Etukortti browser through tunnistus.s-ryhma.fi and reads each
// screen back as a plain IdpScreen. All selectors, DOM heuristics and waits
// live here; what a screen means for the login is decided in login.ts.

import type { Frame, Page, Request } from "playwright";
import { logger } from "../../logger.ts";
import { getContext, ORIGIN } from "./playwright.ts";
import type {
	CallbackFlowObservation,
	CallbackFlowTarget,
	HumanStepScreen,
	IdpDriver,
	IdpScreen,
	StrongAuthProgress,
} from "./ports.ts";
import { redactSessionTokens } from "./redact.ts";

const CAPTCHA_INPUT_SELECTOR = 'input[placeholder="Kirjoita teksti kuvasta"]';
const STRONG_AUTH_LINK_SELECTOR = 'a[href*="/redirect-to-strong-authentication"]';
const STRONG_AUTH_HEADING_RE = /Tunnistaudu pankkitunnuksilla/i;
const STRONG_AUTH_SUBMIT_RE = /jatka|lähetä|tunnistaudu|continue|submit|ok/i;
const STRONG_AUTH_PHONE_FIELD_RE = /puhelin|phone|numero/i;
const IDP_HOST = "tunnistus.s-ryhma.fi";
// The app session's cookies only. The tunnistus.s-ryhma.fi ones hold the SSO
// session every silent login rides, so they must survive a forced login.
export const APP_COOKIE_DOMAIN = /^(?:.*\.)?s-etukortti\.fi$/;
const CALLBACK_FLOW_TIMEOUT = 45_000;
// A logged-out IdP still serves its login form; give the SSO redirect chain
// this long to move past it before concluding no SSO session exists.
const IDP_SETTLE_MS = 10_000;

let loginPage: Page | null = null;
// Bumped by every open and close, so an open that a restart or cancel
// overtook while it awaited the browser never installs its page over the
// newer one.
let pageEpoch = 0;
// Set while the login page belongs to a callback flow: the final callback hop
// it has seen, if any. Read off requests, because the hop may redirect on to
// the app's custom scheme and never show up as the page URL.
let callbackLanding: { url: string | null } | null = null;

function requirePage(): Page {
	if (!loginPage || loginPage.isClosed()) throw new Error("The login page is no longer open");
	return loginPage;
}

function onApp(page: Page): boolean {
	return new URL(page.url()).hostname === "s-etukortti.fi";
}

type Landing = { kind: "returned_to_app" } | { kind: "callback"; url: string };

// Where the IdP let the login through to: a callback flow's own callback, or
// s-etukortti.fi for the S-Etukortti login.
function landed(page: Page): Landing | null {
	if (callbackLanding) {
		return callbackLanding.url ? { kind: "callback", url: callbackLanding.url } : null;
	}
	return onApp(page) ? { kind: "returned_to_app" } : null;
}

async function waitForLanding(page: Page, timeoutMs: number): Promise<Landing | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const landing = landed(page);
		if (landing || page.isClosed() || Date.now() >= deadline) return landing;
		await page.waitForTimeout(500).catch(() => {});
	}
}

async function mainSnapshot(page: Page): Promise<string> {
	const snapshot = await page
		.locator("main")
		.ariaSnapshot()
		.catch(() => "(main snapshot unavailable)");
	return redactSessionTokens(snapshot);
}

async function bodySnapshot(page: Page): Promise<string> {
	const snapshot = await page
		.locator("body")
		.ariaSnapshot()
		.catch(() => "(page snapshot unavailable)");
	return redactSessionTokens(snapshot);
}

function findCaptchaFrame(page: Page): Frame | undefined {
	return page
		.frames()
		.find((f) => f.url().includes("mtcaptcha") && f.url().includes("iframe.html"));
}

async function findOtpInput(page: Page) {
	const candidates = [
		page.getByRole("textbox", { name: /koodi/i }),
		page.locator('input[autocomplete="one-time-code"]'),
		page.locator('input[inputmode="numeric"]'),
		page.locator('input[type="text"], input[type="tel"], input[type="number"]'),
	];
	for (const locator of candidates) {
		const first = locator.first();
		if (await first.isVisible({ timeout: 2_000 }).catch(() => false)) return first;
	}
	return null;
}

// After the email OTP is accepted, tunnistus.s-ryhma.fi may hand the flow off
// to a "Tunnistaudu pankkitunnuksillasi" page instead of redirecting back to
// s-etukortti.fi. This is a normal step of the login (bank/Mobiilivarmenne
// strong authentication), not a rejected code, so it needs its own detection
// ahead of the generic failure classification.
async function detectStrongAuth(
	page: Page,
): Promise<Extract<IdpScreen, { kind: "strong_auth" }> | null> {
	const heading = page.getByRole("heading", { name: STRONG_AUTH_HEADING_RE });
	const headingVisible = await heading
		.first()
		.isVisible({ timeout: 1_000 })
		.catch(() => false);

	const links = page.locator(STRONG_AUTH_LINK_SELECTOR);
	const count = await links.count().catch(() => 0);
	if (!headingVisible && count === 0) return null;

	const methods: string[] = [];
	for (let i = 0; i < count; i++) {
		const name = (
			await links
				.nth(i)
				.innerText()
				.catch(() => "")
		).trim();
		if (name && !methods.includes(name)) methods.push(name);
	}
	return { kind: "strong_auth", methods, pageInfo: await mainSnapshot(page) };
}

// Shared classification after every "Jatka" click. The IdP can complete the
// login straight from the email submit when its own SSO session is still
// valid and redirect right back to s-etukortti.fi; that is the path silent
// logins rely on, so it is checked first.
async function classify(page: Page): Promise<IdpScreen> {
	await page.waitForTimeout(4_000);
	const landing = landed(page);
	if (landing) return landing;

	const emailBox = page.getByRole("textbox", { name: "Sähköpostiosoite" });
	const emailVisible = await emailBox.isVisible({ timeout: 1_000 }).catch(() => false);
	const otpInput = await findOtpInput(page);
	if (otpInput && !emailVisible) return { kind: "otp" };

	const frame = findCaptchaFrame(page);
	const captchaInput = frame?.locator(CAPTCHA_INPUT_SELECTOR).first();
	const captchaVisible = captchaInput
		? await captchaInput.isVisible({ timeout: 2_000 }).catch(() => false)
		: false;
	if (frame && captchaInput && captchaVisible) {
		const buffer = await frame.locator("img").first().screenshot();
		return { kind: "captcha", imageBase64: buffer.toString("base64") };
	}

	const strongAuth = await detectStrongAuth(page);
	if (strongAuth) return strongAuth;

	// No known challenge on screen; the redirect back can take a few extra
	// seconds, so give it one more chance before failing.
	const late = await waitForLanding(page, 10_000);
	if (late) return late;

	const alertText = await page
		.getByRole("alert")
		.first()
		.innerText({ timeout: 1_000 })
		.catch(() => "");
	const snapshot = await mainSnapshot(page);
	return {
		kind: "unexpected",
		snapshot: alertText ? `${redactSessionTokens(alertText)}\n${snapshot}` : snapshot,
	};
}

// Reads the screen the callback flow stopped at, in full: the page is handed
// over to a human login, which shows the captcha image or the bank list.
// null: no recognised step, which the flow reports as a failure.
async function humanStepScreen(page: Page): Promise<HumanStepScreen | null> {
	const frame = findCaptchaFrame(page);
	const captchaInput = frame?.locator(CAPTCHA_INPUT_SELECTOR).first();
	if (frame && captchaInput && (await captchaInput.isVisible().catch(() => false))) {
		const buffer = await frame.locator("img").first().screenshot();
		return { kind: "captcha", imageBase64: buffer.toString("base64") };
	}
	const strongAuth = await detectStrongAuth(page);
	if (strongAuth) return strongAuth;
	const emailVisible = await page
		.getByRole("textbox", { name: "Sähköpostiosoite" })
		.isVisible({ timeout: 1_000 })
		.catch(() => false);
	if (!emailVisible && (await findOtpInput(page))) return { kind: "otp" };
	return null;
}

function where(page: Page): string {
	const url = new URL(page.url());
	return `${url.hostname}${url.pathname}`;
}

// Both the S-Etukortti login and callback flows submit the email the same way.
async function fillAndSubmitEmail(page: Page, email: string): Promise<void> {
	await page.getByRole("textbox", { name: "Sähköpostiosoite" }).fill(email);
	// Give the invisible captcha a moment to resolve before submitting.
	await page.waitForTimeout(3_000);
	await page.getByRole("button", { name: "Jatka" }).click();
}

async function openPage(): Promise<Page> {
	await closeLoginPage();
	const epoch = ++pageEpoch;
	const ctx = await getContext();
	const page = await ctx.newPage();
	if (epoch !== pageEpoch) {
		await page.close().catch(() => {});
		throw new Error("Login page open was superseded by a newer open or close");
	}
	loginPage = page;
	return page;
}

async function runCallbackFlow(
	target: CallbackFlowTarget,
	email: string,
): Promise<CallbackFlowObservation> {
	const page = await openPage();
	const startOrigin = new URL(target.startUrl).origin;
	// Held in an object: TS can't see the event handler's assignment and would
	// narrow a plain `let` to null for the rest of the function. Shared with
	// the steps, which finish this page if it is handed over to a human.
	const captured: { url: string | null } = { url: null };
	callbackLanding = captured;
	page.on("request", (request) => {
		const url = request.url();
		if (!url.startsWith(`${startOrigin}/callback`)) return;
		const isFinal = target.isCallback(url);
		// Parameter names only: the code/nonce values are login secrets.
		logger.info(
			{ params: [...new URL(url).searchParams.keys()], final: isFinal },
			"Callback flow: callback hop",
		);
		if (isFinal && !captured.url) captured.url = url;
	});

	await page
		.goto(target.startUrl, { waitUntil: "domcontentloaded", timeout: CALLBACK_FLOW_TIMEOUT })
		.catch((err) => {
			// The final hop may try to leave for the app's custom scheme; the
			// callback has already been captured by then.
			if (!captured.url) throw err;
		});

	const deadline = Date.now() + CALLBACK_FLOW_TIMEOUT;
	let onIdpSince: number | null = null;
	let emailSubmitted = false;
	while (!captured.url && Date.now() < deadline) {
		const onIdp = new URL(page.url()).hostname.endsWith(IDP_HOST);
		if (!onIdp) {
			onIdpSince = null;
			await page.waitForTimeout(500);
			continue;
		}
		onIdpSince ??= Date.now();

		// The IdP shows its email form even with a live SSO session; only the
		// email submit reveals whether it completes silently or wants an OTP.
		// The email is not a secret; everything after it is the human's.
		if (!emailSubmitted) {
			const emailBox = page.getByRole("textbox", { name: "Sähköpostiosoite" });
			if (await emailBox.isVisible().catch(() => false)) {
				await fillAndSubmitEmail(page, email);
				emailSubmitted = true;
				onIdpSince = Date.now();
				logger.info({ email }, "Callback flow: email submitted to the IdP");
				continue;
			}
		}

		if (Date.now() - onIdpSince > IDP_SETTLE_MS) {
			if (emailSubmitted) {
				const screen = await humanStepScreen(page);
				if (screen) return { kind: "human_step", screen, where: where(page) };
				const emailAgain = await page
					.getByRole("textbox", { name: "Sähköpostiosoite" })
					.isVisible()
					.catch(() => false);
				// Not a recognised human step, so no evidence the SSO is dead:
				// blocking here would stop the hourly relogins over a page hiccup.
				return {
					kind: "failed",
					reason: "unexpected_idp_page",
					detail: emailAgain
						? `The IdP asked for the email address again on ${where(page)}.`
						: `Stuck on ${where(page)} without a recognised login step.`,
				};
			}
			return {
				kind: "failed",
				reason: "unexpected_idp_page",
				detail: `Stuck on ${where(page)} without the expected email form.`,
			};
		}
		await page.waitForTimeout(500);
	}

	if (captured.url) return { kind: "callback", url: captured.url };
	return {
		kind: "failed",
		reason: "timeout",
		detail: `No callback was reached (last page ${where(page)}).`,
	};
}

async function closeLoginPage(): Promise<void> {
	// Taken synchronously so a page opened right after this call is never the
	// one closed here.
	pageEpoch++;
	const page = loginPage;
	loginPage = null;
	callbackLanding = null;
	if (page) await page.close().catch(() => {});
}

export const playwrightIdpDriver: IdpDriver = {
	async open(opts) {
		const page = await openPage();
		if (opts?.forceIdp) {
			// With the app cookies gone /login has to bounce to the IdP instead
			// of landing on a still-valid app session.
			await page.context().clearCookies({ domain: APP_COOKIE_DOMAIN });
			logger.info("S-Etukortti app cookies cleared to force the login through the IdP");
		}
		// An alive SSO can answer /login's authorize redirect itself and bounce
		// back before any email form shows; a main-frame navigation request to
		// the IdP tells that real (silent) login apart from a still-valid app
		// session. Requests, not framenavigated: the IdP hop is a server-side
		// redirect that never commits a frame (seen in prod 2026-10-29), but
		// Playwright still emits a request for every redirect hop.
		let viaIdp = false;
		const onRequest = (request: Request) => {
			if (viaIdp || !request.isNavigationRequest()) return;
			if (request.frame() !== page.mainFrame()) return;
			if (new URL(request.url()).hostname.endsWith(IDP_HOST)) viaIdp = true;
		};
		page.on("request", onRequest);
		try {
			await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
		} finally {
			page.off("request", onRequest);
		}
		logger.info({ viaIdp, landedOnApp: onApp(page) }, "S-Etukortti /login navigation settled");
		if (onApp(page)) return { kind: "returned_to_app", viaIdp };

		await page.waitForURL(/tunnistus\.s-ryhma\.fi/, { timeout: 30_000 });
		await page
			.getByRole("textbox", { name: "Sähköpostiosoite" })
			.waitFor({ state: "visible", timeout: 20_000 });
		return { kind: "email_form" };
	},

	async submitEmail(email) {
		const page = requirePage();
		await fillAndSubmitEmail(page, email);
		return classify(page);
	},

	async submitCaptcha(text) {
		const page = requirePage();
		const frame = findCaptchaFrame(page);
		const input = frame?.locator(CAPTCHA_INPUT_SELECTOR).first();
		if (!frame || !input) {
			throw new Error("Captcha challenge disappeared before the answer could be submitted");
		}
		await input.fill(text);
		await input.press("Enter");

		// A wrong answer means the token never appears; that's not fatal here,
		// classify() below will surface a fresh challenge or a failure.
		await page
			.waitForFunction(`!!document.querySelector('input[name="mtcaptcha-verifiedtoken"]')?.value`, {
				timeout: 15_000,
			})
			.catch(() => {});

		await page.getByRole("button", { name: "Jatka" }).click();
		return classify(page);
	},

	async submitOtp(code) {
		const page = requirePage();
		const otpInput = await findOtpInput(page);
		if (!otpInput) throw new Error("OTP input disappeared before the code could be submitted");
		await otpInput.fill(code);

		const submit = page.getByRole("button", { name: /jatka|kirjaudu|vahvista/i }).first();
		if (await submit.isVisible({ timeout: 2_000 }).catch(() => false)) {
			await submit.click();
		} else {
			await otpInput.press("Enter");
		}

		const landing = await waitForLanding(page, 60_000);
		if (landing) return landing;

		// The OTP was accepted but the site now wants strong authentication
		// instead of returning straight to s-etukortti.fi: a normal next step.
		const strongAuth = await detectStrongAuth(page);
		if (strongAuth) return strongAuth;

		return { kind: "otp_rejected", snapshot: await mainSnapshot(page) };
	},

	// The provider page's DOM is unknown ahead of time (Telia, ten different
	// banks), so this hands back a full body snapshot rather than trying to
	// interpret the page itself.
	async chooseStrongAuthMethod(method) {
		const page = requirePage();
		const links = page.locator(STRONG_AUTH_LINK_SELECTOR);
		const count = await links.count();
		let target: ReturnType<typeof links.nth> | undefined;
		for (let i = 0; i < count; i++) {
			const candidate = links.nth(i);
			const name = (await candidate.innerText().catch(() => "")).trim();
			if (name.toLowerCase() === method.toLowerCase()) {
				target = candidate;
				break;
			}
		}
		if (!target) {
			throw new Error(`No strong-authentication method named "${method}" was found on the page`);
		}

		await target.click();
		// The provider page is on an external identification service; give it
		// a few seconds to navigate and settle instead of racing its own load.
		await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
		await page.waitForTimeout(3_000);
		return bodySnapshot(page);
	},

	// For Mobiilivarmenne (and similar phone-based flows): the provider then
	// typically shows a short verification code the human must compare on
	// their own phone before approving.
	async fillStrongAuthPhone(phoneNumber) {
		const page = requirePage();
		const candidates = [
			page.locator('input[type="tel"]'),
			page.locator('input[inputmode="tel"]'),
			page.getByLabel(STRONG_AUTH_PHONE_FIELD_RE),
			page.getByPlaceholder(STRONG_AUTH_PHONE_FIELD_RE),
		];
		let input: ReturnType<typeof page.locator> | undefined;
		for (const locator of candidates) {
			const first = locator.first();
			if (await first.isVisible({ timeout: 2_000 }).catch(() => false)) {
				input = first;
				break;
			}
		}
		if (!input) throw new Error("No phone number input found on the strong-authentication page");
		await input.fill(phoneNumber);

		const submit = page.getByRole("button", { name: STRONG_AUTH_SUBMIT_RE }).first();
		if (await submit.isVisible({ timeout: 2_000 }).catch(() => false)) {
			await submit.click();
		} else {
			await input.press("Enter");
		}

		// The next screen (a short verification code) needs a moment to render.
		await page.waitForTimeout(4_000);
		return bodySnapshot(page);
	},

	// The flow redirects back (to s-etukortti.fi, or a handed-over callback
	// flow's callback) once the human approves on their own device; until then
	// this just reports what the page shows.
	async waitForReturn(timeoutMs): Promise<StrongAuthProgress> {
		const page = requirePage();
		const landing = await waitForLanding(page, timeoutMs);
		if (landing) return landing;
		logger.info("Strong-authentication wait ended without a redirect back");
		return { kind: "pending", pageInfo: await bodySnapshot(page) };
	},

	runCallbackFlow,

	close: closeLoginPage,

	// For the remote login screen: the human must see the login tab, not
	// whatever background page was opened last in the headed window. Left
	// alone while the login page has an open popup — some banks run their
	// flow in one, and yanking focus back would break it.
	async bringToFront() {
		const page = loginPage;
		if (!page || page.isClosed()) return false;
		for (const other of page.context().pages()) {
			if (other === page || other.isClosed()) continue;
			if ((await other.opener()) === page) return false;
		}
		await page.bringToFront();
		return true;
	},
};
