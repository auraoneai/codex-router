import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProviderUsage, tokensGeneratedAfterFirstToken } from "../src/provider-usage.mjs";

test("protocol variants never appear as separate usage providers", () => {
  const snapshot = aggregateProviderUsage([], { now: Date.parse("2026-07-21T18:00:00Z") });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.ok(ids.includes("opencode-go"));
  assert.ok(!ids.includes("opencode-go-messages"));
  assert.ok(!ids.includes("opencode-go-responses"));
  assert.ok(ids.includes("commandcode"));
  assert.ok(!ids.includes("commandcode-messages"));
});

test("all router totals retain historical providers and reconcile with provider rows", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "opencode-go-messages",
        status: 200,
        totalTokens: 80,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T13:00:00Z",
        provider: "retired-provider",
        status: 200,
        totalTokens: 25,
      },
    ],
    { days: 7, now },
  );
  const rows = snapshot.providers;
  const totalTokens = rows.reduce((sum, provider) => sum + provider.totalTokens, 0);
  const totalRequests = rows.reduce((sum, provider) => sum + provider.requests, 0);

  assert.equal(totalTokens, 105);
  assert.equal(totalRequests, 2);
  assert.equal(rows.find((provider) => provider.id === "opencode-go")?.totalTokens, 80);
  assert.equal(rows.find((provider) => provider.id === "retired-provider")?.displayName, "Historical provider (retired-provider)");
  assert.equal(rows.some((provider) => provider.id === "opencode-go-messages"), false);
});

test("aggregates tokens and calls independently for each provider", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 500,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T13:00:00Z",
        provider: "deepseek",
        status: 200,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      },
      {
        at: "2026-07-21T14:00:00Z",
        provider: "kimi-api",
        status: 200,
      },
    ],
    { days: 7, now },
  );
  const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));

  assert.equal(byId["grok-oauth"].credentialType, "oauth");
  assert.equal(byId["grok-oauth"].requests, 2);
  assert.equal(byId["grok-oauth"].successfulRequests, 1);
  assert.equal(byId["grok-oauth"].meteredRequests, 1);
  assert.equal(byId["grok-oauth"].totalTokens, 140);
  assert.deepEqual(byId["grok-oauth"].dailyUsageBuckets, [
    {
      startDate: "2026-07-20",
      tokens: 140,
      requests: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 40,
    },
    {
      startDate: "2026-07-21",
      tokens: 0,
      requests: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
  ]);
  assert.equal(byId.deepseek.credentialType, "api");
  assert.equal(byId["opencode-free"].credentialType, "anonymous");
  assert.equal(byId.deepseek.totalTokens, 100);
  assert.equal(byId["kimi-api"].requests, 0);
  assert.equal(snapshot.scope, "local-router");
});

test("reports a rolling 24-hour window separately from calendar-day buckets", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      // The rolling window includes this request even though it is on the
      // previous local calendar date.
      {
        meteringVersion: 1,
        at: "2026-07-20T18:00:00Z",
        provider: "grok-oauth",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 500,
        inputTokens: 25,
        outputTokens: 5,
        totalTokens: 30,
      },
      // Requests without a usage block still count as requests, but are not
      // counted as metered requests or given guessed token totals.
      {
        meteringVersion: 1,
        at: "2026-07-21T17:00:00Z",
        provider: "grok-oauth",
        status: 502,
      },
      // Older than the rolling window, but still inside the aggregate range.
      {
        meteringVersion: 1,
        at: "2026-07-20T17:59:59Z",
        provider: "grok-oauth",
        status: 200,
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
      },
    ],
    { days: 7, now },
  );
  const grok = snapshot.providers.find((provider) => provider.id === "grok-oauth");

  assert.equal(grok.requests, 4);
  assert.equal(grok.totalTokens, 1_170);
  assert.equal(grok.last24hInputTokens, 125);
  assert.equal(grok.last24hOutputTokens, 45);
  assert.equal(grok.last24hTokens, 170);
  assert.equal(grok.last24hRequests, 3);
  assert.equal(grok.last24hMeteredRequests, 2);
});

