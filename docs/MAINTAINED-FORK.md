# Maintained fork: what is custom, and how to update without losing it

This checkout is upstream `duolahypercho/codex-router` plus customizations that
upstream does not carry. Updating is therefore a **merge**, not a fast-forward,
and the ways it goes wrong are specific and repeatable. This document exists
because a 0.5.1 to 0.6.0 upgrade lost work for hours before it was recovered.

## Update in three commands

```sh
scripts/sync-upstream.sh --check      # what is coming, nothing written
scripts/sync-upstream.sh             # merge, test, publish, install
node scripts/verify-custom-features.mjs
```

`sync-upstream.sh` merges `upstream/main`, runs the suite, pushes to the fork,
then updates and doctors the installed checkout. It refuses to merge over tracked
local edits. `verify-custom-features.mjs` is the part that matters after any
upgrade: it asserts each customization is still *wired*, not merely present.

## Why "present" is not "working"

An upgrade can lose custom work in three ways. Only the first is visible to a
file listing, and the other two are what cost the hours:

1. **The file is gone.** `operator-model.mjs` and
   `provider-latency-trace.mjs` were simply absent after the integration.
2. **The file is there and the code is dead.** `prismAffinityHeaders` survived
   byte-for-byte while reading a header its only caller had stopped sending.
   Upstream built the stream-stall mechanism our Prism fix needed, then wired it
   for one provider, so Prism streams were still cut mid-answer. Both would pass
   any grep.
3. **The feature works and its state is orphaned.** Five ChatGPT accounts kept
   valid credentials on disk while a changed id pattern made them invisible to
   the pool that reads them. Nothing was broken; nothing was reachable.

`verify-custom-features.mjs` checks connections rather than contents for exactly
this reason: a symbol reaching its call site, a header reaching the wire, a state
file matching the shape its reader expects.

## Two traps worth knowing before you diff

**Diff against the commit that preceded the edit, not the branch tip.** Reading
the island customizations against `origin/custom/v0.5.1` produced sixteen hunks
that looked like whole features being deleted. The branch tip contained two
commits made *after* those files were last touched; against the actual preceding
commit the real change was twenty-six lines. A large apparent delta usually means
the wrong baseline.

**An upstream rename hides a file rather than deleting it.** The Swift target
moved from `CodexRouterTray` to `ModelRouterTray`, so fifty files read as
"missing" while having counterparts under the new name, and two genuinely
uncommitted files hid in that noise. Check for a rename before concluding
anything is lost.

## What is custom

### Provider ports
`config/kiro-prism/`, `config/cloudflare/`, `config/free-prism/`, and their
registry wiring. Upstream ships none of these. The registry discovers
`config/<id>/` at runtime, so a definition that fails to parse disappears from
the routable set while still satisfying a text search -- which is why the
verifier loads the registry instead of grepping.

### ChatGPT account rotation
`src/chatgpt-rotation.mjs`, `src/chatgpt-usage-probe.mjs`, and one call site in
`nativeHeaders()` in `src/router.mjs`.

Upstream's account pool is a manual switcher: `selectedAccountId` names one
account and `chatgpt-profile-switch` copies its credentials over
`$CODEX_HOME/auth.json`. A spent weekly window therefore answers 429 to the
operator instead of moving to a subscription with room.

Rotation chooses per turn instead. It reads each account's own `auth.json` from
its pool home and returns that account's headers, so no profile switch or shared
file write is involved and upstream keeps ownership of login, refresh, and
locking. Ordering, drain detection, cooldown, and per-conversation affinity come
from the pre-0.6.0 implementation. Operator rules carry over as
`softDrainPercent: 15`, `reserveUntilPercent: 20`, and a personal / auraone /
veerone / foundation pin order.

Two details that are easy to break:

- **The quota probe must never run on the request path.** It spawns the Codex
  app-server. `router.mjs` reads a cached snapshot; only
  `control chatgpt-account-pool usage` probes.
- **`primary` and `secondary` are positional slots, not fixed windows.** One
  account reports a weekly window in `primary` where others report a 5-hour one.
  Classify by `windowDurationMins`. Reading by slot order mislabels a weekly
  figure as a 5-hour one, which is a wrong number rather than a missing one.

Inspect it with:

```sh
codex-router control chatgpt-account-pool usage          # re-probe, ~2s
codex-router control chatgpt-account-pool usage cached    # what rotation sees now
```

