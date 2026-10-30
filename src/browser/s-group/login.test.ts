import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import { getLoginAges } from "../../store/login-history.ts";
import { getSetting, setSetting } from "../../store/settings.ts";
import { ProfileLockedError } from "../profile-lock.ts";
import { createIdpLease } from "./lease.ts";
import { createLoginFlow } from "./login.ts";
import {
	RELOGIN_BLOCK_SETTING_KEY,
	SAVED_EMAIL_SETTING_KEY,
	settingsSessionStore,
} from "./store.ts";
import {
	deferred,
	EMAIL,
	expectExpired,
	FakeIdp,
	FakeSite,
	harness,
	ManualClock,
	MINUTE,
	START,
	ticks,
	useTempSettingsDb,
} from "./test-fakes.ts";

// Human login steps, the IdP lease and the start semantics, all through the
// session interface against a scripted IdP. No Playwright, no network.

const BodySchema = z.object({ value: z.string() });
const isList = (url: string) => url.includes("limit=");
const OSTOSLISTA = {
	startUrl: "https://kirjautuminen.s-ostoslista.fi/login",
	isCallback: (url: string) => url.includes("nonce="),
};

useTempSettingsDb();

// A harness whose app session and S-tunnus SSO session are both gone, so a
// login has to go through a human step.
function expiredHarness(afterEmail: "otp" | "captcha" | "strong_auth" = "otp") {
	const h = harness();
	h.site.alive = false;
	h.idp.afterEmail = afterEmail;
	return h;
}

describe("login — wrong-phase guards", () => {
	test("starts idle with no email, error or captcha image", async () => {
		const { session } = harness();
		const state = await session.login.state();
		expect(state.phase).toBe("idle");
		expect(state.email).toBeUndefined();
		expect(state.captchaImageBase64).toBeUndefined();
	});

	test("each step outside its phase returns an error result and changes nothing", async () => {
		const { idp, session } = harness();
		const results = [
			await session.login.submitCaptcha("ABCD"),
			await session.login.submitOtp("123456"),
			await session.login.chooseStrongAuthMethod("Mobiilivarmenne"),
			await session.login.fillStrongAuthPhone("+358401234567"),
			await session.login.waitForStrongAuthCompletion(),
		];
		for (const result of results) {
			expect(result.phase).toBe("idle");
			expect(result.error).toContain("s_etukortti_login_start");
		}
		expect((await session.login.state()).phase).toBe("idle");
		expect(idp.opens).toBe(0);
	});

	test("cancel from idle is a safe no-op", async () => {
		const { idp, session } = harness();
		const state = await session.login.cancel();
		expect(state.phase).toBe("idle");
		expect(state.error).toBeUndefined();
		expect(idp.closes).toBe(0);
	});

	test("submitOtp while a captcha is pending is refused", async () => {
		const { session } = expiredHarness("captcha");
		await session.login.start(EMAIL);
		const result = await session.login.submitOtp("123456");
		expect(result.phase).toBe("awaiting_captcha");
		expect(result.error).toContain("s_etukortti_login_start");
	});
});

