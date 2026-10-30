export const LOGIN_INSTRUCTIONS =
	"S-Etukortti session is missing or expired. A human must log in: through the " +
	"s_etukortti_login_* MCP tools while the server runs, or with `bun run login` in the " +
	"project root only when the server is stopped (both use the same browser profile). " +
	"Then retry. Do not attempt to automate the login or the OTP code.";

export type SessionExpiredReason =
	| "needs_human"
	| "blocked"
	| "cooling_down"
	| "no_saved_email"
	| "login_in_progress"
	| "relogin_failed"
	| "still_unauthorized";

// The class name is load-bearing: sync and the tools catch it by type.
export class SessionExpiredError extends Error {
	readonly reason: SessionExpiredReason;

	constructor(reason: SessionExpiredReason, detail: string) {
		super(`${detail} ${LOGIN_INSTRUCTIONS}`);
		this.name = "SessionExpiredError";
		this.reason = reason;
	}
}
