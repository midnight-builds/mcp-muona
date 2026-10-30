// Timestamps of S-Etukortti logins, kept so the logs can tell how long the
// tunnistus.s-ryhma.fi SSO session actually lives: a "silent_sso" login means
// the SSO was still alive (email only), "human" means someone did OTP/strong
// auth. When an automatic re-login later hits an OTP prompt, the SSO lifetime
// lies between hoursSinceSilentLogin and hoursSinceHumanLogin.

import { getSetting, setSetting } from "./settings.ts";

export type LoginKind = "human" | "silent_sso";

const KEYS: Record<LoginKind, string> = {
	human: "lifetime.etukortti.lastHumanLoginAt",
	silent_sso: "lifetime.etukortti.lastSilentLoginAt",
};

export type LoginAges = {
	lastHumanLoginAt: string | null;
	lastSilentLoginAt: string | null;
	hoursSinceHumanLogin: number | null;
	hoursSinceSilentLogin: number | null;
};

export function hoursBetween(fromIso: string | null, nowMs: number): number | null {
	if (!fromIso) return null;
	const from = Date.parse(fromIso);
	if (Number.isNaN(from)) return null;
	return Math.round(((nowMs - from) / 3_600_000) * 10) / 10;
}

export function getLoginAges(nowMs = Date.now()): LoginAges {
	const lastHumanLoginAt = getSetting(KEYS.human);
	const lastSilentLoginAt = getSetting(KEYS.silent_sso);
	return {
		lastHumanLoginAt,
		lastSilentLoginAt,
		hoursSinceHumanLogin: hoursBetween(lastHumanLoginAt, nowMs),
		hoursSinceSilentLogin: hoursBetween(lastSilentLoginAt, nowMs),
	};
}

// Returns the ages as they were just before this login, which is what the
// caller wants to log ("previous human login was N hours ago").
export function recordLogin(kind: LoginKind, nowMs = Date.now()): LoginAges {
	const before = getLoginAges(nowMs);
	setSetting(KEYS[kind], new Date(nowMs).toISOString());
	return before;
}
