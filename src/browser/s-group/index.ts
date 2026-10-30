// Composition root of the S-group session module: the only place that wires
// the production adapters together. Tests build their own instances with
// fakes through createSGroupSession().

import { systemClock } from "./clock.ts";
import { resolveKeepaliveHours } from "./config.ts";
import { playwrightSiteDriver } from "./playwright.ts";
import { playwrightIdpDriver } from "./playwright-idp.ts";
import { createSGroupSession } from "./session.ts";
import { settingsSessionStore } from "./store.ts";

export { LOGIN_INSTRUCTIONS, SessionExpiredError, type SessionExpiredReason } from "./errors.ts";
export { RELOGIN_COOLDOWN_MS, remainingMinutes } from "./gate.ts";
export type { LeaseHolder, LeaseReport } from "./lease.ts";
export type { LoginState, LoginSteps, StartOptions } from "./login.ts";
// Raw browser access, for the remote login screen only: it draws its outcome
// note in a local tab of this browser, which never navigates to S-group sites
// and so needs no IdP lease. Anything that navigates goes through sGroup.
export { getContext, ORIGIN } from "./playwright.ts";
export type { CallbackFlowTarget, LoginPhase } from "./ports.ts";
export type {
	AutoReloginInfo,
	KeepaliveInfo,
	SessionReport,
	SessionStatus,
	SGroupSession,
} from "./session.ts";
export type { SilentIdpFlowName, SilentIdpFlowOutcome } from "./silent-flow.ts";

export const sGroup = createSGroupSession(
	{
		site: playwrightSiteDriver,
		idp: playwrightIdpDriver,
		store: settingsSessionStore,
		clock: systemClock,
	},
	{ keepaliveHours: resolveKeepaliveHours(process.env.S_ETUKORTTI_KEEPALIVE_HOURS) },
);
