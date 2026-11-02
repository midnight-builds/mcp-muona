#!/usr/bin/env bash
# Merges a green PR and cleans up after it, in the order that works with
# worktrees: the local branch cannot be deleted while a worktree still has it
# checked out, and `gh pr checks --watch` right after a push reports "no checks"
# before CI has registered. Deploying stays a separate step
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

# Branch protection requires an up-to-date branch, so a PR behind main cannot
# merge; bring main in and wait until GitHub reports the new head, otherwise the
# CI loop below would judge the old head's checks.
read -r merge_state old_head <<<"$(gh pr view "$pr" --json mergeStateStatus,headRefOid \
	--jq '[.mergeStateStatus, .headRefOid] | @tsv')"
if [ "$merge_state" = "BEHIND" ]; then
	echo "ship: #$pr is behind main; updating its branch"
	# REST, not `gh pr update-branch`: that subcommand only exists in newer gh
	# releases than the distro package this server runs.
	gh api -X PUT "repos/{owner}/{repo}/pulls/$pr/update-branch" --silent
	for _ in $(seq 1 30); do
		[ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" != "$old_head" ] && break
		sleep 2
	done
fi

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
	# After an update-branch the PR head has main merged on top of the worktree's
	# commits; the worktree is safe to drop as long as all of them are in it.
	git -C "$worktree" fetch --quiet origin "$branch"
	git -C "$worktree" merge-base --is-ancestor HEAD "$head" ||
		fail "worktree $worktree has commits not in the PR head ${head:0:7}; push or drop them first"
	git worktree remove "$worktree"
	echo "ship: removed worktree $worktree"
fi

# No --delete-branch: the repo deletes merged branches itself, and gh's own
# delete then gets a 404 and fails the script before the cleanup below.
gh pr merge "$pr" --squash --match-head-commit "$head"
git branch -D "$branch" 2>/dev/null || true
git fetch --quiet --prune origin
echo "ship: #$pr merged as $(git rev-parse --short origin/main)"
echo "ship: next, check s_etukortti_session_status, then: bun run deploy"