test("publishes prefix-cache telemetry for the dashboard without inflating it", () => {
  // Buckets are keyed by UTC calendar day, the same day space OpenAI's account
  // stream uses, so a chart can merge the two without misattributing a bar by
  // the machine's offset from UTC.
  const utcDateKey = (value) => new Date(value).toISOString().slice(0, 10);
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T18:00:00Z",
        provider: "deepseek",
        status: 200,
        inputTokens: 100,
        cachedInputTokens: 80,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T17:00:00Z",
        provider: "deepseek",
        status: 200,
        inputTokens: 50,
        cachedInputTokens: 75,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T17:30:00Z",
        provider: "deepseek",
        status: 200,
        // A partial provider row can carry cache telemetry without its prompt
        // total. It cannot prove additional input and must not inflate the
        // cache subset beyond measured input.
        cachedInputTokens: 20,
      },
    ],
    { days: 7, now },
  );

  assert.deepEqual(snapshot.contextEfficiency, {
    // The rolling window is inclusive at its lower boundary, so the 18:00
    // request exactly one day earlier is still part of the window.
    last24hCachedInputTokens: 130,
    dailyCachedInputTokens: [
      { startDate: utcDateKey("2026-07-20T18:00:00Z"), cachedInputTokens: 80 },
      { startDate: utcDateKey("2026-07-21T17:00:00Z"), cachedInputTokens: 50 },
    ],
  });
  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");
  assert.equal(deepseek.inputTokens, 150);
  assert.equal(deepseek.regularInputTokens, 20);
  assert.equal(deepseek.cachedInputTokens, 130);
  assert.equal(deepseek.last24hRegularInputTokens, 20);
  assert.equal(deepseek.last24hCachedInputTokens, 130);
  assert.equal(deepseek.regularInputTokens + deepseek.cachedInputTokens, deepseek.inputTokens);
  assert.deepEqual(deepseek.dailyUsageBuckets, [
    { startDate: utcDateKey("2026-07-20T18:00:00Z"), tokens: 100, requests: 1, inputTokens: 100, cachedInputTokens: 80, outputTokens: 0 },
    { startDate: utcDateKey("2026-07-21T17:00:00Z"), tokens: 50, requests: 2, inputTokens: 50, cachedInputTokens: 50, outputTokens: 0 },
  ]);
});

test("initializes rolling usage counters for native and idle providers", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T17:00:00Z",
        provider: "openai",
        status: 200,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
      },
    ],
    { now },
  );
  const native = snapshot.providers.find((provider) => provider.id === "openai");
  const idle = snapshot.providers.find((provider) => provider.id === "deepseek");

  assert.deepEqual(
    {
      input: native.last24hInputTokens,
      output: native.last24hOutputTokens,
      tokens: native.last24hTokens,
      requests: native.last24hRequests,
      metered: native.last24hMeteredRequests,
    },
    { input: 8, output: 2, tokens: 10, requests: 1, metered: 1 },
  );
  assert.deepEqual(
    {
      input: idle.last24hInputTokens,
      output: idle.last24hOutputTokens,
      tokens: idle.last24hTokens,
      requests: idle.last24hRequests,
      metered: idle.last24hMeteredRequests,
    },
    { input: 0, output: 0, tokens: 0, requests: 0, metered: 0 },
  );
});

test("uses billed retry totals without changing the selected response usage", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        model: "grok-oauth/grok-4.6",
        status: 200,
        inputTokens: 151_000,
        outputTokens: 90,
        totalTokens: 151_090,
        billedInputTokens: 301_000,
        billedOutputTokens: 270,
        progressOnlyRetried: true,
      },
    ],
    { days: 7, now },
  );
  const grok = snapshot.providers.find((provider) => provider.id === "grok-oauth");
  assert.equal(grok.inputTokens, 301_000);
  assert.equal(grok.outputTokens, 270);
  assert.equal(grok.totalTokens, 301_270);
});

