# CPU & Memory Optimization Implementation Plan (`router.mjs` 1.85 GB RSS & `control.mjs` 99% CPU Spikes)

> **Status:** COMPLETED & VERIFIED (All Phases 1–7 executed, 150 Node tests + 160 Swift tests passing, live service & macOS tray companion restarted and verified).

**Goal:** Eliminate the 1.85 GB RAM bloat in long-running [`src/router.mjs`](file:///Users/gurbakshchahal/codex-router/src/router.mjs) processes, eliminate the ~99% CPU / ~886 MB RAM spikes when [`ModelRouterTray`](file:///Users/gurbakshchahal/codex-router/apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift) polls [`src/control.mjs`](file:///Users/gurbakshchahal/codex-router/src/control.mjs), and bound all telemetry/log files in `~/.codex/codex-router/` (`usage-events.jsonl`, `provider-latency-traces.jsonl`, `router.log`, `router.log.1`, and `compaction-operations.json`).

---

## Summary of Affected Files

| File | Previous Issue | Implemented Fix |
| :--- | :--- | :--- |
| [`src/control.mjs`](file:///Users/gurbakshchahal/codex-router/src/control.mjs) | `engineeringUsageEventsForControl()` ran an uncached 90-day scan of 330 MB `usage-events.jsonl` on every `control --json`; `runOperationProcessTree` double-spawned Node on cached reads. | Uses `recentEngineeringUsageEvents({ limit: 1_000 })`, caches `"engineering-usage"` & `"tool-result-aging"` snapshots, skips parent re-exec for read-only cached JSON probes (`fastReadOnlyControl`), and lazy-loads engineering usage events. |
| [`src/control-snapshot-cache.mjs`](file:///Users/gurbakshchahal/codex-router/src/control-snapshot-cache.mjs) | Only cached `provider-usage`, `account`, `providers`, and `probe`; `engineering-usage` and `tool-result-aging` were uncached. | Added `"engineering-usage": 60_000` and `"tool-result-aging": 60_000` snapshot TTLs and exported `invalidateControlSnapshots`. |
| [`src/usage-events.mjs`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs) | Module-global `lineCache` pinned 330 MB split array in `router.mjs` heap; `recentUsageEvents`, `toolResultAgingTotals`, and `observedInputCeilings` scanned from byte 0; `recordUsageEvent` ran `mkdirSync` + `chmodSync` on every turn; file never rotated. | Removed persistent `lineCache`, implemented reverse 512 KB chunk tail reader (`readRecentUsageEventLines`) and forward chunked reader (`forEachUsageEventLine`), added incremental `usage-events-rollup.json` checkpoint (`syncUsageEventsRollup`), memoized dir/mode init, and added 32 MiB size-bounded rotation (`rotateUsageEventsIfNeeded`). |
| [`src/provider-usage.mjs`](file:///Users/gurbakshchahal/codex-router/src/provider-usage.mjs) | `providerUsageSnapshot()` called `allUsageEvents()` (parsing 100% of 330 MB file) and ran `aggregateProviderUsage` twice (90d + all-time). | Consumes incremental daily/retained rollup state from `usage-events-rollup.json` + newly appended delta bytes from `usage-events.jsonl` in $O(\Delta \text{bytes})$. |
| [`src/provider-latency-trace.mjs`](file:///Users/gurbakshchahal/codex-router/src/provider-latency-trace.mjs) | `writeTrace()` ran `mkdirSync` + `appendFileSync` + `chmodSync` on every trace and never rotated `provider-latency-traces.jsonl` (360 MB, write-only). | Memoizes `mkdirSync`/`chmodSync` per process and rotates `provider-latency-traces.jsonl` at 16 MiB (`DEFAULT_MAX_LATENCY_TRACE_BYTES`) via `rotateLog`. |
| [`src/service-macos.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-macos.mjs), [`src/service-linux.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-linux.mjs), [`src/service-windows.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-windows.mjs) | `rotateLog(LOG_PATH)` was only called in `installService`, never in `stop`/`start`/`restart` or on Windows. | Calls `rotateLog(LOG_PATH)` while the service is stopped during `stop`, `start`, and `restart` across all three OS service managers. |
| [`src/native-catalog-drift.mjs`](file:///Users/gurbakshchahal/codex-router/src/native-catalog-drift.mjs) | `codexBinaryFingerprint()` ran `readFileSync(binaryPath)` + SHA-256 on the ~100+ MB `codex` binary every 5 minutes inside `router.mjs`. | Caches the computed SHA-256 digest and CLI version in memory keyed by `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`. |
| [`apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`](file:///Users/gurbakshchahal/codex-router/apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift) | `startMonitoringUsageDirectory()` watched all of `$STATE_DIR` without filename filter or debounce (self-triggering on `control-snapshot-*.json` & `usage-widget.json` writes); `refreshActivity()` spawned 5 `bin/control` processes on every turn completion. | Filters/watches only `chatgpt-usage-snapshot.json` and `claude-usage-snapshot.json` mtimes with a 1.5s debounce (`watchedUsageSnapshotModificationDates`); coalesces post-turn `refresh()` and `refreshProviderUsage()` calls with a 15s cooldown (`postTurnFullRefreshCooldown`). |

---

## Detailed Tasklist & Checklist by Filename

### Phase 1: Stop the `control.mjs` Polling Spikes (`src/control.mjs` & `src/control-snapshot-cache.mjs`)

#### 1. [`src/control-snapshot-cache.mjs`](file:///Users/gurbakshchahal/codex-router/src/control-snapshot-cache.mjs)
- [x] **Step 1.1:** Add snapshot cache TTLs in `CONTROL_SNAPSHOT_TTLS_MS` for `"engineering-usage": 60_000` and `"tool-result-aging": 60_000`.
- [x] **Step 1.2:** Export `invalidateControlSnapshots` helper to invalidate affected snapshot caches when mutations occur.

#### 2. [`src/control.mjs`](file:///Users/gurbakshchahal/codex-router/src/control.mjs)
- [x] **Step 2.1:** Fix [`engineeringUsageEventsForControl()`](file:///Users/gurbakshchahal/codex-router/src/control.mjs#L608-L616) to use `recentEngineeringUsageEvents({ limit: 1_000 })` instead of scanning 90 days of `usage-events.jsonl`.
- [x] **Step 2.2:** Wrap [`engineeringUsageEventsForControl()`](file:///Users/gurbakshchahal/codex-router/src/control.mjs#L608-L616) in `readControlSnapshot("engineering-usage")` / `writeControlSnapshot("engineering-usage", events)` so `bin/control --json` does zero JSONL disk reads when the 60s cache is warm.
- [x] **Step 2.3:** Lazy-load `usageEvents` in [`handleEngineering()`](file:///Users/gurbakshchahal/codex-router/src/control.mjs#L769-L879) so `run`, `run-status`, `policy` (get), and `preview` skip loading usage events.
- [x] **Step 2.4:** Wrap `toolResultAgingSnapshot()` in [`handleToolResultAging()`](file:///Users/gurbakshchahal/codex-router/src/control.mjs#L2263-L2326) (`status` action) with `readControlSnapshot("tool-result-aging")` / `writeControlSnapshot("tool-result-aging")`.
- [x] **Step 2.5:** Fast-path read-only cached invocations (`fastReadOnlyControl`) in [`src/control.mjs`](file:///Users/gurbakshchahal/codex-router/src/control.mjs#L117-L135) to execute directly in-process on non-Windows hosts instead of spawning a redundant wrapper `node src/control.mjs` child process.

---

### Phase 2: Tail-Reading, Incremental Rollups & Rotation for `usage-events.jsonl` (`src/usage-events.mjs` & `src/provider-usage.mjs`)

#### 3. [`src/usage-events.mjs`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs)
- [x] **Step 3.1:** Remove the unbounded module-global `lineCache` so `router.mjs` can never retain a 330 MB split-line array in heap.
- [x] **Step 3.2:** Implement a **reverse byte-chunk tail reader** [`readRecentUsageEventLines()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L51-L166) and forward chunked reader [`forEachUsageEventLine()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L168-L232) reading in 512 KB (`USAGE_EVENTS_CHUNK_BYTES`) chunks.
- [x] **Step 3.3:** Update [`recentEngineeringUsageEvents({ limit = 1_000 })`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L234-L264) and [`recentUsageEvents({ sinceMs, limit })`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L1669-L1740) to use `readRecentUsageEventLines(...)`.
- [x] **Step 3.4:** Implement the **incremental rollup checkpoint** (`USAGE_EVENTS_ROLLUP_PATH = path.join(STATE_DIR, "usage-events-rollup.json")`) via [`syncUsageEventsRollup()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L1233-L1321) for [`toolResultAgingTotals()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L1506-L1576) and [`observedInputCeilings()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L1850-L1865).
- [x] **Step 3.5:** Optimize [`recordUsageEvent()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L596-L643) to memoize directory/file mode checks and rotate `usage-events.jsonl` at 32 MiB (`DEFAULT_MAX_USAGE_EVENTS_BYTES`) via [`rotateUsageEventsIfNeeded()`](file:///Users/gurbakshchahal/codex-router/src/usage-events.mjs#L1409-L1491) while preserving archived ceilings, aging totals, and retained provider usage.

#### 4. [`src/provider-usage.mjs`](file:///Users/gurbakshchahal/codex-router/src/provider-usage.mjs)
- [x] **Step 4.1:** Refactor [`providerUsageSnapshot()`](file:///Users/gurbakshchahal/codex-router/src/provider-usage.mjs#L728-L784) to materialize the 90-day and all-time `retained` snapshots from `syncUsageEventsRollup()` in $O(\Delta \text{bytes})$ while preserving `aggregateProviderUsage()` pure for explicit `events` callers.

---

### Phase 3: Bound `provider-latency-traces.jsonl` & `router.log*` (`src/provider-latency-trace.mjs`, `src/service-*.mjs`)

#### 5. [`src/provider-latency-trace.mjs`](file:///Users/gurbakshchahal/codex-router/src/provider-latency-trace.mjs)
- [x] **Step 5.1:** In [`writeTrace(record)`](file:///Users/gurbakshchahal/codex-router/src/provider-latency-trace.mjs#L50-L94), memoize directory creation and `0o600` permission setting per process and call `rotateLog(PROVIDER_LATENCY_TRACES_PATH, { maxBytes })` (`DEFAULT_MAX_LATENCY_TRACE_BYTES = 16 MiB`) on first write and every 64 writes.

#### 6. [`src/service-macos.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-macos.mjs), [`src/service-linux.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-linux.mjs), [`src/service-windows.mjs`](file:///Users/gurbakshchahal/codex-router/src/service-windows.mjs)
- [x] **Step 6.1:** Call `rotateLog(LOG_PATH)` while the service is stopped during `stop`, `start`, and `restart` across all three OS service managers while preserving all `test/log-rotation.test.mjs` invariants.

---

### Phase 4: Fix `router.mjs` Long-Lived Memory & CPU Overhead (`src/native-catalog-drift.mjs`)

#### 7. [`src/native-catalog-drift.mjs`](file:///Users/gurbakshchahal/codex-router/src/native-catalog-drift.mjs)
- [x] **Step 7.1:** In [`codexBinaryFingerprint()`](file:///Users/gurbakshchahal/codex-router/src/native-catalog-drift.mjs#L27-L56) and [`cachedCodexVersion()`](file:///Users/gurbakshchahal/codex-router/src/native-catalog-drift.mjs#L58-L87), cache the binary SHA-256 digest and CLI version in memory keyed by `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}` so `router.mjs` does not allocate a ~100+ MB `Buffer` and SHA-256 hash the `codex` binary every 5 minutes.

---

### Phase 5: Fix `ModelRouterTray` File-Watcher Loop & Subprocess Storms (`ModelRouterTrayApp.swift`)

#### 8. [`apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`](file:///Users/gurbakshchahal/codex-router/apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift)
- [x] **Step 8.1:** Fix [`startMonitoringUsageDirectory()`](file:///Users/gurbakshchahal/codex-router/apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift#L2183-L2240) to inspect only `chatgpt-usage-snapshot.json` and `claude-usage-snapshot.json` modification dates (`watchedUsageSnapshotModificationDates`) with a 1.5-second debounce.
- [x] **Step 8.2:** Coalesce post-turn subprocess refreshes in [`refreshActivity()`](file:///Users/gurbakshchahal/codex-router/apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift#L3778-L3851) using a 15-second cooldown (`postTurnFullRefreshCooldown`) and raising `refreshNativeUsageIfStale` `maxAge` from `2.0` to `10.0`.

---

### Phase 6: Automated Tests & Verification Suite

#### 9. Unit & Integration Tests (`test/`)
- [x] **Step 9.1:** [`test/usage-events.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/usage-events.test.mjs) & [`test/provider-usage.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/provider-usage.test.mjs) — 38/38 passing.
- [x] **Step 9.2:** [`test/provider-latency-trace.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/provider-latency-trace.test.mjs), [`test/log-rotation.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/log-rotation.test.mjs), & [`test/native-catalog-drift.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/native-catalog-drift.test.mjs) — 65/65 passing.
- [x] **Step 9.3:** [`test/control-snapshot-cache.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/control-snapshot-cache.test.mjs) & [`test/control.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/control.test.mjs) — 35/35 passing.
- [x] **Step 9.4:** [`test/tray-rebuild.test.mjs`](file:///Users/gurbakshchahal/codex-router/test/tray-rebuild.test.mjs) & `swift test` in `apps/macos/ModelRouterTray` — 48/48 Node tests + 160/160 Swift tests passing; `git diff --check` clean.

---

### Phase 7: Operational Remediation on `~/.codex/codex-router/` (Immediate Relief)

- [x] **Step 10.1:** Created `~/.codex/codex-router/archive/` (`mode 0o700`) and preserved compressed `.gz` archives of all historical files (`usage-events`, `provider-latency-traces`, `router.log*`, `compaction-operations.json`).
- [x] **Step 10.2:** Generated `usage-events-rollup.json` (**2.6 MB**) from the full 314 MB `usage-events.jsonl` and rotated `usage-events.jsonl` to **16 MB** (with a 32 MB `.1` backup).
- [x] **Step 10.3:** Rotated and trimmed `provider-latency-traces.jsonl` from **360 MB** to **8.0 MB** (archived full copy in `archive/`).
- [x] **Step 10.4:** Archived retired `compaction-operations.json` (20 MB) and rotated `router.log` (105 MB) / `router.log.1` (225 MB) into `archive/`, leaving a fresh **14 KB** `router.log`.
- [x] **Step 10.5:** Restarted the router service (`node src/control.mjs service restart`) and rebuilt/restarted the macOS tray companion (`node src/control.mjs tray refresh`).

---

## Evidence Ledger (`$repo-maintainer`)

| ID | Observable outcome | Status | Evidence or reason |
| :--- | :--- | :--- | :--- |
| A1 | `router.mjs` RSS drops from 1.85 GB and no longer pins `usage-events.jsonl` in `lineCache` | **verified** | Live `router.mjs` (PID 23817) RSS measured at **144 MB (147,856 KB)** and **0.0% CPU** after `node src/control.mjs service restart`; `lineCache` removed in `src/usage-events.mjs`. |
| A2 | `control.mjs --json` and `provider-usage --json` no longer spike to ~886 MB–1 GB RSS / 7s CPU | **verified** | `/usr/bin/time -l node src/control.mjs --json`: **70.0 MB peak memory footprint, 0.63s wall**. `/usr/bin/time -l node src/control.mjs provider-usage --json`: **40.6 MB peak memory footprint, 0.11s wall** (even `--refresh` is **39.9 MB peak footprint, 0.63s wall**). |
| A3 | Historical provider usage, aging totals, and context-window drift ceilings survive rotation | **verified** | `test/usage-events.test.mjs` and `test/provider-usage.test.mjs` (38/38 pass); `~/.codex/codex-router/usage-events-rollup.json` (2.6 MB) synced prior to 16 MB rotation. |
| A4 | `provider-latency-traces.jsonl` and `router.log` are bounded and rotated safely | **verified** | `test/provider-latency-trace.test.mjs` and `test/log-rotation.test.mjs` pass; active `provider-latency-traces.jsonl` is 8.0 MB (16 MiB cap) and `router.log` is 14 KB. |
| A5 | `ModelRouterTray` no longer self-triggers on `$STATE_DIR` writes or turn-completion bursts | **verified** | `test/tray-rebuild.test.mjs` (48/48 pass), `swift test` (160/160 pass), and `node src/control.mjs tray refresh` rebuilt and installed `/Users/gurbakshchahal/Applications/Codex Router.app`. |