describe("login — phase transitions", () => {
	test("email → OTP → logged_in, saving the email and recording a human login", async () => {
		const { idp, session } = expiredHarness();
		const started = await session.login.start("me@example.com");
		expect(started.phase).toBe("awaiting_otp");
		expect(started.email).toBe("me@example.com");
		expect(getSetting(SAVED_EMAIL_SETTING_KEY)).toBe("me@example.com");
		expect(idp.otpEmails).toBe(1);

		const done = await session.login.submitOtp("123456");
		expect(done.phase).toBe("logged_in");
		expect(done.error).toBeUndefined();
		expect(idp.pageOpen).toBe(false);
		const ages = getLoginAges(START);
		expect(ages.lastHumanLoginAt).toBe(new Date(START).toISOString());
		expect(ages.lastSilentLoginAt).toBeNull();
		// The landing was verified through the app session.
		expect(session.report().appSession.hasToken).toBe(true);
	});

	test("an alive SSO completes from the email alone and records a silent_sso login", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		const state = await session.login.start(EMAIL);
		expect(state.phase).toBe("logged_in");
		expect(idp.emails).toEqual([EMAIL]);
		expect(idp.otpEmails).toBe(0);
		const ages = getLoginAges(START);
		expect(ages.lastSilentLoginAt).toBe(new Date(START).toISOString());
		expect(ages.lastHumanLoginAt).toBeNull();
	});

	test("an app session that is still alive lands straight back without an email submit", async () => {
		const { idp, session } = harness();
		const state = await session.login.start(EMAIL);
		expect(state.phase).toBe("logged_in");
		expect(idp.opens).toBe(1);
		expect(idp.emails).toEqual([]);
		expect(idp.pageOpen).toBe(false);
		expect(idp.forcedOpens).toBe(0);
		// Never went to the IdP, so it proves nothing about the SSO session.
		const ages = getLoginAges(START);
		expect(ages.lastSilentLoginAt).toBeNull();
		expect(ages.lastHumanLoginAt).toBeNull();
	});

	test("captcha shows the image, a wrong answer re-challenges, a right one moves on to OTP", async () => {
		const { idp, session } = expiredHarness("captcha");
		const started = await session.login.start(EMAIL);
		expect(started.phase).toBe("awaiting_captcha");
		expect(started.captchaImageBase64).toBe("Y2FwdGNoYQ==");

		const wrong = await session.login.submitCaptcha("XXXX");
		expect(wrong.phase).toBe("awaiting_captcha");
		expect(wrong.captchaImageBase64).toBe("bmV3IGNhcHRjaGE=");

		const right = await session.login.submitCaptcha("ABCD");
		expect(right.phase).toBe("awaiting_otp");
		expect(right.captchaImageBase64).toBeUndefined();
		expect(idp.otpEmails).toBe(1);

		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(getLoginAges(START).lastHumanLoginAt).not.toBeNull();
	});

	test("a rejected OTP may be retyped once; a second rejection fails and frees the IdP", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		const first = await session.login.submitOtp("000000");
		expect(first.phase).toBe("awaiting_otp");
		expect(first.error).toContain("retry once");
		expect(idp.pageOpen).toBe(true);

		const second = await session.login.submitOtp("111111");
		expect(second.phase).toBe("failed");
		expect(second.error).toContain("Code rejected");
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease.exclusive).toBeNull();
	});

	test("a retyped OTP that is right completes the login", async () => {
		const { session } = expiredHarness();
		await session.login.start(EMAIL);
		await session.login.submitOtp("000000");
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
	});

	test("strong auth after the OTP: choose method, phone, wait, approve", async () => {
		const { idp, session } = expiredHarness();
		idp.afterOtp = "strong_auth";
		await session.login.start(EMAIL);
		const sa = await session.login.submitOtp("123456");
		expect(sa.phase).toBe("awaiting_strong_auth");
		expect(sa.strongAuthMethods).toEqual(["Mobiilivarmenne", "S-Pankki", "Nordea"]);
		expect(sa.pageInfo).toContain("Tunnistaudu");

		const chosen = await session.login.chooseStrongAuthMethod("Mobiilivarmenne");
		expect(chosen.phase).toBe("awaiting_strong_auth");
		expect(chosen.pageInfo).toBe("provider page for Mobiilivarmenne");
		// The method list stays available while the provider page is shown.
		expect(chosen.strongAuthMethods).toEqual(["Mobiilivarmenne", "S-Pankki", "Nordea"]);

		const phone = await session.login.fillStrongAuthPhone("+358401234567");
		expect(phone.pageInfo).toContain("+358401234567");

		const pending = await session.login.waitForStrongAuthCompletion();
		expect(pending.phase).toBe("awaiting_strong_auth");
		expect(pending.error).toBe("Strong authentication not completed yet");
		expect(pending.pageInfo).toBe("waiting for approval");

		idp.strongAuthApproved = true;
		const done = await session.login.waitForStrongAuthCompletion(10);
		expect(done.phase).toBe("logged_in");
		expect(idp.waits).toEqual([180_000, 30_000]);
		expect(getLoginAges(START).lastHumanLoginAt).not.toBeNull();
	});

	test("the strong-auth wait is clamped to at most five minutes", async () => {
		const { idp, session } = expiredHarness("strong_auth");
		await session.login.start(EMAIL);
		await session.login.waitForStrongAuthCompletion(9_999);
		expect(idp.waits).toEqual([300_000]);
	});

	test("an unknown strong-auth method fails the login and closes the page", async () => {
		const { idp, session } = expiredHarness("strong_auth");
		await session.login.start(EMAIL);
		const state = await session.login.chooseStrongAuthMethod("Pankki X");
		expect(state.phase).toBe("failed");
		expect(state.error).toContain("Pankki X");
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease.exclusive).toBeNull();
	});

	test("an unexpected IdP page fails with its snapshot and frees the IdP", async () => {
		const h = harness();
		h.site.alive = false;
		h.idp.afterEmail = "unexpected";
		const state = await h.session.login.start(EMAIL);
		expect(state.phase).toBe("failed");
		expect(state.error).toContain("Jotain meni pieleen");
		expect(h.idp.pageOpen).toBe(false);
		expect(h.session.report().idpLease.exclusive).toBeNull();
	});

	test("a step that throws fails the login with the error", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		idp.stepThrows = new Error("OTP input disappeared before the code could be submitted");
		const state = await session.login.submitOtp("123456");
		expect(state.phase).toBe("failed");
		expect(state.error).toContain("OTP input disappeared");
		expect(idp.pageOpen).toBe(false);
	});

	test("a landing the app session does not confirm fails instead of logging in", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		idp.landingRevivesSite = false;
		const state = await session.login.submitOtp("123456");
		expect(state.phase).toBe("failed");
		expect(getLoginAges(START).lastHumanLoginAt).toBeNull();
	});

	test("cancel closes the page, frees the IdP and returns to idle", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		const state = await session.login.cancel();
		expect(state.phase).toBe("idle");
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease.exclusive).toBeNull();
	});

	test("a completed human login clears the relogin block", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		const { session } = expiredHarness();
		await session.login.start(EMAIL);
		expect(session.report().autoRelogin.blockedReason).not.toBeNull();
		await session.login.submitOtp("123456");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
	});
});