test("breaks provider usage down by model, heaviest first", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        durationMs: 2_000,
        firstTokenMs: 500,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T09:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        status: 200,
        durationMs: 4_000,
        firstTokenMs: 1_500,
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 500,
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
      },
    ],
    { days: 7, now },
  );
  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");

  assert.deepEqual(
    deepseek.models.map((model) => model.slug),
    ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  );

  const flash = deepseek.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.equal(flash.displayName, "deepseek-v4-flash");
  assert.equal(flash.requests, 2);
  assert.equal(flash.successfulRequests, 1);
  assert.equal(flash.totalTokens, 150);
  assert.equal(flash.inputTokens, 110);
  assert.equal(flash.observedTokensPerSecond, 26.7);
  assert.equal(flash.speedSampleCount, 1);
  assert.equal(flash.lastUsedAt, "2026-07-21T12:00:00.000Z");

  // Per-model totals must reconcile with the provider rollup they came from.
  const summed = deepseek.models.reduce((total, model) => total + model.totalTokens, 0);
  assert.equal(summed, deepseek.totalTokens);
});

test("reports no observed speed when successful requests have no metered output", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        durationMs: 1_000,
        inputTokens: 100,
        totalTokens: 100,
      },
    ],
    { days: 7, now },
  );
  const model = snapshot.providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.speedSampleCount, 0);
});

test("uses only the latest 20 clean generation timings for observed speed", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const events = Array.from({ length: 22 }, (_, index) => ({
    meteringVersion: 1,
    at: new Date(now - (21 - index) * 60_000).toISOString(),
    provider: "deepseek",
    model: "deepseek/deepseek-v4-flash",
    status: 200,
    durationMs: index < 2 ? 11_000 : 3_000,
    firstTokenMs: 1_000,
    outputTokens: 100,
    totalTokens: 100,
  }));
  // These rows must not become speed samples: historical rows have no
  // response-start timing, and retries do not describe one clean stream.
  events.push({
    ...events.at(-1),
    at: new Date(now - 500).toISOString(),
    firstTokenMs: undefined,
  });
  events.push({
    ...events.at(-1),
    at: new Date(now).toISOString(),
    firstTokenMs: 1_000,
    retries: 1,
  });

  const model = aggregateProviderUsage(events, { days: 7, now }).providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.speedSampleCount, 20);
  assert.equal(model.observedTokensPerSecond, 50);
});

test("tok/s counts reasoning tokens exactly when they were generated inside the timed window", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  // Every event: 4 s total, first token at 1 s, so a 3 s generation window.
  const base = (model, extra) => ({
    meteringVersion: 1,
    at: new Date(now).toISOString(),
    provider: "opencode-go",
    model,
    status: 200,
    durationMs: 4_000,
    firstTokenMs: 1_000,
    ...extra,
  });
  const events = [
    // Reasoning deltas were relayed: the clock started on them, so the 98
    // reasoning tokens were produced inside the window and stay in the count.
    base("opencode-go/streamed", { outputTokens: 502, reasoningTokens: 98, totalTokens: 602, reasoningStreamed: true }),
    // No reasoning delta was relayed: the model thought in silence before the
    // first visible token, so those 98 tokens belong to TTFT, not the rate.
    base("opencode-go/silent", { outputTokens: 502, reasoningTokens: 98, totalTokens: 602, reasoningStreamed: false }),
    // Rows written before the marker existed use the inclusive count.
    base("opencode-go/legacy", { outputTokens: 502, reasoningTokens: 98, totalTokens: 602 }),
    // A reasoning count above the output count proves the provider reports
    // visible tokens only; the inclusive total is rebuilt before deciding.
    base("opencode-go/exclusive-streamed", { outputTokens: 150, reasoningTokens: 499, totalTokens: 150, reasoningStreamed: true }),
    base("opencode-go/exclusive-silent", { outputTokens: 150, reasoningTokens: 499, totalTokens: 150, reasoningStreamed: false }),
  ];
  const snapshot = aggregateProviderUsage(events, { days: 7, now });
  const provider = snapshot.providers.find((candidate) => candidate.id === "opencode-go");
  const rate = (slug) => provider.models.find((model) => model.slug === slug).observedTokensPerSecond;
  assert.equal(rate("opencode-go/streamed"), 167.3); // 502 / 3 s
  assert.equal(rate("opencode-go/silent"), 134.7); // (502 - 98) / 3 s
  assert.equal(rate("opencode-go/legacy"), 167.3); // 502 / 3 s
  assert.equal(rate("opencode-go/exclusive-streamed"), 216.3); // (150 + 499) / 3 s
  assert.equal(rate("opencode-go/exclusive-silent"), 50); // 150 / 3 s
  // Provider totals still count the reported output, not the speed numerator.
  assert.equal(provider.outputTokens, 502 * 3 + 150 * 2);
});

