# CLAUDE.md

## Project

**Muona** — Midnight builds' MCP server, originally forked from
[p18a/mcp-ruoka](https://github.com/p18a/mcp-ruoka) (much of the base code is
upstream's; credit it in user-facing docs). It fetches purchase receipts from the S-ryhmä S-Etukortti service
(s-etukortti.fi) for a logged-in user. Login uses an email one-time code (OTP)
entered manually into a persistent Playwright browser profile; scheduled runs
reuse that session. Single-client personal tool — keep auth, session management,
and infrastructure simple rather than building for multi-tenant scale.

## Commands

- `bun run dev` — run with watch mode
- `bun run build` — bundle for production
- `bun test` — run the test suite
- `bun run check` — lint, format, and auto-fix with Biome
- `bun run typecheck` — type-check without emitting
- `bun run login` — interactive one-time S-Etukortti login (email OTP; human in the loop)

## Conventions

- Bun runtime — use `bun run`, `bun test`, `Bun.serve()` etc.
- Biome for linting and formatting (no ESLint/Prettier)
- Strict TypeScript — no `any`, no non-null assertions, no `as` type casts (use Zod parsing instead)
- Parse all I/O boundaries with Zod — API responses, JSON.parse results, external data. Never trust runtime shapes via `as` assertions; validate with `.parse()` / `.safeParse()`. (`as const` is fine — it narrows literals, doesn't assert shapes)
- All tool inputs validated with Zod schemas via MCP SDK
- Use pino for logging (`src/logger.ts`), never `console.log/warn/error` — logs must go to stderr to avoid interfering with stdio MCP transport
- Comments should explain *why*, not *what* — no section dividers, no restating what the code does
- Browser context is reused across calls — don't create new contexts per request
- Keep chain-specific browser/API logic (`src/browser/`) isolated from MCP tool definitions (`src/tools/`)

## Working rules

- Do not publish, deploy, or create external services without explicit approval.
- Never attempt to bypass or automate the OTP step; session expiry is reported
  to the user, who re-authenticates manually.