describe("login — stale reaper", () => {
	test("a login left waiting for 10 minutes is discarded and frees the IdP", async () => {
		const { site, idp, clock, session } = expiredHarness();
		await session.login.start(EMAIL);
		expect(session.report().idpLease.exclusive).toBe("human_login");
		await clock.advance(9 * MINUTE);
		expect((await session.login.state()).phase).toBe("awaiting_otp");

		await clock.advance(MINUTE);
		const state = await session.login.state();
		expect(state.phase).toBe("idle");
		expect(state.error).toContain("10 minutes");
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease.exclusive).toBeNull();

		site.alive = true;
		await expect(session.capture("https://s.example/edut", isList)).resolves.toEqual({
			items: [1],
		});
	});

	test("each step restarts the 10 minutes", async () => {
		const { clock, session } = expiredHarness();
		await session.login.start(EMAIL);
		await clock.advance(8 * MINUTE);
		await session.login.submitOtp("000000");
		await clock.advance(8 * MINUTE);
		expect((await session.login.state()).phase).toBe("awaiting_otp");
	});

	// Real timers can fire a hair before Date.now() reaches the deadline; a
	// reaper that gave up then never fired again and kept the IdP lease.
	test("a reaper timer that fires early re-arms and still reaps", async () => {
		const { idp, clock, session } = expiredHarness();
		await session.login.start(EMAIL);
		clock.fireNextEarlyBy(1);
		await clock.advance(10 * MINUTE);
		expect(session.report().idpLease.exclusive).toBeNull();
		expect(idp.pageOpen).toBe(false);
	});

	test("the remote screen hold keeps a strong-auth login alive", async () => {
		const { idp, clock, session } = expiredHarness("strong_auth");
		await session.login.start(EMAIL);
		for (let i = 0; i < 4; i++) {
			await clock.advance(5 * MINUTE);
			expect(await session.login.holdForRemoteScreen()).toBe("awaiting_strong_auth");
		}
		expect(idp.pageOpen).toBe(true);
		expect(await session.login.bringToFront()).toBe(true);
		expect(idp.fronted).toBe(1);
	});

	test("the remote screen hold does not extend a login in another phase", async () => {
		const { clock, session } = expiredHarness();
		await session.login.start(EMAIL);
		await clock.advance(6 * MINUTE);
		expect(await session.login.holdForRemoteScreen()).toBe("awaiting_otp");
		await clock.advance(5 * MINUTE);
		expect(await session.login.holdForRemoteScreen()).toBe("idle");
		expect(await session.login.bringToFront()).toBe(false);
	});
});