`rotation` is the ordered list of accounts the next turns will use. An account
present in `accounts` but absent from `rotation` was excluded for being drained
or cooling down after a 429.

### Restored modules
- `src/operator-model.mjs` -- records the last routed model actually run, so a
  compaction that omits its model can inherit it. An explicit native or routed
  model remains authoritative, even when another conversation wrote the hint.
- `src/provider-latency-trace.mjs` -- per-attempt correlation and router-side
  phase breakdown. The built-in timing line is one flat summary that cannot say
  which attempt of a failover was slow.

### Re-ported fixes
In `src/openai-adapters.mjs`: namespaced tool results correlate through `id`
rather than requiring `call_id` (its absence broke compaction replay for any
conversation that had used an MCP tool), and a request carrying both
`reasoning.effort` and flat `reasoning_effort` is reconciled rather than refused
(the router sets both for subagent turns). In `src/stream-stall-policy.mjs`:
Prism providers get upstream's `maxStreamStallMs`. In `src/codex-binary.mjs`:
Homebrew is preferred over the desktop bundle on macOS, whose symptom was newer
native models missing from the picker.

### macOS tray and island
`apps/macos/ModelRouterTray/`. A private `routerReduceMotion` key pins the island
quiet regardless of the system Reduce Motion setting, while the desktop panel
still follows the OS. Account usage reads the cached snapshot on an adaptive
schedule and reacts to file changes; the tray does not re-probe every account
on each refresh. The per-account quota table shows a row per subscription with rotation
rank, both windows, and a reset countdown, and marks accounts rotation excluded.

## Deliberately not carried forward

Re-adding any of these would reintroduce a problem, so they are decisions rather
than omissions:

- **Desktop model synchronization** (`model-sync.mjs` and its former
  `control model-sync` command) -- retired during branch consolidation. The
  restored module had no production callers or user controls. Its historical
  wiring rewrote incoming native model names before route selection, including
  explicit native choices and compaction requests; a bare model name cannot
  establish that the client made no choice. Restoring that wiring would undo
  the explicit-model isolation proved by the compaction routing tests.
  `codex-default-model.mjs` continues to own the opt-in stored Codex default,
  and `control native-redirect` remains the separate explicit routing opt-in.
  Neither claims to provide global chat/scheduled-task model or effort
  synchronization. Existing `model-sync.json` state is left untouched and is
  not read or activated.

- **The old ChatGPT account stack** (`chatgpt-accounts.mjs`,
  `chatgpt-account-plane.mjs`, `chatgpt-reserve.mjs`, `bin/chatgpt-accounts`).
  Upstream's pool is larger and better maintained. Two implementations writing
  one pool file corrupts it.
- **`provider-accounts.mjs`** -- upstream's `provider-api-key-pool.mjs` plus
  `provider-account-usage.mjs` cover it.
- **`compaction-operation-store.mjs`** -- superseded for the checkpoint format.
  Note the narrower gap: compaction surviving a client disconnect is *not*
  covered, and is not separable from the store, so it stays out. Detaching from
  the client signal alone would spend provider quota producing a checkpoint with
  nowhere to persist.
- **Upstream's leftover-account dashboard** -- deleted upstream in 0.6.0. The
  island's own quota table is a different thing and is maintained here.
- **The connection-pool bound from `1d3cf83a`** -- rejected during branch
  consolidation. Each HTTP/1.1 stream occupies a socket, so the proposed
  128-connection ceiling queues legitimate concurrent turns while leaving the
  pending request queue unbounded. Keep the current shared keep-alive transport,
  separate health probes, long-idle stream handling, and direct loopback pool.
- **The branch-only test-hang diagnostic** -- retired. Its push trigger names
  the deleted diagnostic branch, its fixed per-file timeout can reject valid
  suites, and it lacks current browser provisioning. Use the maintained CI
  workflow, which supports manual dispatch and bounds test/job duration.

## If an update goes wrong

```sh
codex-router rollback                        # previous installed revision
git log --oneline upstream/main..HEAD        # every custom commit
node scripts/verify-custom-features.mjs      # what specifically broke
```

The fork's `main` must stay a superset of upstream, because `bin/update`
fast-forwards the installed checkout from `origin/main`. It also refuses an
unrecognized origin, so `CODEX_ROUTER_REPOSITORY_URL` names this fork;
`sync-upstream.sh` passes it.

Durable state lives in `~/.codex/codex-router/` and survives reinstallation.
Source customizations do not: they survive only as commits on this fork.
