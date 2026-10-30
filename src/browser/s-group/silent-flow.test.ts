import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import { getLoginAges } from "../../store/login-history.ts";
import { deleteSetting, setSetting } from "../../store/settings.ts";
import { RELOGIN_BLOCK_SETTING_KEY, SAVED_EMAIL_SETTING_KEY } from "./store.ts";
import {
	deferred,
	EMAIL,
	expectExpired,
	harness,
	MINUTE,
	ostoslistaTarget,
	START,
	ticks,
	useTempSettingsDb,
} from "./test-fakes.ts";

// The S-ostoslista silent flow through the session interface: the same gate
// and the exclusive IdP lease as the S-Etukortti relogin. No Playwright, no network.

const BodySchema = z.object({ value: z.string() });
const isList = (url: string) => url.includes("limit=");
const OSTOSLISTA = ostoslistaTarget();

useTempSettingsDb();

describe("ostoslista silent flow — gate", () => {
	test("declined while the relogin block is set, without opening the IdP", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		const { idp, session } = harness();
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("declined");
		if (outcome.kind === "declined") expect(outcome.reason).toBe("blocked");
		expect(idp.opens).toBe(0);
	});

	test("declined while a human login is active", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await session.login.start(EMAIL);
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("declined");
		if (outcome.kind === "declined") expect(outcome.reason).toBe("login_in_progress");
		expect(idp.opens).toBe(1);
		expect(idp.callbackFlows).toHaveLength(0);
	});

	test("declined without a saved email", async () => {
		deleteSetting(SAVED_EMAIL_SETTING_KEY);
		const { idp, session } = harness();
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("declined");
		if (outcome.kind === "declined") expect(outcome.reason).toBe("no_saved_email");
		expect(idp.opens).toBe(0);
	});
});

describe("ostoslista silent flow — outcomes", () => {
	test("an alive SSO returns the callback URL and closes the page", async () => {
		const { idp, session } = harness();
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome).toEqual({ kind: "callback", url: idp.callbackUrl });
		expect(idp.emails).toEqual([EMAIL]);
		expect(idp.callbackFlows).toEqual([OSTOSLISTA.startUrl]);
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		// Login history stays S-Etukortti's own.
		expect(getLoginAges(START).lastSilentLoginAt).toBeNull();
	});

	test("a human step sets the block and hands the open page to a human login", async () => {
		const { site, idp, session } = harness();
		idp.afterEmail = "otp";
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("needs_human");
		if (outcome.kind === "needs_human") expect(outcome.detail).toContain("s_etukortti_login_");
		const blocked = session.report().autoRelogin.blockedReason;
		expect(blocked).toContain("S-ostoslista");
		expect(blocked).toContain("otp");
		expect(idp.pageOpen).toBe(true);
		expect(session.report().idpLease.exclusive).toBe("human_login");
		const state = await session.login.state();
		expect(state.phase).toBe("awaiting_otp");
		expect(state.email).toBe(EMAIL);

		// The next S-Etukortti expiry mails no second one-time code.
		site.expire();
		await expectExpired(session.get("/a", {}, BodySchema), "login_in_progress");
		// Nor does a second S-ostoslista attempt.
		const again = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(again.kind).toBe("declined");
		// Nor the human's start: it joins the handed-over login.
		expect((await session.login.start(EMAIL)).phase).toBe("awaiting_otp");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
	});

	test("an unexpected IdP page fails without setting the block", async () => {
		const { idp, session } = harness();
		idp.afterEmail = "unexpected";
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.reason).toBe("unexpected_idp_page");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(idp.pageOpen).toBe(false);
	});

	test("an unrecognised IdP screen after the email fails without setting the block", async () => {
		const { site, idp, session } = harness();
		idp.callbackFlowStuck = true;
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.reason).toBe("unexpected_idp_page");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(idp.pageOpen).toBe(false);
		// The hourly S-Etukortti relogin keeps working.
		site.expire();
		await expect(session.get("/a", {}, BodySchema)).resolves.toEqual({ value: "ok" });
	});

	test("a flow that throws closes its page and frees the lease", async () => {
		const { idp, session } = harness();
		idp.afterEmail = "throw";
		await expect(session.runSilentIdpFlow("ostoslista", OSTOSLISTA)).rejects.toThrow(
			"browser crashed",
		);
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
	});
});