describe("IdP lease (I4) during a human login", () => {
	test("a page capture fails fast with login_in_progress and never navigates", async () => {
		const { site, session } = expiredHarness();
		await session.login.start(EMAIL);
		await expectExpired(session.capture("https://s.example/edut", isList), "login_in_progress");
		expect(site.pageCaptures).toHaveLength(0);
	});

	test("a keepalive tick is recorded as skipped and never navigates", async () => {
		// Shorter than the stale reaper, so the login is still waiting at the tick.
		const { site, idp, clock, session } = harness({ keepaliveHours: 0.1 });
		await session.get("/warm", {}, BodySchema);
		site.expire();
		idp.afterEmail = "otp";
		await session.login.start(EMAIL);
		await clock.advance(6 * MINUTE);
		expect(site.csrfSniffs).toBe(0);
		const info = session.report().keepalive;
		expect(info?.outcome).toBe("skipped");
		expect(idp.opens).toBe(1);
	});

	test("a plain API get with a valid token keeps working", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		idp.afterEmail = "otp";
		// The IdP asks for a code although the app session's token still works.
		site.alive = false;
		await session.login.start(EMAIL);
		site.alive = true;
		await expect(session.get("/a", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(site.pageCaptures).toHaveLength(0);
	});

	test("an expired get is declined without starting a second login", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		await expectExpired(session.get("/a", {}, BodySchema), "login_in_progress");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
	});

	test("report shows the holder", async () => {
		const { session } = expiredHarness();
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		await session.login.start(EMAIL);
		expect(session.report().idpLease.exclusive).toBe("human_login");
		await session.login.submitOtp("123456");
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
	});
});

describe("IdP lease (I4) during a silent relogin", () => {
	test("a page capture waits for the relogin instead of navigating into it", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		expect(session.report().idpLease.exclusive).toBe("silent_relogin");
		const captured = session.capture("https://s.example/edut", isList);
		await ticks();
		expect(site.pageCaptures).toHaveLength(0);
		gate.resolve();
		await expect(call).resolves.toEqual({ value: "ok" });
		await expect(captured).resolves.toEqual({ items: [1] });
		expect(site.pageCaptures).toHaveLength(1);
		expect(idp.opens).toBe(1);
	});

	// The hourly relogin usually takes this path (ee8334c measures SSO lifetime
	// from these entries): /login's authorize request is answered by the alive
	// SSO and redirects back with no email form ever shown.
	test("a relogin bounced back through the IdP without an email form records silent_sso", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.ssoBouncesWithoutEmailForm = true;
		await session.get("/a", {}, BodySchema);
		expect(idp.emails).toHaveLength(0);
		expect(getLoginAges(START).lastSilentLoginAt).toBe(new Date(START).toISOString());
	});

	test("a relogin records a silent_sso login", async () => {
		const { site, session } = harness();
		site.alive = false;
		await session.get("/a", {}, BodySchema);
		const ages = getLoginAges(START);
		expect(ages.lastSilentLoginAt).toBe(new Date(START).toISOString());
		expect(ages.lastHumanLoginAt).toBeNull();
		expect((await session.login.state()).phase).toBe("logged_in");
	});
});

