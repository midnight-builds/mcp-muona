// tunnistus.s-ryhma.fi embeds a live sessionToken in every
// /redirect-to-strong-authentication link; strip it before any snapshot
// leaves the IdP adapter (logs, tool responses) since it's a bearer credential
// for the in-progress identification flow.
export function redactSessionTokens(text: string): string {
	return text.replace(/sessionToken=[^&\s"']+/g, "sessionToken=<redacted>");
}