// The human finishes the S-ostoslista flow's own page: the IdP sends them back
// to the S-ostoslista callback, never to s-etukortti.fi.
describe("ostoslista silent flow — handed-over login", () => {
	test("the one-time code lands on the callback, which S-ostoslista exchanges", async () => {
		const { site, idp, session } = harness();
		const target = ostoslistaTarget();
		idp.afterEmail = "otp";
		idp.humanLoginRevivesSso = true;
		await session.runSilentIdpFlow("ostoslista", target);
		const done = await session.login.submitOtp("123456");
		expect(done.phase).toBe("logged_in");
		expect(target.exchanged).toEqual([idp.callbackUrl]);
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(getLoginAges(START).lastHumanLoginAt).toBe(new Date(START).toISOString());
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });

		// The revived SSO lets the S-Etukortti relogin through without a code.
		site.expire();
		await expect(session.get("/a", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.otpEmails).toBe(1);
	});

	// The callback matcher also accepts response=cancelled/error, which prove
	// nothing about the SSO; lifting the block on one would let the next
	// relogin mail a code nobody asked for.
	test("a failed exchange fails the login and keeps the block", async () => {
		const { site, idp, session } = harness();
		const target = ostoslistaTarget({ ok: false, detail: "Callback response=cancelled" });
		site.alive = false;
		idp.afterEmail = "otp";
		await session.runSilentIdpFlow("ostoslista", target);
		const done = await session.login.submitOtp("123456");
		expect(done.phase).toBe("failed");
		expect(done.error).toContain("response=cancelled");
		expect(done.error).toContain("s_etukortti_login_start");
		expect(session.report().autoRelogin.blockedReason).not.toBeNull();
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		expect(getLoginAges(START).lastHumanLoginAt).toBeNull();
	});

	test("after a failed exchange with an alive SSO, a new start completes without a code", async () => {
		const { site, idp, session } = harness();
		const target = ostoslistaTarget({ ok: false, detail: "/verify HTTP 400" });
		site.alive = false;
		idp.afterEmail = "otp";
		idp.humanLoginRevivesSso = true;
		await session.runSilentIdpFlow("ostoslista", target);
		expect((await session.login.submitOtp("123456")).phase).toBe("failed");
		expect((await session.login.start(EMAIL)).phase).toBe("logged_in");
		expect(session.report().autoRelogin.blockedReason).toBeNull();
		expect(idp.otpEmails).toBe(1);
	});

	// Nothing in flight to wait on (the relogin handover has reloginInFlight):
	// the start queued for the lease, which the handover never frees, and
	// timed out after 3 minutes telling the human to start over.
	test("a human start queued behind the flow joins the handed-over login at once", async () => {
		const { idp, session } = harness();
		idp.afterEmail = "otp";
		const gate = deferred();
		idp.hold = gate.promise;
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		const started = session.login.start(EMAIL);
		await ticks();
		idp.hold = null;
		gate.resolve();
		expect((await flow).kind).toBe("needs_human");
		// No clock advance: the start must not sit out the lease wait.
		const state = await started;
		expect(state.phase).toBe("awaiting_otp");
		expect(idp.otpEmails).toBe(1);
		expect(idp.opens).toBe(1);
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
	});

	test("a captcha is handed over with its image and leads on to the code", async () => {
		const { idp, session } = harness();
		const target = ostoslistaTarget();
		idp.afterEmail = "captcha";
		await session.runSilentIdpFlow("ostoslista", target);
		const state = await session.login.state();
		expect(state.phase).toBe("awaiting_captcha");
		expect(state.captchaImageBase64).toBe("Y2FwdGNoYQ==");
		expect((await session.login.submitCaptcha("ABCD")).phase).toBe("awaiting_otp");
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(target.exchanged).toEqual([idp.callbackUrl]);
	});

	test("strong authentication approved on the phone lands on the callback", async () => {
		const { idp, session } = harness();
		const target = ostoslistaTarget();
		idp.afterEmail = "strong_auth";
		await session.runSilentIdpFlow("ostoslista", target);
		expect((await session.login.state()).phase).toBe("awaiting_strong_auth");
		idp.strongAuthApproved = true;
		expect((await session.login.waitForStrongAuthCompletion()).phase).toBe("logged_in");
		expect(target.exchanged).toEqual([idp.callbackUrl]);
	});

	test("cancel closes the handed-over page and keeps the block", async () => {
		const { idp, session } = harness();
		idp.afterEmail = "otp";
		await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect((await session.login.cancel()).phase).toBe("idle");
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		expect(session.report().autoRelogin.blockedReason).not.toBeNull();
	});

	test("a forgotten handed-over login is reaped after 10 minutes", async () => {
		const { idp, clock, session } = harness();
		idp.afterEmail = "otp";
		await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await clock.advance(10 * MINUTE);
		await ticks();
		expect(idp.pageOpen).toBe(false);
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });
		expect((await session.login.state()).error).toContain("expired");
	});

	test("a human start after a cancel opens S-Etukortti's own login, not the callback flow", async () => {
		const { site, idp, session } = harness();
		const target = ostoslistaTarget();
		site.alive = false;
		idp.afterEmail = "otp";
		await session.runSilentIdpFlow("ostoslista", target);
		await session.login.cancel();
		expect((await session.login.start(EMAIL)).phase).toBe("awaiting_otp");
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		expect(target.exchanged).toEqual([]);
		expect(site.alive).toBe(true);
	});
});