test("tokensGeneratedAfterFirstToken treats a missing reasoning count as zero", () => {
  assert.equal(tokensGeneratedAfterFirstToken({}, 40), 40);
  assert.equal(tokensGeneratedAfterFirstToken({ reasoningStreamed: false }, 40), 40);
  assert.equal(tokensGeneratedAfterFirstToken({ reasoningTokens: 0, reasoningStreamed: false }, 40), 40);
});

test("accepts a response that starts within the first measured millisecond", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const model = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: new Date(now).toISOString(),
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        durationMs: 2_000,
        firstTokenMs: 0,
        outputTokens: 100,
      },
    ],
    { days: 7, now },
  ).providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.speedSampleCount, 1);
  assert.equal(model.observedTokensPerSecond, 50);
});

test("keeps unlabeled model traffic visible instead of dropping it", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        totalTokens: 25,
      },
    ],
    { days: 7, now },
  );
  const grok = snapshot.providers.find((provider) => provider.id === "grok-oauth");

  assert.deepEqual(grok.models.map((model) => model.slug), ["unknown"]);
  assert.equal(grok.models[0].totalTokens, 25);
});

// Output tokens per second is the rate after the first token, with the wait
// before it reported separately -- the definition every published benchmark
// uses. Dividing by time-since-headers instead put a reasoning model's silent
// thinking in the denominator, so the same model read at 12 tok/s on a short
// reply and 69 on a long one.
test("the observed rate does not move with reply length", () => {
  const at = new Date().toISOString();
  const reply = (outputTokens) => ({
    meteringVersion: 1,
    at,
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens,
    totalTokens: 10 + outputTokens,
    responseStartMs: 700,
    firstTokenMs: 2900,
    // 2.9s of thinking, then a steady 80 tokens/second.
    durationMs: 2900 + Math.round(outputTokens * 12.5),
  });

  const short = aggregateProviderUsage([reply(31)]).providers[0].models[0];
  const long = aggregateProviderUsage([reply(426)]).providers[0].models[0];
  assert.equal(Math.round(short.observedTokensPerSecond), 80);
  assert.equal(Math.round(long.observedTokensPerSecond), 80);
});

test("time to first token is reported on its own", () => {
  const at = new Date().toISOString();
  const events = [1200, 2900, 5000].map((firstTokenMs) => ({
    meteringVersion: 1,
    at,
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    firstTokenMs,
    durationMs: firstTokenMs + 1000,
  }));
  const model = aggregateProviderUsage(events).providers[0].models[0];
  // Median, so one cold start cannot drag it.
  assert.equal(model.observedFirstTokenMs, 2900);
});

test("a first token that outlives its own request is not sampled", () => {
  const model = aggregateProviderUsage([{
    meteringVersion: 1,
    at: new Date().toISOString(),
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    firstTokenMs: 5000,
    durationMs: 1000,
  }]).providers[0].models[0];
  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.observedFirstTokenMs, null);
});

test("rows recorded before first-token timing are unmeasured, not wrong", () => {
  const model = aggregateProviderUsage([{
    meteringVersion: 1,
    at: new Date().toISOString(),
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    responseStartMs: 200,
    durationMs: 1000,
  }]).providers[0].models[0];
  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.observedFirstTokenMs, null);
});

