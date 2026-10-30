import { describe, expect, test } from "bun:test";
import { decideRelogin, type ReloginSnapshot } from "./gate.ts";

// The hourly auto-sync hits a 401 at 59:59 after the previous relogin; a
// cooldown that counted successful attempts skipped every other sync
// (seen 2026-10-29). Failures hold back the next attempt for 20 minutes, so a
// single transient failure costs one hourly sync, not two.
describe("decideRelogin cooldown boundaries", () => {
	const now = Date.parse("2026-10-29T05:00:37Z");
	const minutesAgo = (m: number) => now - m * 60_000;
	const snapshot = (
		lastAttempt: ReloginSnapshot["lastAttempt"],
		more: Partial<ReloginSnapshot> = {},
	): ReloginSnapshot => ({
		blockedReason: null,
		lastAttempt,
		loginCompletedSinceAttempt: false,
		lastReloginSucceededAt: lastAttempt?.outcome === "logged_in" ? lastAttempt.at : null,
		appSessionRefused: true,
		savedEmail: "user@example.com",
		humanLoginActive: false,
		...more,
	});
	const kind = (s: ReloginSnapshot) => {
		const decision = decideRelogin(s, now);
		return decision.kind === "attempt" ? "attempt" : decision.reason;
	};

	test("no previous attempt never cools down", () => {
		expect(kind(snapshot(null))).toBe("attempt");
	});

	test("a successful attempt just under an hour ago does not block the next one", () => {
		expect(kind(snapshot({ at: now - 59 * 60_000 - 59_000, outcome: "logged_in" }))).toBe(
			"attempt",
		);
	});

	test("a failed attempt within 20 minutes blocks", () => {
		expect(kind(snapshot({ at: minutesAgo(19), outcome: "failed" }))).toBe("cooling_down");
	});

	test("an attempt that never reported an outcome (threw) counts as failed", () => {
		expect(kind(snapshot({ at: minutesAgo(10), outcome: null }))).toBe("cooling_down");
	});

	test("a failed attempt over 20 minutes ago no longer blocks", () => {
		expect(kind(snapshot({ at: minutesAgo(21), outcome: "failed" }))).toBe("attempt");
	});

	test("a cooldown decline says what caused it and how long is left", () => {
		const failed = decideRelogin(snapshot({ at: minutesAgo(5), outcome: "failed" }), now);
		expect(failed).toMatchObject({
			kind: "decline",
			reason: "cooling_down",
			hold: { lastOutcome: "failed", remainingMinutes: 15 },
		});
		const threw = decideRelogin(snapshot({ at: minutesAgo(5), outcome: null }), now);
		expect(threw).toMatchObject({ hold: { lastOutcome: "threw" } });
	});

	// A relogin handed over at a human step and then finished by the human,
	// or any login after a failed relogin, says the failure is over.
	test("a login completed after the failed attempt lifts the cooldown", () => {
		const handedOver = { at: minutesAgo(5), outcome: "awaiting_otp" } as const;
		expect(kind(snapshot(handedOver, { loginCompletedSinceAttempt: true }))).toBe("attempt");
		expect(kind(snapshot({ at: minutesAgo(5), outcome: "failed" }))).toBe("cooling_down");
	});

	// An endpoint that keeps answering 401/403 for a reason no relogin fixes
	// must not run a full IdP flow per call.
	test("a relogin within 10 minutes of a successful one is declined", () => {
		const decision = decideRelogin(snapshot({ at: minutesAgo(4), outcome: "logged_in" }), now);
		expect(decision).toMatchObject({
			kind: "decline",
			reason: "still_unauthorized",
			hold: { lastOutcome: "logged_in", remainingMinutes: 6 },
		});
		expect(kind(snapshot({ at: minutesAgo(11), outcome: "logged_in" }))).toBe("attempt");
	});

	// The attempt may have waited minutes for the IdP lease before succeeding.
	test("the 10 minutes run from when the relogin succeeded, not when it began", () => {
		const late = snapshot(
			{ at: minutesAgo(12), outcome: "logged_in" },
			{ lastReloginSucceededAt: minutesAgo(7) },
		);
		expect(kind(late)).toBe("still_unauthorized");
	});

	// A CSRF refresh that answers logged out means the app session is really
	// gone, so a relogin can help even right after a successful one.
	test("a really logged-out app session may relogin inside the 10 minutes", () => {
		const loggedOut = snapshot(
			{ at: minutesAgo(2), outcome: "logged_in" },
			{ appSessionRefused: false },
		);
		expect(kind(loggedOut)).toBe("attempt");
	});

	test("a human login in progress wins over every other reason", () => {
		expect(
			kind({
				...snapshot({ at: minutesAgo(1), outcome: null }),
				blockedReason: "x",
				humanLoginActive: true,
			}),
		).toBe("login_in_progress");
	});
});
