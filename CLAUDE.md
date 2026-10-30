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
- `bun test` — run the unit tests (`src/`, see `bunfig.toml`)
- `bun run test:e2e` — smoke test against the built bundle (needs `bun run build` first)
- `bun run check` — lint, format, and auto-fix with Biome
- `bun run lint` — the same Biome checks without writing (what CI and the hook run)
- `bun run typecheck` — type-check without emitting
- `bun run login` — interactive one-time S-Etukortti login (email OTP; human in the loop)

## Gate

Run in this order; all must be green before merging. CI (`.github/workflows/ci.yml`)
runs the same list on every PR and push to main; `bun install` points git at
`.githooks/`, whose pre-commit runs the fast part (Biome on staged files + typecheck).

1. `bun run lint`
2. `bun run typecheck`
3. `bun test`
4. `bun run build`
5. `bun run test:e2e`

tuotantokriittinen: kyllä — the server holds a logged-in S-tunnus browser profile and the
user's full purchase history behind one bearer token; an auth regression leaks personal
data, which a later deploy cannot undo. Major dependency updates go to human review.

Before proposing a PR, offer the user an adversarial review: a subagent that tries to break
the change and backs every finding with a concrete scenario and a `file:line` anchor.

## Deploy

Production is `muona.service` (`/etc/systemd/system/muona.service` plus the drop-in
`muona.service.d/remote-screen.conf`, which ties it to `muona-xvfb.service`). It runs
`bun run src/index.ts` **directly from the production checkout**
`/home/codexuser/projects/mcp-muona`, with `.env` in that directory (`PORT`,
`MCP_AUTH_TOKEN`, `S_OSTOSLISTA_API_KEY`). Anything on disk there goes live on the next
restart, including a crash restart (`Restart=on-failure`), so:

- Never edit, check out branches or run `git pull` in the production checkout — work in a
  separate worktree and merge via main.
- Deploy only with `bun run deploy` (`scripts/deploy.sh`): it refuses unless the checkout
  is clean, on main and equal to `origin/main`, runs the full gate, restarts the service
  and waits for the health check.
- Health check: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/mcp` → `401`
  (server up, auth enforced).

## Language

- Replies to the user: Finnish.
- All artifacts — this file, code comments, identifiers, commit messages, issues, PRs,
  todo lists: English.
- Product content (MCP tool names and descriptions, README): English.

## Conventions

- Bun runtime — use `bun run`, `bun test`, `Bun.serve()` etc.
- Biome for linting and formatting (no ESLint/Prettier)
- Strict TypeScript — no `any`, no non-null assertions, no `as` type casts (use Zod parsing instead); Biome enforces all three (`as` via `biome-plugins/no-type-assertion.grit`)
- Parse all I/O boundaries with Zod — API responses, JSON.parse results, external data. Never trust runtime shapes via `as` assertions; validate with `.parse()` / `.safeParse()`. (`as const` is fine — it narrows literals, doesn't assert shapes)
- All tool inputs validated with Zod schemas via MCP SDK
- Use pino for logging (`src/logger.ts`), never `console.log/warn/error` — logs must go to stderr to avoid interfering with stdio MCP transport (Biome `noConsole` enforces this in `src/`)
- Comments should explain *why*, not *what* — no section dividers, no restating what the code does
- Browser context is reused across calls — don't create new contexts per request
- Keep chain-specific browser/API logic (`src/browser/`) isolated from MCP tool definitions (`src/tools/`)

## Working rules

- Do not publish, deploy, or create external services without explicit approval.
- Never attempt to bypass or automate the OTP step; session expiry is reported
  to the user, who re-authenticates manually.