describe("starting a human login (I5)", () => {
	test("start during an in-flight relogin waits for it and sends no OTP when it succeeded", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		const started = session.login.start(EMAIL);
		await ticks();
		gate.resolve();
		expect((await started).phase).toBe("logged_in");
		await expect(call).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(0);
	});

	test("start during a relogin that stops at OTP joins the handed-over login", async () => {
		const { site, idp, session } = harness();
		site.expire();
		idp.afterEmail = "otp";
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		const started = session.login.start(EMAIL);
		await ticks();
		gate.resolve();
		await expectExpired(call, "needs_human");
		expect((await started).phase).toBe("awaiting_otp");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
	});

	test("start during an active human login returns its state; restart starts over", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		await session.login.submitOtp("000000");
		const again = await session.login.start(EMAIL);
		expect(again.phase).toBe("awaiting_otp");
		expect(again.error).toContain("retry once");
		expect(idp.opens).toBe(1);

		const restarted = await session.login.start(EMAIL, { restart: true });
		expect(restarted.phase).toBe("awaiting_otp");
		expect(restarted.error).toBeUndefined();
		expect(idp.opens).toBe(2);
		expect(idp.closes).toBe(1);
		// The retype allowance starts over with the new attempt.
		expect((await session.login.submitOtp("000000")).phase).toBe("awaiting_otp");
	});

	test("cancel during an in-flight relogin leaves it alone", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		expect((await session.login.cancel()).phase).toBe("idle");
		expect(idp.closes).toBe(0);
		expect(idp.pageOpen).toBe(true);
		gate.resolve();
		await expect(call).resolves.toEqual({ value: "ok" });
	});
});

