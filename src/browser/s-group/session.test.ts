import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as z from "zod/v4";
import { logger } from "../../logger.ts";
import { setSetting } from "../../store/settings.ts";
import { ProfileLockedError } from "../profile-lock.ts";
import { SessionExpiredError } from "./errors.ts";
import {
	RELOGIN_BLOCK_SETTING_KEY,
	SAVED_EMAIL_SETTING_KEY,
	settingsSessionStore,
} from "./store.ts";
import {
	deferred,
	EMAIL,
	expectExpired,
	HOUR,
	harness,
	MINUTE,
	ostoslistaTarget,
	START,
	tick,
	ticks,
	useTempSettingsDb,
} from "./test-fakes.ts";

// Everything here runs against scripted fakes: no Playwright, no network.

const BodySchema = z.object({ value: z.string() });

useTempSettingsDb();

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

// The [fields, message] pairs a logger method was called with.
function logCalls(level: "info" | "warn"): { calls: unknown[][] } {
	const spy = spyOn(logger, level);
	spies.push(spy);
	return spy.mock;
}

const logged = (mock: { calls: unknown[][] }, message: string) =>
	mock.calls.filter((call) => call.includes(message)).map((call) => call[0]);

describe("get — token cell", () => {
	test("fetches a CSRF token once and reuses it across calls", async () => {
		const { site, session } = harness();
		expect(await session.get("/a", {}, BodySchema)).toEqual({ value: "ok" });
		await session.get("/b", {}, BodySchema);
		expect(site.csrfFetches).toBe(1);
		expect(site.apiCalls.map((c) => c.token)).toEqual(["t1", "t1"]);
	});

	test("parallel first calls share a single token refresh", async () => {
		const { site, session } = harness();
		await Promise.all([1, 2, 3, 4].map((i) => session.get(`/p${i}`, {}, BodySchema)));
		expect(site.csrfFetches).toBe(1);
		expect(session.report().appSession.tokenGeneration).toBe(1);
	});

	test("a locked browser profile is not retried through the page sniff", async () => {
		const { site, session } = harness();
		site.fastPathError = new ProfileLockedError(4242, "2026-10-29T08:00:00.000Z", "/profile");
		const err = await session.get("/a", {}, BodySchema).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ProfileLockedError);
		expect(site.csrfSniffs).toBe(0);
	});

	test("a failing fast path falls back to the page sniff", async () => {
		const { site, session } = harness();
		site.fastPathThrows = true;
		await session.get("/a", {}, BodySchema);
		expect(site.csrfFetches).toBe(1);
		expect(site.csrfSniffs).toBe(1);
	});

	test("a logged-out fast path does not fall back to the page sniff", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "unexpected";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		expect(site.csrfSniffs).toBe(0);
	});

	test("a closed browser context invalidates the token without a relogin", async () => {
		const { site, idp, session } = harness();
		await session.get("/a", {}, BodySchema);
		site.emitContextClosed();
		await session.get("/b", {}, BodySchema);
		expect(site.csrfFetches).toBe(2);
		expect(idp.opens).toBe(0);
	});
});

describe("get — errors that are not auth failures", () => {
	test("HTTP 5xx passes through unchanged and is not retried", async () => {
		const { site, idp, session } = harness();
		site.apiStatus = 503;
		await expect(session.get("/api/v1/receipts", {}, BodySchema)).rejects.toThrow(
			"S-Etukortti API HTTP 503 for /api/v1/receipts",
		);
		expect(site.apiCalls).toHaveLength(1);
		expect(idp.opens).toBe(0);
	});

	test("a Zod mismatch passes through as a ZodError and is not retried", async () => {
		const { site, session } = harness();
		site.apiBody = { value: 42 };
		await expect(session.get("/a", {}, BodySchema)).rejects.toBeInstanceOf(z.ZodError);
		expect(site.apiCalls).toHaveLength(1);
	});

	test("a network error from the API passes through unchanged", async () => {
		const { site, session } = harness();
		site.apiGet = async () => {
			throw new Error("ECONNRESET");
		};
		await expect(session.get("/a", {}, BodySchema)).rejects.toThrow("ECONNRESET");
	});
});

