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
	START,
	ticks,
	useTempSettingsDb,
} from "./test-fakes.ts";

// The S-ostoslista silent flow through the session interface: the same gate
// and the exclusive IdP lease as the S-Etukortti relogin. No Playwright, no network.

const BodySchema = z.object({ value: z.string() });
const isList = (url: string) => url.includes("limit=");
const OSTOSLISTA = {
	startUrl: "https://kirjautuminen.s-ostoslista.fi/login",
	isCallback: (url: string) => url.includes("/callback?") && url.includes("nonce="),
};

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

	test("a human step sets the block, closes the page and returns needs_human", async () => {
		const { site, idp, session } = harness();
		idp.afterEmail = "otp";
		const outcome = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(outcome.kind).toBe("needs_human");
		if (outcome.kind === "needs_human") expect(outcome.detail).toContain("S-Etukortti");
		const blocked = session.report().autoRelogin.blockedReason;
		expect(blocked).toContain("S-ostoslista");
		expect(blocked).toContain("otp");
		expect(idp.pageOpen).toBe(false);
		// Not handed over: the human logs in through s_etukortti_login_*.
		expect((await session.login.state()).phase).toBe("idle");
		expect(session.report().idpLease).toEqual({ exclusive: null, shared: 0 });

		// The next S-Etukortti expiry mails no second one-time code.
		site.expire();
		await expectExpired(session.get("/a", {}, BodySchema), "blocked");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
		// Nor does a second S-ostoslista attempt.
		const again = await session.runSilentIdpFlow("ostoslista", OSTOSLISTA);
		expect(again.kind).toBe("declined");
		expect(idp.opens).toBe(1);
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

	test("a relogin during a flow that hits a human step waits, then is declined as blocked", async () => {
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
		await expectExpired(call, "blocked");
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