describe("relogin handover to a human", () => {
	test("a relogin stopping at OTP sets the block and hands its page to a human login", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await expectExpired(session.get("/a", {}, BodySchema), "needs_human");
		expect(session.report().autoRelogin.blockedReason).toContain("awaiting_otp");
		const state = await session.login.state();
		expect(state.phase).toBe("awaiting_otp");
		expect(state.email).toBe(EMAIL);
		expect(session.report().idpLease.exclusive).toBe("human_login");
		expect(idp.pageOpen).toBe(true);

		// The next expiry sends no second one-time code.
		await expectExpired(session.get("/b", {}, BodySchema), "login_in_progress");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);

		// The human finishes with the code already emailed.
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(getLoginAges(START).lastHumanLoginAt).not.toBeNull();
		await expect(session.get("/c", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(1);
	});

	// The handed-over attempt counted as failed, so the next relogin within the
	// cooldown was declined although the human had just logged in.
	test("a handed-over relogin the human completes starts no cooldown", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await expectExpired(session.get("/a", {}, BodySchema), "needs_human");
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		await clock.advance(15 * MINUTE);
		site.expire();
		idp.afterEmail = "sso_alive";
		await expect(session.get("/b", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(2);
	});

	test("a human login after a failed relogin lifts the cooldown", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		idp.afterEmail = "unexpected";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		idp.afterEmail = "otp";
		await session.login.start(EMAIL);
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		await clock.advance(5 * MINUTE);
		site.expire();
		idp.afterEmail = "sso_alive";
		await expect(session.get("/b", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(3);
	});

	test("after a handed-over login is reaped, the block still prevents a new OTP", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await expectExpired(session.get("/a", {}, BodySchema), "needs_human");
		await clock.advance(10 * MINUTE);
		expect(session.report().idpLease.exclusive).toBeNull();
		await expectExpired(session.get("/b", {}, BodySchema), "blocked");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
	});
});

// Regressions from the phase-3 review: the windows where a login waits on
// something (the lease drain, the landing's verification).
// The login flow on its own, so a silent login can run while a start waits
// for the lease (the session normally makes the start wait for the relogin;
// a relogin starting right after one that was declined slips past that).
describe("login flow — a start waiting behind a silent login", () => {
	test("a start superseded by a silent login's success leaves no human login behind", async () => {
		const site = new FakeSite();
		site.alive = false;
		const idp = new FakeIdp(site);
		const clock = new ManualClock(START);
		const lease = createIdpLease(clock);
		const flow = createLoginFlow({
			idp,
			store: settingsSessionStore,
			clock,
			lease,
			verifyLanded: async () => ({ loggedIn: true }),
			reloginInFlight: () => null,
			loginCompleted: () => {},
		});
		const releaseOther = await lease.acquireExclusive("ostoslista");
		const silent = flow.silentLogin(EMAIL);
		await ticks();
		const started = flow.steps.start(EMAIL);
		await ticks();
		releaseOther();
		expect((await silent).phase).toBe("logged_in");
		await started;
		await ticks();
		expect(await flow.humanLoginActive()).toBe(false);
		expect(lease.holder()).toBeNull();
	});
});

describe("login — waiting windows", () => {
	// A capture holding the shared lease keeps a starting login in the drain.
	async function captureInFlight(h: ReturnType<typeof harness>) {
		const gate = deferred();
		h.site.pageHold = gate.promise;
		const captured = h.session.capture("https://s.example/edut", isList);
		await ticks();
		h.site.alive = false;
		h.idp.afterEmail = "otp";
		return { captured, release: () => gate.resolve() };
	}

	test("cancel while start waits for the lease drain abandons the start", async () => {
		const h = harness();
		const cap = await captureInFlight(h);
		const started = h.session.login.start(EMAIL);
		await ticks();
		expect((await h.session.login.cancel()).phase).toBe("idle");
		cap.release();
		await cap.captured;
		await started;
		await ticks();
		expect(h.idp.opens).toBe(0);
		expect(h.idp.otpEmails).toBe(0);
		expect(h.session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		expect((await h.session.login.state()).phase).toBe("idle");
	});

	test("a second start while the first waits reports the start in progress", async () => {
		const h = harness();
		const cap = await captureInFlight(h);
		const first = h.session.login.start(EMAIL);
		await ticks();
		const second = await h.session.login.start(EMAIL);
		expect(second.phase).toBe("idle");
		expect(second.starting).toBe(true);
		expect(second.email).toBe(EMAIL);
		const restarted = h.session.login.start(EMAIL, { restart: true });
		cap.release();
		await cap.captured;
		expect((await first).phase).toBe("awaiting_otp");
		await restarted;
		expect(h.idp.opens).toBe(1);
		expect(h.idp.otpEmails).toBe(1);
		const state = await h.session.login.state();
		expect(state.phase).toBe("awaiting_otp");
		expect(state.starting).toBeUndefined();
	});

	// The lease had no per-acquisition owner: the cancelled start took it on
	// waking, saw the newer start as current and kept it, so the newer start
	// timed out and human_login held the lease forever.
	test("a start cancelled in the lease wait gives its acquisition back to a newer start", async () => {
		const h = harness();
		h.site.alive = false;
		const flowHeld = deferred();
		h.idp.hold = flowHeld.promise;
		const flow = h.session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		expect(h.session.report().idpLease.exclusive).toBe("ostoslista");
		const first = h.session.login.start(EMAIL);
		await ticks();
		expect((await h.session.login.cancel()).phase).toBe("idle");
		const second = h.session.login.start(EMAIL);
		await ticks();
		h.idp.hold = null;
		flowHeld.resolve();
		expect((await flow).kind).toBe("callback");
		await first;
		await ticks();
		// Past the lease wait: a start still queued by now times out.
		await h.clock.advance(3 * MINUTE);
		expect((await second).phase).toBe("logged_in");
		expect(h.session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
	});

	test("cancel while a restart closes the old page leaves the restart nothing to drive", async () => {
		const { idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		const closeHeld = deferred();
		idp.closeHold = closeHeld.promise;
		const restarted = session.login.start(EMAIL, { restart: true });
		await ticks();
		const cancelled = session.login.cancel();
		await ticks();
		idp.closeHold = null;
		closeHeld.resolve();
		await cancelled;
		await restarted;
		await ticks();
		expect(idp.opens).toBe(1);
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease.exclusive).toBeNull();
		expect((await session.login.state()).phase).toBe("idle");
	});

	test("start and cancel during a verification that throws return the failed state", async () => {
		const { site, session } = expiredHarness();
		await session.login.start(EMAIL);
		const gate = deferred();
		site.csrfHold = gate.promise;
		site.fastPathError = new ProfileLockedError(4242, "2026-10-29T08:00:00.000Z", "/profile");
		const submitted = session.login.submitOtp("123456");
		await ticks();
		const started = session.login.start(EMAIL);
		const cancelled = session.login.cancel();
		await ticks();
		site.csrfHold = null;
		gate.resolve();
		const settle = (p: Promise<{ phase: string }>) =>
			p.then(
				(s) => s.phase,
				(e: unknown) => `threw ${String(e)}`,
			);
		expect(await settle(submitted)).toBe("failed");
		expect(await settle(started)).toBe("failed");
		expect(await settle(cancelled)).toBe("failed");
		expect(session.report().idpLease.exclusive).toBeNull();
	});

	test("cancel during the landing's verification keeps the completed login", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		const { site, session } = expiredHarness();
		await session.login.start(EMAIL);
		const gate = deferred();
		site.csrfHold = gate.promise;
		const submitted = session.login.submitOtp("123456");
		await ticks();
		const cancelled = session.login.cancel();
		await ticks();
		site.csrfHold = null;
		gate.resolve();
		expect((await submitted).phase).toBe("logged_in");
		expect((await cancelled).phase).toBe("logged_in");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(getLoginAges(START).lastHumanLoginAt).toBe(new Date(START).toISOString());
	});

	test("a start during the landing's verification neither restarts nor misrecords it", async () => {
		const { site, idp, session } = expiredHarness();
		await session.login.start(EMAIL);
		const gate = deferred();
		site.csrfHold = gate.promise;
		const submitted = session.login.submitOtp("123456");
		await ticks();
		const started = session.login.start(EMAIL, { restart: true });
		await ticks();
		site.csrfHold = null;
		gate.resolve();
		expect((await submitted).phase).toBe("logged_in");
		expect((await started).phase).toBe("logged_in");
		expect(idp.opens).toBe(1);
		const ages = getLoginAges(START);
		expect(ages.lastHumanLoginAt).not.toBeNull();
		expect(ages.lastSilentLoginAt).toBeNull();
	});
});

// While the block is set the SSO session is known dead, so a still-valid app
// session must not let a "login" skip the IdP and clear the block.
describe("login — relogin block forces the IdP", () => {
	const OSTOSLISTA = {
		startUrl: "https://kirjautuminen.s-ostoslista.fi/login",
		isCallback: (url: string) => url.includes("nonce="),
	};

	test("a human start with the block set goes through the IdP even with an alive app session", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "Automatic S-ostoslista login stopped at otp");
		const { idp, session } = harness();
		idp.afterEmail = "otp";
		const started = await session.login.start(EMAIL);
		expect(idp.forcedOpens).toBe(1);
		expect(started.phase).toBe("awaiting_otp");
		expect(session.report().autoRelogin.blockedReason).not.toBeNull();
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		const ages = getLoginAges(START);
		expect(ages.lastHumanLoginAt).toBe(new Date(START).toISOString());
		expect(ages.lastSilentLoginAt).toBeNull();
	});

	test("a landing that skipped the IdP despite the block keeps it and records nothing", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		const { idp, session } = harness();
		idp.honoursForceIdp = false;
		await session.login.start(EMAIL);
		expect(session.report().autoRelogin.blockedReason).toBe("stopped at awaiting_otp");
		const ages = getLoginAges(START);
		expect(ages.lastHumanLoginAt).toBeNull();
		expect(ages.lastSilentLoginAt).toBeNull();
	});

	test("the S-ostoslista loop mails no code after a completed human login", async () => {
		const { idp, session } = harness();
		idp.humanLoginRevivesSso = true;
		for (let round = 1; round <= 2; round++) {
			// The SSO session dies; the app session is still valid.
			idp.afterEmail = "otp";
			const before = idp.otpEmails;
			expect((await session.runSilentIdpFlow("ostoslista", OSTOSLISTA)).kind).toBe("needs_human");
			// Accepted cost (R2): the human's login mails its own code.
			expect((await session.login.start(EMAIL)).phase).toBe("awaiting_otp");
			expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
			expect(session.report().autoRelogin.blockedReason).toBeNull();
			expect((await session.runSilentIdpFlow("ostoslista", OSTOSLISTA)).kind).toBe("callback");
			expect((await session.runSilentIdpFlow("ostoslista", OSTOSLISTA)).kind).toBe("callback");
			expect(idp.otpEmails - before).toBe(2);
		}
		expect(getLoginAges(START).lastSilentLoginAt).toBeNull();
	});
});