test("providerUsageSnapshot uses incremental rollup across appends and preserves retained usage across ledger rotation", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-provider-usage-rollup-"));
  const script = `
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { USAGE_EVENTS_PATH, USAGE_EVENTS_ROLLUP_PATH, recordUsageEvent } from "./src/usage-events.mjs";
    import { aggregateProviderUsage, providerUsageSnapshot } from "./src/provider-usage.mjs";

    // Write empty enabled-providers.json so account probes do not hit network
    writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR, "enabled-providers.json"), "[]\\n", "utf8");

    const now = Date.parse("2026-10-17T18:00:00.000Z");
    const dayMs = 24 * 3_600_000;
    const allRecorded = [];

    function record(ev) {
      recordUsageEvent(ev);
      allRecorded.push({
        meteringVersion: 1,
        ...ev,
        at: new Date(ev.at).toISOString(),
      });
    }

    // 1. Record an event older than 90 days (belongs in retained, not 90d snapshot)
    record({
      at: now - 100 * dayMs,
      provider: "deepseek",
      model: "deepseek/deepseek-v4-pro",
      status: 200,
      durationMs: 2_000,
      firstTokenMs: 500,
      inputTokens: 5_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      totalTokens: 6_000,
    });

    // 2. Record 30 events across the 90-day and 24-hour windows to trigger rotation at 4096 bytes
    for (let i = 0; i < 30; i += 1) {
      const isRecent24h = i >= 20;
      const eventAt = isRecent24h
        ? now - (35 - i) * 60_000
        : now - (40 - i) * dayMs;
      record({
        at: eventAt,
        provider: i % 2 === 0 ? "deepseek" : "grok-oauth",
        model: i % 2 === 0 ? "deepseek/deepseek-v4-flash" : "grok-oauth/grok-4.6",
        status: i % 7 === 0 ? 500 : 200,
        durationMs: 1_500,
        firstTokenMs: 300,
        inputTokens: 400 + i * 10,
        cachedInputTokens: 100 + i * 5,
        outputTokens: 120 + i * 2,
        totalTokens: 520 + i * 12,
      });
    }

    // Ensure rotation happened
    assert.equal(existsSync(USAGE_EVENTS_PATH + ".1"), true);

    const snap1 = await providerUsageSnapshot({ days: 90, now });
    const rollup1 = JSON.parse(readFileSync(USAGE_EVENTS_ROLLUP_PATH, "utf8"));
    const offsetAfterSnap1 = rollup1.byteOffset;
    assert.ok(offsetAfterSnap1 > 0);

    // 3. Append 2 more events after snapshot and rotation
    record({
      at: now - 5_000,
      provider: "deepseek",
      model: "deepseek/deepseek-v4-flash",
      status: 200,
      durationMs: 1_200,
      firstTokenMs: 200,
      inputTokens: 1_000,
      cachedInputTokens: 600,
      outputTokens: 300,
      totalTokens: 1_300,
    });
    record({
      at: now - 1_000,
      provider: "openai",
      model: "gpt-5.6-sol",
      status: 200,
      durationMs: 1_000,
      firstTokenMs: 200,
      inputTokens: 800,
      cachedInputTokens: 400,
      outputTokens: 200,
      totalTokens: 1_000,
    });

    const snap2 = await providerUsageSnapshot({ days: 90, now });
    const rollup2 = JSON.parse(readFileSync(USAGE_EVENTS_ROLLUP_PATH, "utf8"));
    assert.ok(rollup2.byteOffset > offsetAfterSnap1, "checkpoint byteOffset advanced on append");

    // Compare against pure aggregateProviderUsage on the full unrotated event list
    const expected90d = aggregateProviderUsage(
      allRecorded.filter((e) => Date.parse(e.at) >= now - 90 * dayMs),
      { days: 90, now },
    );
    const expectedRetained = aggregateProviderUsage(allRecorded, {
      days: Number.POSITIVE_INFINITY,
      now,
    });

    assert.deepEqual(snap2.contextEfficiency, expected90d.contextEfficiency);
    assert.equal(snap2.retained.from, allRecorded[0].at);
    assert.equal(snap2.retained.to, allRecorded.at(-1).at);

    for (const providerId of ["deepseek", "grok-oauth", "openai"]) {
      const actual90 = snap2.providers.find((p) => p.id === providerId);
      const exp90 = expected90d.providers.find((p) => p.id === providerId);
      const { account: _omitAccount, ...actual90WithoutAccount } = actual90;
      assert.deepEqual(actual90WithoutAccount, exp90);

      const actualRet = snap2.retained.providers.find((p) => p.id === providerId);
      const expRet = expectedRetained.providers.find((p) => p.id === providerId);
      assert.deepEqual(actualRet, expRet);
    }
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
