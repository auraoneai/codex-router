import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("usage events persist only bounded request metadata in a private file", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?test=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 321,
      responseStartMs: 121,
      inputTokens: 120,
      billedInputTokens: 240,
      cachedInputTokens: 90,
      outputTokens: 35,
      billedOutputTokens: 70,
      totalTokens: 155,
      toolResultsAged: 2,
      toolResultBytesBefore: 80_000,
      toolResultBytesAfter: 5_000,
      toolResultBytesSaved: 75_000,
      searchSidecar: true,
      searchCacheHit: false,
      searchResults: 4,
      prompt: "never persisted",
      credential: "never persisted",
    });
    assert.deepEqual(usage.recentUsageEvents(), [
      {
        meteringVersion: 1,
        at: usage.recentUsageEvents()[0].at,
        model: "grok-oauth/grok-4.5",
        provider: "grok-oauth",
        status: 200,
        durationMs: 321,
        responseStartMs: 121,
        inputTokens: 120,
        billedInputTokens: 240,
        cachedInputTokens: 90,
        outputTokens: 35,
        billedOutputTokens: 70,
        totalTokens: 155,
        toolResultsAged: 2,
        toolResultBytesBefore: 80_000,
        toolResultBytesAfter: 5_000,
        toolResultBytesSaved: 75_000,
        searchSidecar: true,
        searchCacheHit: false,
        searchResults: 4,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("all usage events can include history beyond the recent probe window", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?all=${Date.now()}`);
    const now = Date.now();
    usage.recordUsageEvent({
      model: "deepseek/deepseek-v4",
      provider: "deepseek",
      status: 200,
      durationMs: 10,
      totalTokens: 10,
      at: now - 2 * 24 * 60 * 60 * 1_000,
    });
    usage.recordUsageEvent({
      model: "deepseek/deepseek-v4",
      provider: "deepseek",
      status: 200,
      durationMs: 10,
      totalTokens: 20,
      at: now,
    });
    assert.equal(usage.recentUsageEvents({ sinceMs: 24 * 60 * 60 * 1_000 }).length, 1);
    assert.equal(usage.allUsageEvents().length, 2);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("tool-result aging totals aggregate savings across recorded events", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  let usage;
  try {
    usage = await import(`../src/usage-events.mjs?totals=${Date.now()}`);
    const emptyCache = { agedRate: null, unagedRate: null, agedTurns: 0, unagedTurns: 0 };
    // No events file yet: totals must report zeros rather than fail.
    assert.deepEqual(usage.toolResultAgingTotals(), {
      requests: 0,
      evaluatedRequests: 0,
      largestResultBytes: 0,
      resultsAged: 0,
      resultsShaped: 0,
      bytesSaved: 0,
      estimatedTokensSaved: 0,
      firstAt: undefined,
      lastAt: undefined,
      ranges: {
        "24h": { savedTokens: 0, requests: 0, buckets: new Array(24).fill(0), cache: emptyCache },
        "7d": { savedTokens: 0, requests: 0, buckets: new Array(7).fill(0), cache: emptyCache },
        "30d": { savedTokens: 0, requests: 0, buckets: new Array(30).fill(0), cache: emptyCache },
      },
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
      inputTokens: 120,
      cachedInputTokens: 90,
      toolResultsAged: 2,
      toolResultBytesBefore: 80_000,
      toolResultBytesAfter: 5_000,
      toolResultBytesSaved: 75_000,
    });
    // An ordinary turn without aging must not count as an aged request.
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
    });
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 100,
      toolResultsAged: 1,
      toolResultBytesSaved: 25_000,
    });
    const totals = usage.toolResultAgingTotals();
    assert.equal(totals.requests, 2);
    assert.equal(totals.resultsAged, 3);
    assert.equal(totals.bytesSaved, 100_000);
    assert.equal(totals.estimatedTokensSaved, 25_000);
    assert.ok(typeof totals.firstAt === "string");
    assert.ok(typeof totals.lastAt === "string");
    assert.ok(Date.parse(totals.lastAt) >= Date.parse(totals.firstAt));
    // Both aged events landed within the current hour/day, so the newest
    // bucket of every range holds the whole series.
    for (const [key, size] of [["24h", 24], ["7d", 7], ["30d", 30]]) {
      const range = totals.ranges[key];
      assert.equal(range.buckets.length, size);
      assert.equal(range.buckets.at(-1), 25_000);
      assert.equal(range.savedTokens, 25_000);
      assert.equal(range.requests, 2);
      // The first event reported cache telemetry and carried aging; the
      // others reported none, so only the aged side has a measured rate.
      assert.equal(range.cache.agedTurns, 1);
      assert.equal(range.cache.agedRate, 0.75);
      assert.equal(range.cache.unagedTurns, 0);
      assert.equal(range.cache.unagedRate, null);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    // paths.mjs caches STATE_DIR from the first import in this process, so
    // the recorded file may live outside this test's tmpdir. Remove it even
    // on assertion failure so later tests start from an empty event log.
    if (usage) rmSync(usage.USAGE_EVENTS_PATH, { force: true });
  }
});

test("reading usage events folds protocol variants into their canonical provider", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?variant=${Date.now()}`);
    // Historical events recorded before canonicalization carry the variant id.
    usage.recordUsageEvent({
      model: "opencode-go-messages/minimax-m3",
      provider: "opencode-go-messages",
      status: 200,
      durationMs: 50,
    });
    assert.equal(usage.recentUsageEvents()[0].provider, "opencode-go");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an aborted stream persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?aborted=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 502,
      durationMs: 90,
      streamAborted: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 502);
    assert.equal(event.status, 502);
    assert.equal(event.streamAborted, true);
    // An ordinary turn never carries the marker, so historical rows keep
    // their exact shape and old dashboards are unaffected.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 200);
    assert.equal("streamAborted" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a guard budget release persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?guard=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
      emptyCompletionGuardReleased: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased === true);
    assert.equal(event.status, 200);
    assert.equal(event.durationMs, 40_100);
    // An ordinary turn never carries the marker, so the release path stays
    // distinguishable from a healthy turn of the same duration.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased !== true);
    assert.equal("emptyCompletionGuardReleased" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a guard pre-content limit persists its kind and rejects unknown values", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?precontent=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 502,
      durationMs: 30_100,
      emptyCompletionPreludeLimit: "time",
    });
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 502,
      durationMs: 10,
      emptyCompletionPreludeLimit: "unknown",
    });
    const events = usage.recentUsageEvents().filter((event) => event.status === 502);
    const timed = events.find((event) => event.durationMs === 30_100);
    const unknown = events.find((event) => event.durationMs === 10);
    assert.equal(timed.emptyCompletionPreludeLimit, "time");
    assert.equal("emptyCompletionPreludeLimit" in unknown, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// An operator who enables aging on a workload of medium-sized results saw an
// all-zero ledger and reasonably concluded the hook had never loaded. The
// evaluated counter is what separates "ran and nothing qualified" from "never
// ran", and the largest-result byte count says how far under the floor it was.
test("totals separate a pass that ran and aged nothing from one that never ran", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?evaluated=${Date.now()}`);
    // Aging enabled, ran over eleven results, none of them past the floor.
    usage.recordUsageEvent({
      model: "qwen-plan/qwen3.8-max",
      provider: "qwen-plan",
      status: 200,
      durationMs: 100,
      inputTokens: 275_000,
      toolResultsEvaluated: 11,
      toolResultBytesLargest: 12_400,
    });
    // Aging off: the pass reports nothing, so this row must not be counted.
    usage.recordUsageEvent({
      model: "qwen-plan/qwen3.8-max",
      provider: "qwen-plan",
      status: 200,
      durationMs: 100,
      inputTokens: 275_000,
    });
    const totals = usage.toolResultAgingTotals();
    assert.equal(totals.evaluatedRequests, 1, "only the row from an enabled pass counts");
    assert.equal(totals.largestResultBytes, 12_400);
    assert.equal(totals.requests, 0, "nothing was aged, so no request saved anything");
    assert.equal(totals.bytesSaved, 0);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("RTK compaction shaping contributes savings without being reported as aged", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  let usage;
  try {
    usage = await import(`../src/usage-events.mjs?shaped=${Date.now()}`);
    usage.recordUsageEvent({
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      status: 200,
      durationMs: 100,
      inputTokens: 700_000,
      toolResultsShaped: 2,
      toolResultBytesBefore: 2_400_000,
      toolResultBytesAfter: 4_000,
      toolResultBytesSaved: 2_396_000,
      toolResultShapeBytesSaved: 2_396_000,
      toolResultsEvaluated: 0,
      toolResultBytesLargest: 0,
    });
    const event = usage.recentUsageEvents().find((entry) => entry.toolResultsShaped === 2);
    assert.equal(event.toolResultsShaped, 2);
    assert.equal(event.toolResultsAged, undefined);
    assert.equal(event.toolResultShapeBytesSaved, 2_396_000);

    const totals = usage.toolResultAgingTotals();
    assert.equal(totals.requests, 1);
    assert.equal(totals.resultsAged, 0);
    assert.equal(totals.resultsShaped, 2);
    assert.equal(totals.bytesSaved, 2_396_000);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    if (usage) rmSync(usage.USAGE_EVENTS_PATH, { force: true });
  }
});

test("the aging benchmark classifies shaped-only turns as compacted", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-router-aging-benchmark-"));
  const eventsPath = path.join(directory, "usage-events.jsonl");
  const reportPath = path.join(directory, "report.json");
  const event = {
    meteringVersion: 1,
    at: "2026-08-24T00:00:00.000Z",
    model: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
    status: 200,
    durationMs: 10,
    inputTokens: 700_000,
    cachedInputTokens: 350_000,
    toolResultsShaped: 2,
    toolResultBytesSaved: 100_000,
    toolResultShapeBytesSaved: 100_000,
  };
  writeFileSync(
    eventsPath,
    `${JSON.stringify(event)}\n${JSON.stringify({ ...event, at: "2026-08-24T00:01:00.000Z" })}\n`,
    "utf8",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "aging-benchmark.mjs"), "--json", reportPath],
      {
        cwd: root,
        env: { ...process.env, MODEL_ROUTER_USAGE_EVENTS: eventsPath },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.saved[0].resultsAged, 0);
    assert.equal(report.saved[0].resultsShaped, 2);
    assert.deepEqual(report.cache.map((turn) => turn.kind), ["fresh", "stable"]);
    assert.equal(report.summary.cacheRate.unaged, null);
    assert.equal(report.summary.cacheRate.agedTurnsMeasured, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hourly rollup aggregates the whole window, not a capped sample", async () => {
  const { hourlyUsageRollup } = await import("../src/usage-events.mjs");
  const now = Date.parse("2026-09-06T17:30:37.000Z");
  const hour = 3_600_000;
  // 4,000 rows across the window: many more than recentUsageEvents' 1,000-row
  // default, and the reason the chart could not be built from that sample.
  const events = Array.from({ length: 4_000 }, (_, index) => ({
    at: new Date(now - (index % 24) * hour - 60_000).toISOString(),
    model: "m",
    provider: "openai",
    totalTokens: 100,
  }));
  const seen = [];
  const buckets = hourlyUsageRollup({
    now,
    readEvents: (options) => { seen.push(options); return events; },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].limit, Number.POSITIVE_INFINITY);
  assert.equal(buckets.length, 25);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.requests, 0), 4_000);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 400_000);
  assert.equal(buckets.filter((bucket) => bucket.requests > 0).length, 24);
  assert.ok(seen[0].sinceMs >= 24 * hour && seen[0].sinceMs < 25 * hour);
  assert.deepEqual(
    buckets.map((bucket) => bucket.startedAt).slice().sort(),
    buckets.map((bucket) => bucket.startedAt),
  );
});

test("the hourly rollup keeps the oldest partial hour inside the rolling window", async () => {
  const { hourlyUsageRollup } = await import("../src/usage-events.mjs");
  const now = Date.parse("2026-09-06T17:30:37.000Z");
  const hour = 3_600_000;
  const buckets = hourlyUsageRollup({
    now,
    readEvents: () => [
      { at: new Date(now - 24 * hour).toISOString(), model: "m", provider: "p", totalTokens: 20 },
      { at: new Date(now - (23 * hour + 45 * 60_000)).toISOString(), model: "m", provider: "p", totalTokens: 10 },
      { at: new Date(now - (24 * hour + 15 * 60_000)).toISOString(), model: "m", provider: "p", totalTokens: 1000 },
      { at: new Date(now).toISOString(), model: "m", provider: "p", totalTokens: 1000 },
    ],
  });

  assert.equal(buckets.length, 25);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.requests, 0), 2);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 30);
  assert.equal(buckets[0].requests, 2, "the oldest partial clock hour is retained");
});

test("the hourly rollup mirrors the renderer's billed-token and cache-share math", async () => {
  const { hourlyUsageRollup } = await import("../src/usage-events.mjs");
  const now = Date.parse("2026-09-06T17:30:37.000Z");
  const at = new Date(now - 1_000).toISOString();
  const buckets = hourlyUsageRollup({
    now,
    readEvents: () => [
      // Billed counts win over raw ones, and a cached share larger than the
      // input it belongs to is clamped rather than double counted.
      { at, model: "m", provider: "p", inputTokens: 10, billedInputTokens: 40, cachedInputTokens: 90, outputTokens: 3, billedOutputTokens: 7 },
      // No totalTokens: the sum falls back to billed input plus billed output.
      { at, model: "m", provider: "p", inputTokens: 5, outputTokens: 5 },
      // A request with no token fields at all is counted but not measured.
      { at, model: "m", provider: "p" },
    ],
  });
  const last = buckets[buckets.length - 1];

  assert.equal(last.requests, 3);
  assert.equal(last.tokens, 47 + 10);
  assert.equal(last.measuredTokens, true);
  assert.equal(last.cachedInputTokens, 40 + 0);
  assert.equal(last.regularInputTokens, 0 + 5);
  assert.equal(last.outputTokens, 7 + 5);
  assert.equal(last.measuredBreakdown, true);
});

test("an empty ledger still returns a full, honest set of hours", async () => {
  const { hourlyUsageRollup } = await import("../src/usage-events.mjs");
  const buckets = hourlyUsageRollup({
    now: Date.parse("2026-09-06T17:30:37.000Z"),
    readEvents: () => [],
  });
  assert.equal(buckets.length, 25);
  assert.ok(buckets.every((bucket) => bucket.requests === 0 && bucket.tokens === 0));
  assert.ok(buckets.every((bucket) => !bucket.measuredTokens && !bucket.measuredBreakdown));
});

test("records known actual serviceTier without echoing the requested value", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-tier-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?tier=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 12,
      requestedServiceTier: "priority",
      serviceTier: "default",
      prompt: "never persisted",
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 13,
      requestedServiceTier: "flex",
      serviceTier: "flex",
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 14,
      retries: 1,
      serviceTier: "priority",
    });
    const events = usage.recentUsageEvents();
    assert.equal(events[0].requestedServiceTier, "priority");
    assert.equal(events[0].serviceTier, "default");
    assert.equal("serviceTier" in events[1], false);
    assert.equal("requestedServiceTier" in events[1], false);
    assert.equal("serviceTier" in events[2], false);
    assert.equal(events[2].retries, 1);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the reasoning-streamed marker persists both measured values and drops anything else", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?reasoning-streamed=1&ts=${Date.now()}`);
    const record = (status, reasoningStreamed) =>
      usage.recordUsageEvent({
        model: "openai/reasoning-streamed-probe",
        provider: "openai",
        status,
        durationMs: 4_000,
        firstTokenMs: 1_000,
        outputTokens: 502,
        reasoningTokens: 98,
        reasoningStreamed,
      });
    record(200, true);
    record(201, false);
    record(202, "yes");
    record(203, undefined);
    // The module caches its state path from the first import in this process,
    // so earlier tests may have left rows in the same file: match on this
    // test-only model slug, not on status alone.
    const byStatus = (status) =>
      usage
        .recentUsageEvents()
        .find((event) => event.model === "openai/reasoning-streamed-probe" && event.status === status);
    assert.equal(byStatus(200).reasoningStreamed, true);
    // False is a measurement (no reasoning delta was relayed), not an absence,
    // so it must survive the round trip: it is what selects the subtraction.
    assert.equal(byStatus(201).reasoningStreamed, false);
    assert.equal("reasoningStreamed" in byStatus(202), false);
    assert.equal("reasoningStreamed" in byStatus(203), false);
    assert.equal(byStatus(200).reasoningTokens, 98);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test("engineering usage adds bounded correlation with measured, estimated, and unknown semantics", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-engineering-usage-"));
  const script = `
    import { recordUsageEvent, recentEngineeringUsageEvents } from "./src/usage-events.mjs";
    recordUsageEvent({ model: "provider/model", provider: "provider", status: 200, durationMs: 1, inputTokens: 4 });
    recordUsageEvent({
      model: "provider/model", provider: "provider", status: 200, durationMs: 2,
      estimatedInputTokens: 19, outputTokens: 7,
      engineering: {
        bindingId: "binding-12345678", runId: "r".repeat(300), taskId: "task-1",
        attemptId: "attempt-1", role: "implementation", sourceRevision: "abc123",
        effectiveEffort: "high", worktree: "/private/never-recorded",
      },
    });
    recordUsageEvent({
      model: "provider/model", provider: "provider", status: 200, durationMs: 3,
      engineering: { runId: "caller-controlled", effectiveEffort: "max" },
    });
    process.stdout.write(JSON.stringify(recentEngineeringUsageEvents()));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const events = JSON.parse(result.stdout);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.bindingId, "binding-12345678");
    assert.equal(event.runId.length, 160);
    assert.equal(event.taskId, "task-1");
    assert.equal(event.effectiveEffort, "high");
    assert.equal("worktree" in event, false);
    assert.deepEqual(event.usage.inputTokens, { kind: "estimated", value: 19 });
    assert.deepEqual(event.usage.outputTokens, { kind: "measured", value: 7 });
    assert.deepEqual(event.usage.reasoningTokens, { kind: "unknown" });
    assert.deepEqual(event.usage.costMicros, { kind: "unknown" });
    const rows = readFileSync(path.join(stateDir, "usage-events.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.equal("engineering" in rows[0], false, "ordinary event shape changed");
    assert.equal("engineering" in rows[2], false, "unverified caller metadata was attributed");
    assert.equal("worktree" in rows[1].engineering, false);
    assert.equal(rows[1].runId, "r".repeat(160));
    assert.equal(rows[1].taskId, "task-1");
    assert.deepEqual(rows[1].usage.inputTokens, { kind: "estimated", value: 19 });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reverse tail reader and forward chunked reader handle multi-chunk files and out-of-order slack windows", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-router-tail-chunks-"));
  const filePath = path.join(dir, "events.jsonl");
  try {
    const { readRecentUsageEventLines, forEachUsageEventLine } = await import("../src/usage-events.mjs");
    const baseMs = Date.parse("2026-10-17T12:00:00.000Z");
    const totalRows = 120;
    const rawLines = [];
    for (let index = 0; index < totalRows; index += 1) {
      // Introduce a slight 2-minute out-of-order swap around the cutoff boundary
      const offsetMinutes =
        index === 60 ? 59 : index === 59 ? 61 : totalRows - index;
      const at = new Date(baseMs - offsetMinutes * 60_000).toISOString();
      rawLines.push(
        JSON.stringify({
          meteringVersion: 1,
          at,
          model: `provider/model-${index}`,
          provider: "provider",
          status: 200,
          durationMs: index + 1,
          inputTokens: 100 + index,
          ...(index % 10 === 0
            ? {
                engineering: {
                  bindingId: `bind-${index}`,
                  usage: { inputTokens: { kind: "measured", value: 100 + index } },
                },
              }
            : {}),
        }),
      );
    }
    writeFileSync(filePath, `${rawLines.join("\n")}\n`, "utf8");

    // Forward chunked reader with tiny 256-byte chunks reconstructs every line in order
    const forwardLines = [];
    forEachUsageEventLine((line) => forwardLines.push(line), {
      filePath,
      chunkBytes: 256,
    });
    assert.deepEqual(forwardLines, rawLines);

    // Reverse tail reader with tiny 256-byte chunks and limit = 15 returns the exact last 15 lines
    const tail15 = readRecentUsageEventLines({
      filePath,
      chunkBytes: 256,
      maxMatchingLines: 15,
    });
    assert.deepEqual(tail15, rawLines.slice(-15));

    // Cutoff window with 10-minute slack catches out-of-order completion at index 59
    const cutoffIso = new Date(baseMs - 60 * 60_000).toISOString();
    const expectedSinceCutoff = rawLines.filter((line) => {
      const parsed = JSON.parse(line);
      return parsed.at >= cutoffIso;
    });
    const actualSinceCutoff = readRecentUsageEventLines({
      filePath,
      chunkBytes: 256,
      cutoffIso,
    });
    assert.deepEqual(actualSinceCutoff, expectedSinceCutoff);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incremental rollup checkpoint and size-bounded rotation preserve ceilings and aging totals", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-rollup-rotate-"));
  const script = `
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, statSync } from "node:fs";
    import {
      USAGE_EVENTS_PATH,
      USAGE_EVENTS_ROLLUP_PATH,
      recordUsageEvent,
      observedInputCeilings,
      toolResultAgingTotals,
      recentUsageEvents,
      recentEngineeringUsageEvents,
    } from "./src/usage-events.mjs";

    const now = Date.parse("2026-10-17T16:00:00.000Z");

    // 1. Record an early event with a huge accepted input ceiling and aging savings
    recordUsageEvent({
      at: now - 5 * 3_600_000,
      model: "qwen-plan/qwen3.8-max",
      provider: "qwen-plan",
      status: 200,
      durationMs: 250,
      inputTokens: 450_000,
      cachedInputTokens: 225_000,
      outputTokens: 500,
      toolResultsEvaluated: 8,
      toolResultBytesLargest: 90_000,
      toolResultsAged: 3,
      toolResultBytesSaved: 80_000,
    });

    // Trigger initial rollup checkpoint
    let ceilings = observedInputCeilings();
    assert.equal(ceilings.get("qwen-plan/qwen3.8-max"), 450_000);
    assert.equal(existsSync(USAGE_EVENTS_ROLLUP_PATH), true);
    const firstRollup = JSON.parse(readFileSync(USAGE_EVENTS_ROLLUP_PATH, "utf8"));
    assert.equal(firstRollup.schemaVersion, 1);
    assert.ok(firstRollup.byteOffset > 0);
    assert.ok(typeof firstRollup.firstLineHash === "string" && firstRollup.firstLineHash.length === 64);

    // 2. Append enough events to exceed CODEX_ROUTER_MAX_USAGE_EVENTS_BYTES (4096) and trigger rotation
    for (let i = 0; i < 35; i += 1) {
      recordUsageEvent({
        at: now - (40 - i) * 60_000,
        model: i % 2 === 0 ? "qwen-plan/qwen3.8-max" : "deepseek/deepseek-v4",
        provider: i % 2 === 0 ? "qwen-plan" : "deepseek",
        status: 200,
        durationMs: 100 + i,
        inputTokens: 10_000 + i * 100,
        outputTokens: 200,
        ...(i === 10
          ? {
              toolResultsEvaluated: 4,
              toolResultBytesLargest: 120_000,
              toolResultsShaped: 2,
              toolResultBytesSaved: 40_000,
            }
          : {}),
        ...(i >= 30
          ? {
              engineering: {
                bindingId: "bind-" + i,
                taskId: "task-" + i,
              },
            }
          : {}),
      });
    }

    // Verify rotation occurred and active file is bounded while .1 archive exists
    assert.equal(existsSync(USAGE_EVENTS_PATH + ".1"), true);
    const activeSizeAfterRotate = statSync(USAGE_EVENTS_PATH).size;
    assert.ok(activeSizeAfterRotate < 4096, "active file was trimmed on rotation");

    // 3. Append one more post-rotation event to verify incremental delta folding after rotation
    recordUsageEvent({
      at: now - 30_000,
      model: "deepseek/deepseek-v4",
      provider: "deepseek",
      status: 200,
      durationMs: 95,
      inputTokens: 310_000,
      cachedInputTokens: 155_000,
      outputTokens: 150,
      toolResultsEvaluated: 2,
      toolResultBytesLargest: 50_000,
      toolResultsAged: 1,
      toolResultBytesSaved: 20_000,
    });

    // Verify historical ceiling from rotated-out first event AND new ceiling after rotation are both preserved!
    ceilings = observedInputCeilings();
    assert.equal(ceilings.get("qwen-plan/qwen3.8-max"), 450_000);
    assert.equal(ceilings.get("deepseek/deepseek-v4"), 310_000);

    // Verify cumulative aging totals across rotated prefix + kept tail + post-rotation append
    const aging = toolResultAgingTotals({ now });
    assert.equal(aging.requests, 3);
    assert.equal(aging.evaluatedRequests, 3);
    assert.equal(aging.largestResultBytes, 120_000);
    assert.equal(aging.resultsAged, 4);
    assert.equal(aging.resultsShaped, 2);
    assert.equal(aging.bytesSaved, 140_000);
    assert.equal(aging.estimatedTokensSaved, 35_000);
    assert.equal(aging.ranges["24h"].savedTokens, 35_000);
    assert.equal(aging.ranges["24h"].requests, 3);
    assert.equal(aging.ranges["24h"].cache.agedTurns, 2);
    assert.equal(aging.ranges["24h"].cache.agedRate, 0.5);

    // Verify recentEngineeringUsageEvents still reads recent engineering turns from the tail
    const eng = recentEngineeringUsageEvents({ limit: 3 });
    assert.equal(eng.length, 3);
    assert.deepEqual(eng.map((e) => e.bindingId), ["bind-32", "bind-33", "bind-34"]);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_MAX_USAGE_EVENTS_BYTES: "4096",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
