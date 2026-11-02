// MCP tool annotations: hints clients use to tell lookups from changes (e.g.
// to ask before a write). A tool without them reads as the spec's worst case,
// destructive and not idempotent; src/tools/annotations.test.ts requires them.
// "Local" tools touch only Muona's own database, not an outside service.
// READ means the user's data is left as it is, not that nothing happens: an
// S-Etukortti or S-ostoslista read renews an expired session by itself, and
// when the S-tunnus SSO is gone too that silent login can email one code (once
// per expiry, the same the keepalive would send).

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const LOCAL_READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const LOCAL_WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false,
} as const;
export const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
} as const;
