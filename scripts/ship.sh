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
for _ in $(seq 1 60); do
	checks=$(gh pr checks "$pr" 2>&1 || true)
	if [ -n "$checks" ] && ! grep -q "no checks reported\|pending" <<<"$checks"; then
		break
	fi
	sleep 10
done
grep -q "pending\|no checks reported" <<<"$checks" && fail "CI did not finish in 10 minutes"
grep -q "fail" <<<"$checks" && fail "CI red on #$pr:"$'\n'"$checks"

# Only a clean worktree is removed; uncommitted work stops the script instead.
worktree=$(git worktree list --porcelain | awk -v b="refs/heads/$branch" \
	'/^worktree /{w=$2} $0=="branch " b {print w}')
if [ -n "$worktree" ]; then
	case "$PWD/" in "$worktree"/*) fail "run from outside $worktree; it is removed here" ;; esac
	[ -z "$(git -C "$worktree" status --porcelain)" ] || fail "worktree $worktree has uncommitted changes"
	git worktree remove "$worktree"
	echo "ship: removed worktree $worktree"
fi

gh pr merge "$pr" --squash --delete-branch
git branch -D "$branch" 2>/dev/null || true
git fetch --quiet --prune origin
echo "ship: #$pr merged as $(git rev-parse --short origin/main)"
echo "ship: next, check s_etukortti_session_status, then: bun run deploy"