describe("ostoslista silent flow — IdP lease", () => {
	test("runs under the exclusive lease; a page capture waits for it", async () => {
		const { site, idp, session } = harness();
		const gate = deferred();
		idp.hold = gate.promise;
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		expect(session.report().idpLease.exclusive).toBe("ostoslista");
		const captured = session.capture("https://s.example/edut", isList);
		await ticks();
		expect(site.pageCaptures).toHaveLength(0);
		gate.resolve();
		expect((await flow).kind).toBe("callback");
		await expect(captured).resolves.toEqual({ items: [1] });
		expect(site.pageCaptures).toHaveLength(1);
	});

	test("a human login start waits for the flow, then opens its own page", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		const gate = deferred();
		idp.hold = gate.promise;
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		const started = session.login.start(EMAIL);
		await ticks();
		expect(idp.opens).toBe(1);
		gate.resolve();
		expect((await flow).kind).toBe("callback");
		idp.hold = null;
		idp.afterEmail = "otp";
		expect((await started).phase).toBe("awaiting_otp");
		expect(idp.opens).toBe(2);
		expect(idp.overlaps).toBe(0);
	});

	test("a relogin during a flow that hits a human step waits, then defers to the handed-over login", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		idp.afterEmail = "otp";
		const gate = deferred();
		idp.hold = gate.promise;
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		site.expire();
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		expect(idp.opens).toBe(1);
		gate.resolve();
		expect((await flow).kind).toBe("needs_human");
		await expectExpired(call, "login_in_progress");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
		expect(idp.overlaps).toBe(0);
	});

	test("a flow and a relogin with an alive SSO both succeed, one after the other", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		expect(session.report().idpLease.exclusive).toBe("silent_relogin");
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		expect(idp.callbackFlows).toHaveLength(0);
		gate.resolve();
		await expect(call).resolves.toEqual({ value: "ok" });
		expect((await flow).kind).toBe("callback");
		expect(idp.opens).toBe(2);
		expect(idp.overlaps).toBe(0);
	});

	test("a flow waiting behind a relogin that hands over to a human is declined", async () => {
		const { site, idp, session } = harness();
		site.expire();
		idp.afterEmail = "otp";
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await ticks();
		const flow = session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		await ticks();
		gate.resolve();
		await expectExpired(call, "needs_human");
		const outcome = await flow;
		expect(outcome.kind).toBe("declined");
		expect(idp.callbackFlows).toHaveLength(0);
		expect(idp.otpEmails).toBe(1);
		expect((await session.login.state()).phase).toBe("awaiting_otp");
	});
});
