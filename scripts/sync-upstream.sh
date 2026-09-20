#!/bin/sh
# Bring the maintained fork up to a new upstream release without losing the
# custom commits, then update the installed checkout from the fork.
#
#   scripts/sync-upstream.sh            merge upstream/main and install it
#   scripts/sync-upstream.sh --check    report what would change, write nothing
#
# Why this exists: `bin/update` fast-forwards the installed checkout from
# `origin/main`, and for this machine `origin` is the fork that carries the
# custom commits. Upstream is therefore merged here first, so the fork's main
# stays a superset of upstream and the installed checkout can still
# fast-forward. `bin/update` also refuses an unrecognized origin, so
# CODEX_ROUTER_REPOSITORY_URL names the fork it is allowed to pull from.
set -eu

FORK_URL=${FORK_URL:-https://github.com/gchahal1982/codex-router.git}
UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
INSTALL_ROOT=${INSTALL_ROOT:-$HOME/.local/share/codex-router}

dev_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)
check_only=0
[ "${1:-}" = "--check" ] && check_only=1

cd "$dev_dir"

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" https://github.com/duolahypercho/codex-router.git
fi

git fetch --quiet "$UPSTREAM_REMOTE" main
git fetch --quiet origin main

upstream_head=$(git rev-parse "$UPSTREAM_REMOTE/main")
behind=$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/main")
custom=$(git rev-list --count "$UPSTREAM_REMOTE/main..HEAD")

printf 'upstream %s\n' "$upstream_head"
printf 'custom commits on top of upstream: %s\n' "$custom"
printf 'upstream commits not yet merged here: %s\n' "$behind"

if [ "$check_only" -eq 1 ]; then
  [ "$behind" -eq 0 ] && printf 'Already current with upstream.\n' || \
    git log --oneline "HEAD..$UPSTREAM_REMOTE/main" | head -40
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  printf 'Refusing to merge with tracked local edits. Commit or stash them first.\n' >&2
  exit 1
fi

if [ "$behind" -gt 0 ]; then
  # A merge, never a rebase: the custom commits are already published on the
  # fork's main, and rebasing them would rewrite history the installed
  # checkout fast-forwards from.
  git merge --no-edit "$UPSTREAM_REMOTE/main"
  # Prove the merge before publishing it. A conflicted or semantically broken
  # merge that reaches the fork's main becomes what the installer pulls.
  npm run check
  node --test --test-timeout=600000 test/*.test.mjs
fi

# The fork's main is what the installed checkout pulls, so publish there.
git push origin "HEAD:main"

cd "$INSTALL_ROOT"
CODEX_ROUTER_REPOSITORY_URL="$FORK_URL" ./bin/update
CODEX_ROUTER_REPOSITORY_URL="$FORK_URL" ./bin/codex-router doctor