describe("relogin — single flight (I2)", () => {
	test("N parallel calls on an expired app session share exactly one relogin", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const results = await Promise.all(
			[1, 2, 3, 4, 5, 6].map((i) => session.get(`/p${i}`, {}, BodySchema)),
		);
		expect(results).toHaveLength(6);
		expect(idp.emails).toEqual([EMAIL]);
	});

	test("N parallel first calls with no token share exactly one relogin", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		await Promise.all([1, 2, 3].map((i) => session.get(`/p${i}`, {}, BodySchema)));
		expect(idp.opens).toBe(1);
	});

	test("callers that hit the expiry while the relogin runs wait for it", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const first = session.get("/first", {}, BodySchema);
		await tick();
		await tick();
		await tick();
		expect(idp.opens).toBe(1);
		const late = session.get("/late", {}, BodySchema);
		await tick();
		gate.resolve();
		await expect(Promise.all([first, late])).resolves.toHaveLength(2);
		expect(idp.opens).toBe(1);
	});

	test("a caller whose failure is stale retries at once without a relogin", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const slow = deferred();
		site.holds.set("/slow", slow.promise);
		// Sent with t1 while the app session is dead, answered only later.
		const stale = session.get("/slow", {}, BodySchema);
		await tick();
		await session.get("/fast", {}, BodySchema);
		expect(idp.opens).toBe(1);
		site.holds.delete("/slow");
		slow.resolve();
		await expect(stale).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(1);
		expect(site.apiCalls.filter((c) => c.path === "/slow").map((c) => c.token)).toEqual([
			"t1",
			"t2",
		]);
	});

	test("a stale invalidation does not discard the newer token", async () => {
		const { site, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const slow = deferred();
		site.holds.set("/slow", slow.promise);
		const stale = session.get("/slow", {}, BodySchema);
		await tick();
		await session.get("/fast", {}, BodySchema);
		const fetchesAfterRecovery = site.csrfFetches;
		site.holds.delete("/slow");
		slow.resolve();
		await stale;
		await session.get("/after", {}, BodySchema);
		expect(site.csrfFetches).toBe(fetchesAfterRecovery);
		expect(session.report().appSession.hasToken).toBe(true);
	});

	test("a second unauthorized answer throws still_unauthorized after one relogin", async () => {
		const { site, idp, session } = harness();
		site.rejectAllApiCalls = true;
		await expectExpired(session.get("/a", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(1);
		expect(site.apiCalls).toHaveLength(2);
	});
});

describe("capture", () => {
	const isList = (url: string) => url.includes("limit=");

	test("resolves with the body of the first matching response", async () => {
		const { site, idp, session } = harness();
		expect(await session.capture("https://s.example/edut", isList)).toEqual({ items: [1] });
		expect(site.pageCaptures).toEqual([{ url: "https://s.example/edut", timeoutMs: undefined }]);
		expect(idp.opens).toBe(0);
	});

	test("passes the timeout option on to the page driver", async () => {
		const { site, session } = harness();
		await session.capture("https://s.example/edut", isList, { timeoutMs: 5_000 });
		expect(site.pageCaptures[0]?.timeoutMs).toBe(5_000);
	});

	test("a logged-out page triggers one relogin and a successful retry", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		expect(await session.capture("https://s.example/edut", isList)).toEqual({ items: [1] });
		expect(idp.emails).toEqual([EMAIL]);
		expect(site.pageCaptures).toHaveLength(2);
	});

	test("a second logged-out page throws still_unauthorized after one relogin", async () => {
		const { site, idp, session } = harness();
		site.rejectAllApiCalls = true;
		await expectExpired(session.capture("https://s.example/edut", isList), "still_unauthorized");
		expect(idp.opens).toBe(1);
		expect(site.pageCaptures).toHaveLength(2);
	});

	test("a timeout passes through unchanged without a relogin or retry", async () => {
		const { site, idp, session } = harness();
		site.pageError = new Error("page loaded but the response never came");
		const err = await session.capture("https://s.example/edut", isList).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SessionExpiredError);
		expect(idp.opens).toBe(0);
		expect(site.pageCaptures).toHaveLength(1);
	});

	test("a declined relogin surfaces its reason", async () => {
		const { site, session } = harness();
		site.alive = false;
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "human needed");
		await expectExpired(session.capture("https://s.example/edut", isList), "blocked");
	});

	test("parallel capture and get on an expired session share one relogin", async () => {
		const { site, idp, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const [captured, got] = await Promise.all([
			session.capture("https://s.example/edut", isList),
			session.get("/a", {}, BodySchema),
		]);
		expect(captured).toEqual({ items: [1] });
		expect(got).toEqual({ value: "ok" });
		expect(idp.opens).toBe(1);
	});
});

