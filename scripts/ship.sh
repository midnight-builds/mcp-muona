#!/usr/bin/env bash
# Merges a green PR and cleans up after it, in the order that works with
# worktrees: `gh pr merge --delete-branch` fails while a worktree still has the
# branch checked out, and `gh pr checks --watch` right after a push reports
# "no checks" before CI has registered. Deploying stays a separate step
# (`bun run deploy`) because a restart cuts off a login in progress — check
# s_etukortti_session_status first.
#
# Usage: scripts/ship.sh <pr-number>
set -euo pipefail

pr="${1:?usage: scripts/ship.sh <pr-number>}"

fail() {
	echo "ship: $*" >&2
	exit 1
}

branch=$(gh pr view "$pr" --json headRefName --jq .headRefName)
[ "$branch" != "main" ] || fail "PR #$pr is from main"

echo "ship: waiting for CI on #$pr ($branch)"
# Allowlist, not a search for "fail": a cancelled run, an error from gh or a
# check not yet registered must never read as green. head is the commit CI
# judged; the merge is pinned to it.
for _ in $(seq 1 60); do
	snapshot=$(gh pr view "$pr" --json headRefOid,statusCheckRollup \
		--jq '[.headRefOid, (.statusCheckRollup | length),
			([.statusCheckRollup[] | select(.status != "COMPLETED")] | length),
			([.statusCheckRollup[] | select(.status == "COMPLETED"
				and (.conclusion | IN("SUCCESS", "SKIPPED", "NEUTRAL") | not))] | length)] | @tsv')
	read -r head total running bad <<<"$snapshot"
	[ "$bad" -eq 0 ] || fail "CI not green on #$pr ($bad check(s) failed, cancelled or timed out)"
	[ "$total" -gt 0 ] && [ "$running" -eq 0 ] && break
	sleep 10
done
[ "$total" -gt 0 ] && [ "$running" -eq 0 ] || fail "CI did not finish in 10 minutes"

# Only a clean worktree at the PR head is removed; any other work stops the script.
worktree=$(git worktree list --porcelain | awk -v b="refs/heads/$branch" \
	'/^worktree /{w=$2} $0=="branch " b {print w}')
if [ -n "$worktree" ]; then
	case "$PWD/" in "$worktree"/*) fail "run from outside $worktree; it is removed here" ;; esac
	[ -z "$(git -C "$worktree" status --porcelain)" ] || fail "worktree $worktree has uncommitted changes"
	[ "$(git -C "$worktree" rev-parse HEAD)" = "$head" ] ||
		fail "worktree $worktree is not at the PR head ${head:0:7}; push or drop its commits first"
	git worktree remove "$worktree"
	echo "ship: removed worktree $worktree"
fi

gh pr merge "$pr" --squash --delete-branch --match-head-commit "$head"
git branch -D "$branch" 2>/dev/null || true
git fetch --quiet --prune origin
echo "ship: #$pr merged as $(git rev-parse --short origin/main)"
echo "ship: next, check s_etukortti_session_status, then: bun run deploy"
