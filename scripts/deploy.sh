#!/usr/bin/env bash
# Interim deploy: muona.service runs straight from the production checkout
# (/home/codexuser/projects/mcp-muona), so whatever is on disk goes live on the
# next restart — including a crash restart. This script is the only sanctioned
# way to change that checkout: the gate runs in a throwaway worktree first, and
# the production files only move once origin/main is known green.
set -euo pipefail

PROD_DIR="${MUONA_PROD_DIR:-/home/codexuser/projects/mcp-muona}"
SERVICE="${MUONA_SERVICE:-muona.service}"
HEALTH_URL="${MUONA_HEALTH_URL:-http://127.0.0.1:3011/mcp}"

fail() {
	echo "deploy: $*" >&2
	exit 1
}

cd "$PROD_DIR"

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || fail "production checkout is on '$branch', expected main"
[ -z "$(git status --porcelain)" ] || fail "production checkout has uncommitted changes"

git fetch --quiet origin main
git merge-base --is-ancestor HEAD origin/main ||
	fail "production checkout has commits not on origin/main"
target=$(git rev-parse origin/main)

gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/muona-deploy-XXXXXX")
cleanup() {
	git -C "$PROD_DIR" worktree remove --force "$gate_dir" 2>/dev/null || rm -rf "$gate_dir"
}
trap cleanup EXIT

git worktree add --quiet --detach "$gate_dir" "$target"
# Chained with && on purpose: set -e is suspended inside a command that is
# the left side of ||, so a plain list here would let a red step through.
(
	cd "$gate_dir" &&
		bun install --frozen-lockfile &&
		bun run lint &&
		bun run typecheck &&
		bun test &&
		bun run build &&
		bun run test:e2e
) || fail "gate red at ${target:0:7}; production checkout left untouched"

previous=$(git rev-parse HEAD)
git merge --quiet --ff-only "$target"
# New src/ with old node_modules would go live on the next crash restart, so a
# failed install puts the previous commit and its dependencies back. Each
# Playwright release pins its own browser build, and the gate never launches a
# browser, so without this a Playwright bump deploys green and then every
# browser launch fails. It is a no-op when the build is already in the cache.
if ! { bun install --frozen-lockfile && bunx playwright install chromium chromium-headless-shell; }; then
	git reset --quiet --hard "$previous"
	bun install --frozen-lockfile || true
	fail "install failed at ${target:0:7}; production checkout reset to ${previous:0:7}"
fi

echo "deploy: gate green at ${target:0:7}, restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# 401 without a token means the HTTP server is up and auth is enforced.
code=""
for _ in $(seq 1 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
	if [ "$code" = "401" ]; then
		echo "deploy: $SERVICE healthy ($HEALTH_URL -> 401 without token)"
		exit 0
	fi
	sleep 1
done
fail "$SERVICE did not answer 401 on $HEALTH_URL within 30s (last: ${code:-none}).
Roll back: cd $PROD_DIR && git reset --hard ${previous:0:7} && bun install --frozen-lockfile && sudo systemctl restart $SERVICE"