describe("relogin gate (I3)", () => {
	test("no saved email declines with no_saved_email and records no attempt", async () => {
		setSetting(SAVED_EMAIL_SETTING_KEY, "");
		const { site, idp, session } = harness();
		site.alive = false;
		await expectExpired(session.get("/a", {}, BodySchema), "no_saved_email");
		expect(idp.opens).toBe(0);
		expect(session.report().autoRelogin.lastAttemptAt).toBeNull();
		expect(session.report().autoRelogin.lastOutcome).toBeNull();
	});

	test("an active human login declines with login_in_progress", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await session.login.start(EMAIL);
		await expectExpired(session.get("/a", {}, BodySchema), "login_in_progress");
		expect(idp.opens).toBe(1);
	});

	test("reaching a human step sets the block; later expiries start no login", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await expectExpired(session.get("/a", {}, BodySchema), "needs_human");
		expect(session.report().autoRelogin.blockedReason).toContain("awaiting_otp");
		// The open page was handed to a human login, which now holds the IdP.
		await expectExpired(session.get("/b", {}, BodySchema), "login_in_progress");
		await session.login.cancel();
		await expectExpired(session.get("/c", {}, BodySchema), "blocked");
		expect(idp.opens).toBe(1);
		expect(idp.otpEmails).toBe(1);
	});

	test("the block persists across a new instance on the same DB", async () => {
		const first = harness();
		first.site.alive = false;
		first.idp.afterEmail = "captcha";
		await expectExpired(first.session.get("/a", {}, BodySchema), "needs_human");

		const second = harness();
		second.site.alive = false;
		expect(second.session.report().autoRelogin.blockedReason).toContain("awaiting_captcha");
		await expectExpired(second.session.get("/a", {}, BodySchema), "blocked");
		expect(second.idp.opens).toBe(0);
	});

	test("a block stored by an earlier process declines before any login starts", async () => {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		const { site, idp, session } = harness();
		site.alive = false;
		await expectExpired(session.get("/a", {}, BodySchema), "blocked");
		expect(idp.opens).toBe(0);
	});

	test("a successful relogin starts no cooldown", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		await session.get("/a", {}, BodySchema);
		expect(session.report().autoRelogin.lastOutcome).toBe("logged_in");
		// The app session dies within the hour while the SSO session lives on.
		await clock.advance(59 * 60_000 + 59_000);
		site.expire();
		await session.get("/b", {}, BodySchema);
		expect(idp.opens).toBe(2);
	});

	test("a failed relogin starts the cooldown; it lifts after 20 minutes", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		idp.afterEmail = "unexpected";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		await clock.advance(10 * 60_000);
		await expectExpired(session.get("/b", {}, BodySchema), "cooling_down");
		expect(idp.opens).toBe(1);
		await clock.advance(11 * 60_000);
		idp.afterEmail = "sso_alive";
		await expect(session.get("/c", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(2);
	});

	// A WAF or a forbidden resource answers 401/403 while the app session is
	// fine; without a floor every get() ran a full silent IdP flow.
	test("a persistent 403 within 10 minutes of a relogin fails without a second flow", async () => {
		const { site, idp, clock, session } = harness();
		site.rejectAllApiCalls = true;
		await expectExpired(session.get("/a", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(1);
		const info = logCalls("info");
		await expectExpired(session.get("/b", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(1);
		expect(
			logged(info, "Relogin held after a recent success; retrying with the new token"),
		).toEqual([expect.objectContaining({ lastOutcome: "logged_in", remainingMinutes: 10 })]);
		await clock.advance(11 * MINUTE);
		await expectExpired(session.get("/c", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(2);
	});

	// The hold's own CSRF refresh issued a new token: the 401 was a stale
	// token, and a retry with the new one is all the call needs.
	test("a stale token within 10 minutes of a relogin succeeds on the new token", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		await session.get("/a", {}, BodySchema);
		expect(idp.opens).toBe(1);
		await clock.advance(2 * MINUTE);
		site.validToken = null;
		await expect(session.get("/b", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(1);
	});

	test("a human login after a successful relogin lifts the 10-minute hold", async () => {
		const { site, idp, session } = harness();
		site.rejectAllApiCalls = true;
		await expectExpired(session.get("/a", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(1);
		expect((await session.login.start(EMAIL)).phase).toBe("logged_in");
		expect(idp.opens).toBe(2);
		await expectExpired(session.get("/b", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(3);
	});

	test("the 10 minutes after a relogin run from its completion", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		site.rejectAllApiCalls = true;
		const held = deferred();
		idp.hold = held.promise;
		const first = session.get("/a", {}, BodySchema);
		await ticks();
		await clock.advance(5 * MINUTE);
		idp.hold = null;
		held.resolve();
		await expectExpired(first, "still_unauthorized");
		await clock.advance(7 * MINUTE);
		await expectExpired(session.get("/b", {}, BodySchema), "still_unauthorized");
		expect(idp.opens).toBe(1);
	});

	test("a real logout right after a relogin still gets a relogin", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		await session.get("/a", {}, BodySchema);
		expect(idp.opens).toBe(1);
		await clock.advance(2 * MINUTE);
		site.expire();
		await expect(session.get("/b", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		expect(idp.opens).toBe(2);
	});

	// Ordered by sequence, not by clock: a login completing in the same
	// millisecond a later relogin starts must not wipe that relogin's failure.
	test("a failed relogin right after a completed login still cools down", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "otp";
		await session.login.start(EMAIL);
		expect((await session.login.submitOtp("123456")).phase).toBe("logged_in");
		site.expire();
		idp.afterEmail = "unexpected";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		await expectExpired(session.get("/b", {}, BodySchema), "cooling_down");
		expect(idp.opens).toBe(2);
	});

	test("a cooldown decline logs the outcome behind it and the minutes left", async () => {
		const { site, idp, clock, session } = harness();
		site.alive = false;
		idp.afterEmail = "unexpected";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		await clock.advance(5 * MINUTE);
		const info = logCalls("info");
		await expectExpired(session.get("/b", {}, BodySchema), "cooling_down");
		expect(logged(info, "Relogin declined")).toEqual([
			expect.objectContaining({
				reason: "cooling_down",
				lastOutcome: "failed",
				remainingMinutes: 15,
			}),
		]);
	});

	test("a thrown relogin attempt counts as failed and starts the cooldown", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		idp.afterEmail = "throw";
		await expectExpired(session.get("/a", {}, BodySchema), "relogin_failed");
		expect(session.report().autoRelogin.lastAttemptAt).not.toBeNull();
		expect(session.report().autoRelogin.lastOutcome).toBeNull();
		await expectExpired(session.get("/b", {}, BodySchema), "cooling_down");
		expect(idp.opens).toBe(1);
	});
});

describe("keepalive", () => {
	test("is not armed before the first successful token refresh", async () => {
		const { site, clock, session } = harness();
		await clock.advance(48 * HOUR);
		expect(site.csrfFetches + site.csrfSniffs).toBe(0);
		expect(session.report().appSession.keepaliveArmed).toBe(false);
	});

	test("ticks every keepaliveHours through the page sniff and records the outcome", async () => {
		const { site, clock, session } = harness({ keepaliveHours: 2 });
		await session.get("/warm", {}, BodySchema);
		expect(session.report().appSession.keepaliveArmed).toBe(true);
		await clock.advance(2 * HOUR - 60_000);
		expect(site.csrfSniffs).toBe(0);
		await clock.advance(60_000);
		expect(site.csrfSniffs).toBe(1);
		const info = session.report().keepalive;
		expect(info?.ok).toBe(true);
		expect(info?.outcome).toBe("refreshed");
		expect(info?.at).toBe(new Date(START + 2 * HOUR).toISOString());
		expect(session.report().appSession.tokenGeneration).toBe(2);
		await session.get("/after", {}, BodySchema);
		expect(site.apiCalls.at(-1)?.token).toBe("t2");
	});

	test("a tick on an expired app session recovers through the relogin", async () => {
		const { site, idp, clock, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		await clock.advance(6 * HOUR);
		expect(idp.opens).toBe(1);
		expect(session.report().keepalive?.outcome).toBe("recovered");
		expect(session.report().keepalive?.ok).toBe(true);
	});

	test("a tick declined by the block records a failure and starts no login", async () => {
		const { site, idp, clock, session } = harness();
		await session.get("/warm", {}, BodySchema);
		setSetting(RELOGIN_BLOCK_SETTING_KEY, "stopped at awaiting_otp");
		site.expire();
		await clock.advance(6 * HOUR);
		expect(idp.opens).toBe(0);
		const info = session.report().keepalive;
		expect(info?.ok).toBe(false);
		expect(info?.outcome).toBe("failed");
		expect(info?.error).toContain("blocked");
	});

	// The relogin succeeded but the app session was gone again by the time the
	// tick looked: that is no recovery.
	test("a tick that is still logged out after the relogin records a failure", async () => {
		const { site, idp, clock, session } = harness({
			store: (fakeSite) => ({
				...settingsSessionStore,
				recordLogin(kind, nowMs) {
					fakeSite.expire();
					fakeSite.emitContextClosed();
					return settingsSessionStore.recordLogin(kind, nowMs);
				},
			}),
		});
		await session.get("/warm", {}, BodySchema);
		site.expire();
		await clock.advance(6 * HOUR);
		expect(idp.opens).toBe(1);
		const info = session.report().keepalive;
		expect(info?.outcome).toBe("failed");
		expect(info?.ok).toBe(false);
		expect(info?.error).toContain("401");
	});

	// Only a human login holding the lease makes a skip; a silent flow that
	// outlasts the lease wait is a failure to keep the session alive.
	test("a tick that times out waiting for a silent flow records a failure", async () => {
		const { idp, clock, session } = harness({ keepaliveHours: 0.1 });
		await session.get("/warm", {}, BodySchema);
		const flowHeld = deferred();
		idp.hold = flowHeld.promise;
		const flow = session.runSilentIdpFlow("ostoslista", ostoslistaTarget());
		await ticks();
		expect(session.report().idpLease.exclusive).toBe("ostoslista");
		const ticking = clock.advance(6 * MINUTE);
		await ticks();
		await clock.advance(3 * MINUTE);
		await ticking;
		const info = session.report().keepalive;
		expect(info?.outcome).toBe("failed");
		expect(info?.ok).toBe(false);
		idp.hold = null;
		flowHeld.resolve();
		await flow;
	});

	// The gate declines with login_in_progress while any human login is
	// active, also one still queued for the lease behind a silent flow.
	test("a tick that times out while a human login is queued is recorded as skipped", async () => {
		const { idp, clock, session } = harness({ keepaliveHours: 0.1 });
		await session.get("/warm", {}, BodySchema);
		await clock.advance(5 * MINUTE);
		const flowHeld = deferred();
		idp.hold = flowHeld.promise;
		const flow = session.runSilentIdpFlow("ostoslista", ostoslistaTarget());
		await ticks();
		const ticking = clock.advance(MINUTE);
		await ticks();
		await clock.advance(MINUTE);
		const started = session.login.start(EMAIL);
		await ticks();
		await clock.advance(2 * MINUTE);
		await ticking;
		expect(session.report().keepalive?.outcome).toBe("skipped");
		idp.hold = null;
		flowHeld.resolve();
		await flow;
		await started;
	});

	test("a tick during a running relogin joins it instead of starting another", async () => {
		const { site, idp, clock, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.expire();
		const gate = deferred();
		idp.hold = gate.promise;
		const call = session.get("/a", {}, BodySchema);
		await tick();
		await tick();
		await tick();
		const advanced = clock.advance(6 * HOUR);
		await tick();
		gate.resolve();
		await Promise.all([call, advanced]);
		expect(idp.opens).toBe(1);
		expect(session.report().keepalive?.ok).toBe(true);
	});

	test("close cancels the keepalive and closes the site driver", async () => {
		const { site, clock, session } = harness();
		await session.get("/warm", {}, BodySchema);
		expect(clock.pending()).toBe(1);
		await session.close();
		expect(clock.pending()).toBe(0);
		expect(site.closed).toBe(1);
		expect(session.report().appSession.hasToken).toBe(false);
	});
});

describe("probe", () => {
	test("reports logged in using the cached token", async () => {
		const { site, session } = harness();
		await session.get("/warm", {}, BodySchema);
		expect(await session.probe()).toEqual({ loggedIn: true });
		expect(site.csrfFetches).toBe(1);
		expect(site.apiCalls.at(-1)?.path).toBe("/api/v1/bonus-levels");
	});

	test("reports the expiry reason instead of throwing", async () => {
		setSetting(SAVED_EMAIL_SETTING_KEY, "");
		const { site, session } = harness();
		site.alive = false;
		const status = await session.probe();
		expect(status.loggedIn).toBe(false);
		if (!status.loggedIn) {
			expect(status.expiredReason).toBe("no_saved_email");
			expect(status.instructions).toContain("bun run login");
		}
	});

	test("logs an expiry as not logged in and anything else as a failed probe", async () => {
		const { site, session } = harness();
		const info = logCalls("info");
		const warn = logCalls("warn");
		site.apiStatus = 503;
		expect((await session.probe()).loggedIn).toBe(false);
		expect(logged(warn, "S-Etukortti session probe failed")).toHaveLength(1);
		expect(logged(info, "S-Etukortti session probe: not logged in")).toHaveLength(0);

		site.apiStatus = null;
		setSetting(SAVED_EMAIL_SETTING_KEY, "");
		site.alive = false;
		expect((await session.probe()).loggedIn).toBe(false);
		expect(logged(info, "S-Etukortti session probe: not logged in")).toEqual([
			expect.objectContaining({ expiredReason: "no_saved_email" }),
		]);
		expect(logged(warn, "S-Etukortti session probe failed")).toHaveLength(1);
	});

	test("only writes the token through the single-flight refresh", async () => {
		const { site, session } = harness();
		await session.get("/warm", {}, BodySchema);
		site.emitContextClosed();
		await Promise.all([1, 2, 3].map(() => session.probe()));
		expect(site.csrfFetches).toBe(2);
		expect(session.report().appSession.tokenGeneration).toBe(2);
		await session.get("/after", {}, BodySchema);
		expect(site.apiCalls.at(-1)?.token).toBe("t2");
	});

	test("a relogin verifies its own landing without deadlocking on itself", async () => {
		const { site, idp, session } = harness();
		site.alive = false;
		await expect(session.get("/a", {}, BodySchema)).resolves.toEqual({ value: "ok" });
		// One logged-out answer, then the fresh token that confirmed the landing.
		expect(site.csrfFetches).toBe(2);
		expect(site.apiCalls.map((c) => c.path)).toEqual(["/a"]);
		expect(idp.opens).toBe(1);
	});
});

// A token request sent before a login landed answers "logged out"; a login
// verifying itself must not take that stale answer as its own (seen in review:
// it turned a working silent login into relogin_failed plus a cooldown).
describe("fresh refresh after a login", () => {
	test("does not join a refresh that started before the login landed", async () => {
		const { site, idp, session } = harness();
		site.expire();
		const loginHeld = deferred();
		idp.hold = loginHeld.promise;
		const first = session.get("/a", {}, BodySchema);
		await ticks();
		expect(idp.opens).toBe(1);

		// A second caller asks for a token while the silent login is running.
		const staleCsrf = deferred();
		site.csrfHold = staleCsrf.promise;
		const second = session.get("/b", {}, BodySchema);
		await ticks();

		loginHeld.resolve();
		await ticks();
		site.csrfHold = null;
		staleCsrf.resolve();

		await expect(first).resolves.toEqual({ value: "ok" });
		await expect(second).resolves.toEqual({ value: "ok" });
		expect(session.report().autoRelogin.lastOutcome).toBe("logged_in");
		expect(idp.opens).toBe(1);
	});
});

describe("report", () => {
	test("exposes relogin info for session_status", async () => {
		const { site, session } = harness();
		site.alive = false;
		await session.get("/a", {}, BodySchema);
		const { autoRelogin } = session.report();
		expect(autoRelogin.lastAttemptAt).toBe(new Date(START).toISOString());
		expect(autoRelogin.lastOutcome).toBe("logged_in");
		expect(autoRelogin.blockedReason).toBeNull();
	});
});
