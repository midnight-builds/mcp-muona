import type { LoginPhase } from "./ports.ts";

export type ReloginSnapshot = {
	blockedReason: string | null;
	lastAttempt: { at: number; outcome: LoginPhase | null } | null;
	// A login (human, manual or relogin) completed after lastAttempt started,
	// so a failure of that attempt no longer says anything about the session.
	// Ordered by event, not clock: both may fall in the same millisecond.
	loginCompletedSinceAttempt: boolean;
	// When the last successful relogin completed.
	lastReloginSucceededAt: number | null;
	// The latest CSRF refresh issued a token and the API refused it (401/403):
	// the app session looks alive, so a relogin would not change anything.
	appSessionRefused: boolean;
	savedEmail: string | null;
	humanLoginActive: boolean;
};

// Why the last attempt holds the next one back: its outcome ("threw" when it
// never reported one) and the whole minutes left, for the decline log.
export type ReloginHold = { lastOutcome: LoginPhase | "threw"; remainingMinutes: number };

export type ReloginDecision =
	| { kind: "attempt"; email: string }
	| {
			kind: "decline";
			reason:
				| "login_in_progress"
				| "blocked"
				| "cooling_down"
				| "still_unauthorized"
				| "no_saved_email";
			detail: string;
			hold?: ReloginHold;
	  };

// Successes don't cool down for long: the S-Etukortti app session dies in
// under an hour while the SSO session lives on, so the hourly sync needs a
// fresh silent login each time; a cooldown counting successes skipped every
// other sync. Failures (network error, site hiccup) wait, since each attempt
// drives the real login flow; 20 minutes, well under the hourly sync, so one
// transient failure costs one sync, not two.
export const RELOGIN_COOLDOWN_MS = 20 * 60 * 1000;

// A relogin that just succeeded and still gets 401/403 was not the fix (a
// WAF, a forbidden resource); without this floor every call, and every
// receipt of a sync, would run its own IdP flow.
export const RELOGIN_MIN_INTERVAL_MS = 10 * 60 * 1000;

export const remainingMinutes = (until: number, now: number): number =>
	Math.ceil((until - now) / 60_000);

// Pure on purpose: the whole relogin policy is in one place and needs no
// browser, DB or timer to test.
export function decideRelogin(snapshot: ReloginSnapshot, now: number): ReloginDecision {
	if (snapshot.humanLoginActive) {
		return {
			kind: "decline",
			reason: "login_in_progress",
			detail:
				"A human login is in progress; finish it with the s_etukortti_login_* tools before retrying.",
		};
	}
	if (snapshot.blockedReason) {
		return {
			kind: "decline",
			reason: "blocked",
			detail: `Relogin blocked until a human login: ${snapshot.blockedReason}`,
		};
	}
	const succeededAt = snapshot.lastReloginSucceededAt;
	if (
		succeededAt !== null &&
		snapshot.appSessionRefused &&
		now - succeededAt < RELOGIN_MIN_INTERVAL_MS
	) {
		const until = succeededAt + RELOGIN_MIN_INTERVAL_MS;
		return {
			kind: "decline",
			reason: "still_unauthorized",
			detail:
				`Still unauthorized right after a successful relogin at ${new Date(succeededAt).toISOString()}, ` +
				"so another relogin would not help; the next one is allowed after " +
				`${new Date(until).toISOString()}.`,
			hold: { lastOutcome: "logged_in", remainingMinutes: remainingMinutes(until, now) },
		};
	}
	const last = snapshot.lastAttempt;
	if (
		last &&
		last.outcome !== "logged_in" &&
		!snapshot.loginCompletedSinceAttempt &&
		now - last.at < RELOGIN_COOLDOWN_MS
	) {
		const until = last.at + RELOGIN_COOLDOWN_MS;
		return {
			kind: "decline",
			reason: "cooling_down",
			detail:
				`Relogin cooling down after a failed attempt at ${new Date(last.at).toISOString()}; ` +
				`next attempt allowed after ${new Date(until).toISOString()}.`,
			hold: {
				lastOutcome: last.outcome ?? "threw",
				remainingMinutes: remainingMinutes(until, now),
			},
		};
	}
	if (!snapshot.savedEmail) {
		return {
			kind: "decline",
			reason: "no_saved_email",
			detail: "No saved login email, so a relogin is not possible.",
		};
	}
	return { kind: "attempt", email: snapshot.savedEmail };
}
