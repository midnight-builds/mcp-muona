# Coding standards

Read during review, not implementation. Apply every rule to the diff and report each
violation with a `file:line` anchor and the concrete scenario it breaks. Biome, `tsc` and the
tests already enforce the mechanical conventions in `CLAUDE.md` (no `any`, no `as` casts, no
non-null assertions, no `console`); this file holds the judgement calls they cannot make.

## External APIs

- **Every new external operation is verified live.** The PR states the operation and the
  live answer, or marks it unverified and says why. An operation in a captured schema is not
  an operation Muona may call: `products(eans)` and the ESL operations answer "Not
  Authorized" for Muona's tokens (PR #6, PR #10). Unit tests with a fake GraphQL layer pass
  for any operation, so they are no evidence here. S-ostoslista operations are checked with
  `scripts/sostoslista-probe.ts`; a mutation is probed where it cannot take effect.
- **A write that may have applied is never retried or re-sent.** A timeout, a 5xx or partial
  data after a mutation leaves its effect unknown: report it, then read the state again. A
  rejection by the API's authorizer is the exception: it comes before any resolver runs, so
  `gql`'s re-send after renewing tokens (`src/browser/s-ostoslista.ts`) is safe. The same
  care goes for identity: the stored S-ostoslista anonymous token owns every list Muona
  made, so code never replaces it.

## Writes

- **Validate everything, then write once.** A tool that writes several items checks all of
  them (ids on the list, EANs resolved in the store, inputs well-formed) before the first
  call that changes anything, and its error says nothing was written. A half-applied list
  is the failure this prevents.

## MCP tools

- **Descriptions are the agent's only manual, and they stay true.** A changed tool updates
  its description, the server instructions (`INSTRUCTIONS` in `src/index.ts`) and the README
  tool list in the same PR; a removed tool leaves none of the three behind. A description
  names the tool chain the agent should follow and the cases where it should ask the user.
- **Errors say what to do next**: which tool to call, what input to change, or that the human
  must act (login). An error that only names the failure sends the agent guessing.
- **Actions with effects outside Muona** (an email code, a physical device, someone else's
  list) run only on the user's request, and the description says so.

## Logging

- **State transitions and recovery paths log at info** with the ids involved (list, store,
  login phase), because journald is the only view into production. A new write, login step,
  retry or fallback without a log line is a finding.
