import { existsSync } from "node:fs";
import { PROVIDERS } from "./model-registry.mjs";
import { providerAccountUsageSnapshot } from "./provider-account-usage.mjs";
import { canonicalProviderId, readProviderSelection } from "./provider-selection.mjs";
import {
  USAGE_EVENTS_PATH,
  USAGE_EVENTS_ROLLUP_PATH,
  allUsageEvents,
  syncUsageEventsRollup,
} from "./usage-events.mjs";

export const PROVIDER_USAGE_ROLLUP_PATH = USAGE_EVENTS_ROLLUP_PATH;

// OpenAI's account stream reports dailyUsageBuckets keyed by UTC calendar day.
// These router-derived buckets were keyed by the machine's local day, so the
// two day spaces were merged by string in mergeAccountUsageBuckets() and drawn
// on one chart as if they described the same window. East of UTC that silently
// misattributed every bar by the zone's offset, and the current local day had
// no account bucket to match at all until the offset elapsed -- a Pro account
// mid-session showed "today: 0" every morning. One day space, and it has to be
// the one the authoritative stream already uses.
function dateKey(value) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Fastest published serving rates are a few hundred tokens per second; this
// is set well above them so a genuinely fast model is never discarded.
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 500;
const ROLLING_24H_MS = 24 * 60 * 60 * 1_000;

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function optionalNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function hasMeteredUsage(event) {
  return event?.totalTokens !== undefined
    || event?.inputTokens !== undefined
    || event?.outputTokens !== undefined
    || event?.billedInputTokens !== undefined
    || event?.billedOutputTokens !== undefined;
}

// Routed slugs are provider-qualified (`kimi-oauth/k3`); native ones are bare
// (`gpt-5.6-sol`). The tray groups under a provider already, so drop the prefix.
function modelDisplayName(slug) {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1) || slug;
}

// Native OpenAI traffic never routes through a registry provider, so seed a
// bucket for it; otherwise the busiest models on the box are dropped outright.
// This is router-observed traffic only — subscription quota still comes from
// the separate Codex account-usage path.
const NATIVE_OPENAI = {
  id: "openai",
  displayName: "ChatGPT (native)",
  kind: "oauth",
};

function providerUsageRecord(provider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    credentialType: provider.kind === "oauth"
      ? "oauth"
      : provider.authMode === "anonymous"
        ? "anonymous"
        : provider.authMode === "per-model"
          ? "per-model"
          : "api",
    scope: "local-router",
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    last24hInputTokens: 0,
    last24hRegularInputTokens: 0,
    last24hCachedInputTokens: 0,
    last24hOutputTokens: 0,
    last24hTokens: 0,
    last24hRequests: 0,
    last24hMeteredRequests: 0,
    daily: new Map(),
    models: new Map(),
  };
}

export function aggregateProviderUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const rolling24hCutoff = now - ROLLING_24H_MS;
  // Prefix-cache telemetry is orthogonal to provider totals: a cache hit is
  // still part of the prompt the provider billed, but it is useful on its own
  // as an indication of how much context was reused. Keep the aggregate here
  // so the Electron dashboard does not have to reconstruct it from its short
  // 24-hour probe (which is capped and can omit older rows on a busy install).
  let cacheTelemetrySeen = false;
  let last24hCachedInputTokens = 0;
  const dailyCachedInputTokens = new Map();
  // Protocol variants never appear as usage rows: their events, quota
  // headers, and activity are all folded into the canonical family provider.
  const byProvider = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map((provider) => [
      provider.id,
      providerUsageRecord(provider),
    ]),
  );

  for (const event of events) {
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    const rawProvider = typeof event?.provider === "string" && event.provider.trim()
      ? event.provider.trim()
      : "unknown";
    const providerId = canonicalProviderId(rawProvider);
    let provider = byProvider.get(providerId);
    if (!provider) {
      // Rows can outlive a registry entry after a provider is removed or
      // renamed. Keep a clearly marked historical bucket so "All router
      // traffic" remains an accounting identity instead of silently dropping
      // the request and its tokens.
      provider = providerUsageRecord({
        id: providerId,
        displayName: providerId === "unknown"
          ? "Unknown provider"
          : `Historical provider (${providerId})`,
        kind: "openai-compatible",
      });
      provider.credentialType = "unknown";
      byProvider.set(providerId, provider);
    }
    if (event.meteringVersion !== 1 && !hasMeteredUsage(event)) continue;
    provider.requests += 1;
    if (event.status >= 200 && event.status < 400) provider.successfulRequests += 1;
    const selectedOutputTokens = nonnegative(event.outputTokens);
    const inputTokens = nonnegative(event.billedInputTokens ?? event.inputTokens);
    const outputTokens = nonnegative(event.billedOutputTokens ?? event.outputTokens);
    const totalTokens = nonnegative(
      event.billedInputTokens !== undefined || event.billedOutputTokens !== undefined
        ? inputTokens + outputTokens
        : event.totalTokens ?? (event.inputTokens !== undefined || event.outputTokens !== undefined
          ? inputTokens + outputTokens
          : 0),
    );
    if (hasMeteredUsage(event)) {
      provider.meteredRequests += 1;
    }
    provider.inputTokens += inputTokens;
    provider.outputTokens += outputTokens;
    provider.totalTokens += totalTokens;
    const day = dateKey(at);
    const cachedInputTokens = optionalNonnegative(event.cachedInputTokens);
    // Cache hits are a subset of prompt input, not an extra token stream. Keep
    // the reported input total intact and expose the non-cached remainder as a
    // separate series for the UI. A partial row that reports cache telemetry
    // without its prompt total cannot establish how many input tokens were
    // billed, so never let it inflate cache above measured input.
    const measuredCached = cachedInputTokens === undefined
      ? 0
      : Math.min(cachedInputTokens, inputTokens);
    const regularInput = Math.max(0, inputTokens - measuredCached);
    provider.cachedInputTokens += measuredCached;
    provider.regularInputTokens += regularInput;
    if (cachedInputTokens !== undefined) {
      cacheTelemetrySeen = true;
      if (at >= rolling24hCutoff) last24hCachedInputTokens += measuredCached;
      const cachedDay = dailyCachedInputTokens.get(day) || 0;
      dailyCachedInputTokens.set(day, cachedDay + measuredCached);
    }
    if (at >= rolling24hCutoff) {
      provider.last24hInputTokens += inputTokens;
      provider.last24hRegularInputTokens += regularInput;
      provider.last24hCachedInputTokens += measuredCached;
      provider.last24hOutputTokens += outputTokens;
      provider.last24hTokens += totalTokens;
      provider.last24hRequests += 1;
      if (hasMeteredUsage(event)) {
        provider.last24hMeteredRequests += 1;
      }
    }
    const bucket = provider.daily.get(day) || {
      startDate: day,
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    bucket.tokens += totalTokens;
    bucket.requests += 1;
    bucket.inputTokens += inputTokens;
    bucket.cachedInputTokens += measuredCached;
    bucket.outputTokens += outputTokens;
    provider.daily.set(day, bucket);

    const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
    const model = provider.models.get(slug) || {
      slug,
      displayName: modelDisplayName(slug),
      requests: 0,
      successfulRequests: 0,
      meteredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      speedSamples: [],
      firstTokenSamples: [],
      lastUsedAt: new Date(at).toISOString(),
    };
    model.requests += 1;
    if (event.status >= 200 && event.status < 400) model.successfulRequests += 1;
    if (hasMeteredUsage(event)) {
      model.meteredRequests += 1;
    }
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.totalTokens += totalTokens;
    const durationMs = nonnegative(event.durationMs);
    const responseStartMs = optionalNonnegative(event.responseStartMs);
    // Output tokens per second is defined as the rate *after* the first token,
    // with the wait before it reported separately as time-to-first-token --
    // that is how every published benchmark states it, and it is the only
    // split that does not change with reply length. Dividing by the time since
    // the response headers instead buries a reasoning model's silent thinking
    // in the denominator, which made a 31-token reply read at 12 tok/s and a
    // 426-token one at 69 on the same model.
    const firstTokenMs = optionalNonnegative(event.firstTokenMs);
    const generationDurationMs = durationMs - (firstTokenMs ?? durationMs);
    // The numerator must count exactly the tokens generated inside that
    // window. Reasoning tokens are generated inside it when the provider
    // streamed reasoning deltas (the clock started on the first of them), and
    // before it when the provider thought in silence until the first visible
    // token. Only the second case subtracts them; without the marker (rows
    // written before it existed) the inclusive count is the closer answer on
    // every route seen so far. Provider totals still count full output.
    const speedOutputTokens = tokensGeneratedAfterFirstToken(event, selectedOutputTokens);
    // A long Codex turn can trip the empty-completion hold budget and still
    // finish as a normal 200 with streamed tokens. That flag means "we
    // stopped waiting to classify emptiness", not "this rate is unusable".
    // Keep those replies; drop only empty/retried/canceled ones.
    const measurable =
      event.status >= 200 &&
      event.status < 400 &&
      !event.retries &&
      event.emptyCompletion !== true &&
      event.emptyCompletionRetried !== true &&
      event.progressOnlyRetried !== true;
    // Detection can fail on a converted stream -- the first token is noticed
    // near the end, so thousands of tokens appear to arrive in milliseconds.
    // No served model streams anywhere near this fast, so treat it as a broken
    // sample rather than a record-breaking one.
    const impossibleRate =
      (speedOutputTokens * 1_000) / generationDurationMs >
      MAX_PLAUSIBLE_TOKENS_PER_SECOND;
    if (
      measurable &&
      speedOutputTokens > 0 &&
      firstTokenMs !== undefined &&
      generationDurationMs > 0 &&
      !impossibleRate
    ) {
      model.speedSamples.push({ outputTokens: speedOutputTokens, generationDurationMs });
      // Keep the displayed rate current instead of averaging the model's
      // entire 90-day usage history. Twenty replies smooth one-off bursts
      // without letting old sessions dominate the result.
      if (model.speedSamples.length > 20) model.speedSamples.shift();
    }
    // Time-to-first-token stands on its own: it is the pause the operator
    // actually feels before anything appears, and on a reasoning model it is
    // roughly half the request. Sampled from the same events, so a turn that
    // is unfit for a rate is unfit for this too.
    if (measurable && firstTokenMs !== undefined && firstTokenMs > 0 && firstTokenMs <= durationMs) {
      model.firstTokenSamples.push(firstTokenMs);
      if (model.firstTokenSamples.length > 20) model.firstTokenSamples.shift();
    }
    if (at >= Date.parse(model.lastUsedAt)) model.lastUsedAt = new Date(at).toISOString();
    provider.models.set(slug, model);
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    ...(cacheTelemetrySeen
      ? {
          contextEfficiency: {
            last24hCachedInputTokens,
            dailyCachedInputTokens: [...dailyCachedInputTokens.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([startDate, cachedInputTokens]) => ({ startDate, cachedInputTokens })),
          },
        }
      : {}),
    providers: [...byProvider.values()].map(({ daily, models, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...models.values()]
        .map(({ speedSamples, firstTokenSamples, ...model }) => {
          // Median of per-reply rates, not total tokens over total time. A
          // pooled ratio lets one bad sample carry the answer: a stream whose
          // first token is detected late reports thousands of tokens across a
          // fraction of a second, and summing puts that straight into the
          // numerator. Observed live -- one provider produced 11,656 tok/s
          // this way and dragged a 20-sample window to 711 while every sane
          // reply in it sat near 114. A median cannot be moved by a minority
          // of impossible samples, and needs no threshold to tune.
          const rates = speedSamples
            .map((sample) => (sample.outputTokens * 1_000) / sample.generationDurationMs)
            .sort((left, right) => left - right);
          return {
            ...model,
            speedSampleCount: speedSamples.length,
            // Median, not mean: one cold start or one queued request would
            // drag an average far more than it reflects a typical turn.
            observedFirstTokenMs: firstTokenSamples.length
              ? [...firstTokenSamples].sort((left, right) => left - right)[
                  Math.floor(firstTokenSamples.length / 2)
                ]
              : null,
            observedTokensPerSecond: rates.length
              ? Math.round(rates[Math.floor(rates.length / 2)] * 10) / 10
              : null,
          };
        })
        .sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
    })),
  };
}

// Some providers report output tokens that already exclude reasoning (a
// reasoning count larger than the output count proves it), so the inclusive
// total is rebuilt before deciding whether to subtract.
export function tokensGeneratedAfterFirstToken(event, outputTokens) {
  const reasoningTokens = optionalNonnegative(event.reasoningTokens) ?? 0;
  const inclusiveOutputTokens =
    reasoningTokens > outputTokens ? outputTokens + reasoningTokens : outputTokens;
  if (event.reasoningStreamed === false) {
    return Math.max(0, inclusiveOutputTokens - reasoningTokens);
  }
  return inclusiveOutputTokens;
}

function seedByProviderMap() {
  return new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map(
      (provider) => [provider.id, providerUsageRecord(provider)],
    ),
  );
}

function getOrCreateProvider(byProvider, providerId) {
  let provider = byProvider.get(providerId);
  if (!provider) {
    provider = providerUsageRecord({
      id: providerId,
      displayName:
        providerId === "unknown"
          ? "Unknown provider"
          : `Historical provider (${providerId})`,
      kind: "openai-compatible",
    });
    provider.credentialType = "unknown";
    byProvider.set(providerId, provider);
  }
  return provider;
}

function finalizeAggregatedProviders(
  byProvider,
  { now, cacheTelemetrySeen, last24hCachedInputTokens, dailyCachedInputTokens },
) {
  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    ...(cacheTelemetrySeen
      ? {
          contextEfficiency: {
            last24hCachedInputTokens,
            dailyCachedInputTokens: [...dailyCachedInputTokens.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([startDate, cachedInputTokens]) => ({ startDate, cachedInputTokens })),
          },
        }
      : {}),
    providers: [...byProvider.values()].map(({ daily, models, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...models.values()]
        .map(({ speedSamples, firstTokenSamples, ...model }) => {
          const rates = speedSamples
            .map((sample) => (sample.outputTokens * 1_000) / sample.generationDurationMs)
            .sort((left, right) => left - right);
          return {
            ...model,
            speedSampleCount: speedSamples.length,
            observedFirstTokenMs: firstTokenSamples.length
              ? [...firstTokenSamples].sort((left, right) => left - right)[
                  Math.floor(firstTokenSamples.length / 2)
                ]
              : null,
            observedTokensPerSecond: rates.length
              ? Math.round(rates[Math.floor(rates.length / 2)] * 10) / 10
              : null,
          };
        })
        .sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
    })),
  };
}

function applyRecentTupleToProvider(provider, day, tuple) {
  const [
    at,
    ,
    ,
    slug,
    isSuccess,
    isMetered,
    inputTokens,
    regularInput,
    measuredCached,
    ,
    outputTokens,
    totalTokens,
    speedSample,
    firstTokenSample,
  ] = tuple;
  provider.requests += 1;
  if (isSuccess) provider.successfulRequests += 1;
  if (isMetered) provider.meteredRequests += 1;
  provider.inputTokens += inputTokens;
  provider.regularInputTokens += regularInput;
  provider.cachedInputTokens += measuredCached;
  provider.outputTokens += outputTokens;
  provider.totalTokens += totalTokens;

  const bucket = provider.daily.get(day) || {
    startDate: day,
    tokens: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  bucket.tokens += totalTokens;
  bucket.requests += 1;
  bucket.inputTokens += inputTokens;
  bucket.cachedInputTokens += measuredCached;
  bucket.outputTokens += outputTokens;
  provider.daily.set(day, bucket);

  const isoAt = new Date(at).toISOString();
  const model = provider.models.get(slug) || {
    slug,
    displayName: modelDisplayName(slug),
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    speedSamples: [],
    firstTokenSamples: [],
    lastUsedAt: isoAt,
  };
  model.requests += 1;
  if (isSuccess) model.successfulRequests += 1;
  if (isMetered) model.meteredRequests += 1;
  model.inputTokens += inputTokens;
  model.outputTokens += outputTokens;
  model.totalTokens += totalTokens;
  if (speedSample) {
    model.speedSamples.push(speedSample);
    if (model.speedSamples.length > 20) model.speedSamples.shift();
  }
  if (firstTokenSample !== null && firstTokenSample !== undefined) {
    model.firstTokenSamples.push(firstTokenSample);
    if (model.firstTokenSamples.length > 20) model.firstTokenSamples.shift();
  }
  if (at >= Date.parse(model.lastUsedAt)) model.lastUsedAt = isoAt;
  provider.models.set(slug, model);
}

function buildSnapshotsFromRollup(rollupProviderUsage, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const rolling24hCutoff = now - ROLLING_24H_MS;
  const recentEvents = Array.isArray(rollupProviderUsage?.recentEvents)
    ? rollupProviderUsage.recentEvents
    : [];
  const oldestRecentAt = recentEvents.length > 0 ? recentEvents[0][0] : Number.POSITIVE_INFINITY;

  // 1. Build rolling `days` snapshot
  const snapshotByProvider = seedByProviderMap();
  let snapshotCacheSeen = false;
  let snapshotLast24hCached = 0;
  const snapshotDailyCached = new Map();

  const dailyBuckets = rollupProviderUsage?.dailyBuckets || {};
  const sortedDays = Object.keys(dailyBuckets).sort();
  for (const day of sortedDays) {
    const dayBucket = dailyBuckets[day];
    if (!dayBucket || dayBucket.maxAt < cutoff || dayBucket.minAt > now) continue;
    const straddles = dayBucket.minAt < cutoff || dayBucket.maxAt > now;
    if (straddles && dayBucket.minAt >= oldestRecentAt) {
      for (const tuple of recentEvents) {
        if (tuple[1] !== day) continue;
        const at = tuple[0];
        if (at < cutoff || at > now) continue;
        const provider = getOrCreateProvider(snapshotByProvider, tuple[2]);
        applyRecentTupleToProvider(provider, day, tuple);
        if (tuple[9]) {
          snapshotCacheSeen = true;
          snapshotDailyCached.set(day, (snapshotDailyCached.get(day) || 0) + tuple[8]);
        }
      }
      continue;
    }

    if (dayBucket.cacheTelemetrySeen) {
      snapshotCacheSeen = true;
      snapshotDailyCached.set(
        day,
        (snapshotDailyCached.get(day) || 0) + (dayBucket.cachedInputTokens || 0),
      );
    }
    for (const [providerId, dProv] of Object.entries(dayBucket.providers || {})) {
      const provider = getOrCreateProvider(snapshotByProvider, providerId);
      provider.requests += dProv.requests || 0;
      provider.successfulRequests += dProv.successfulRequests || 0;
      provider.meteredRequests += dProv.meteredRequests || 0;
      provider.inputTokens += dProv.inputTokens || 0;
      provider.regularInputTokens += dProv.regularInputTokens || 0;
      provider.cachedInputTokens += dProv.cachedInputTokens || 0;
      provider.outputTokens += dProv.outputTokens || 0;
      provider.totalTokens += dProv.totalTokens || 0;
      provider.daily.set(day, {
        startDate: day,
        tokens: dProv.totalTokens || 0,
        requests: dProv.requests || 0,
        inputTokens: dProv.inputTokens || 0,
        cachedInputTokens: dProv.cachedInputTokens || 0,
        outputTokens: dProv.outputTokens || 0,
      });
      for (const [slug, dModel] of Object.entries(dProv.models || {})) {
        const model = provider.models.get(slug) || {
          slug,
          displayName: dModel.displayName || modelDisplayName(slug),
          requests: 0,
          successfulRequests: 0,
          meteredRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          speedSamples: [],
          firstTokenSamples: [],
          lastUsedAt: dModel.lastUsedAt,
        };
        model.requests += dModel.requests || 0;
        model.successfulRequests += dModel.successfulRequests || 0;
        model.meteredRequests += dModel.meteredRequests || 0;
        model.inputTokens += dModel.inputTokens || 0;
        model.outputTokens += dModel.outputTokens || 0;
        model.totalTokens += dModel.totalTokens || 0;
        if (Array.isArray(dModel.speedSamples) && dModel.speedSamples.length > 0) {
          model.speedSamples.push(...dModel.speedSamples);
          if (model.speedSamples.length > 20) {
            model.speedSamples.splice(0, model.speedSamples.length - 20);
          }
        }
        if (Array.isArray(dModel.firstTokenSamples) && dModel.firstTokenSamples.length > 0) {
          model.firstTokenSamples.push(...dModel.firstTokenSamples);
          if (model.firstTokenSamples.length > 20) {
            model.firstTokenSamples.splice(0, model.firstTokenSamples.length - 20);
          }
        }
        if (Date.parse(dModel.lastUsedAt) >= Date.parse(model.lastUsedAt)) {
          model.lastUsedAt = dModel.lastUsedAt;
        }
        provider.models.set(slug, model);
      }
    }
  }

  // 2. Build all-time `retained` snapshot
  const retainedByProvider = seedByProviderMap();
  const retainedState = rollupProviderUsage?.retained || {};
  const retainedCacheSeen = Boolean(retainedState.cacheTelemetrySeen);
  let retainedLast24hCached = 0;
  const retainedDailyCached = new Map(
    Object.entries(retainedState.dailyCachedInputTokens || {}),
  );

  for (const [providerId, rProv] of Object.entries(retainedState.providers || {})) {
    const provider = getOrCreateProvider(retainedByProvider, providerId);
    provider.requests = rProv.requests || 0;
    provider.successfulRequests = rProv.successfulRequests || 0;
    provider.meteredRequests = rProv.meteredRequests || 0;
    provider.inputTokens = rProv.inputTokens || 0;
    provider.regularInputTokens = rProv.regularInputTokens || 0;
    provider.cachedInputTokens = rProv.cachedInputTokens || 0;
    provider.outputTokens = rProv.outputTokens || 0;
    provider.totalTokens = rProv.totalTokens || 0;
    for (const [day, dBucket] of Object.entries(rProv.daily || {})) {
      provider.daily.set(day, { ...dBucket });
    }
    for (const [slug, rModel] of Object.entries(rProv.models || {})) {
      provider.models.set(slug, {
        ...rModel,
        displayName: rModel.displayName || modelDisplayName(slug),
        speedSamples: Array.isArray(rModel.speedSamples) ? [...rModel.speedSamples] : [],
        firstTokenSamples: Array.isArray(rModel.firstTokenSamples)
          ? [...rModel.firstTokenSamples]
          : [],
      });
    }
  }

  // 3. Populate rolling 24h counters on both snapshot and retained from recentEvents
  const snapshot24hFloor = Math.max(cutoff, rolling24hCutoff);
  for (const tuple of recentEvents) {
    const [
      at,
      ,
      providerId,
      ,
      ,
      isMetered,
      inputTokens,
      regularInput,
      measuredCached,
      hasCache,
      outputTokens,
      totalTokens,
    ] = tuple;
    if (at > now) continue;
    if (at >= rolling24hCutoff) {
      const rProvider = getOrCreateProvider(retainedByProvider, providerId);
      rProvider.last24hInputTokens += inputTokens;
      rProvider.last24hRegularInputTokens += regularInput;
      rProvider.last24hCachedInputTokens += measuredCached;
      rProvider.last24hOutputTokens += outputTokens;
      rProvider.last24hTokens += totalTokens;
      rProvider.last24hRequests += 1;
      if (isMetered) rProvider.last24hMeteredRequests += 1;
      if (hasCache) retainedLast24hCached += measuredCached;
    }
    if (at >= snapshot24hFloor) {
      const sProvider = getOrCreateProvider(snapshotByProvider, providerId);
      sProvider.last24hInputTokens += inputTokens;
      sProvider.last24hRegularInputTokens += regularInput;
      sProvider.last24hCachedInputTokens += measuredCached;
      sProvider.last24hOutputTokens += outputTokens;
      sProvider.last24hTokens += totalTokens;
      sProvider.last24hRequests += 1;
      if (isMetered) sProvider.last24hMeteredRequests += 1;
      if (hasCache) snapshotLast24hCached += measuredCached;
    }
  }

  const snapshot = finalizeAggregatedProviders(snapshotByProvider, {
    now,
    cacheTelemetrySeen: snapshotCacheSeen,
    last24hCachedInputTokens: snapshotLast24hCached,
    dailyCachedInputTokens: snapshotDailyCached,
  });
  const retained = finalizeAggregatedProviders(retainedByProvider, {
    now,
    cacheTelemetrySeen: retainedCacheSeen,
    last24hCachedInputTokens: retainedLast24hCached,
    dailyCachedInputTokens: retainedDailyCached,
  });

  const retainedFrom = Number.isFinite(retainedState.fromMs)
    ? retainedState.fromMs
    : Number.POSITIVE_INFINITY;
  const retainedTo = Number.isFinite(retainedState.toMs)
    ? retainedState.toMs
    : Number.NEGATIVE_INFINITY;

  return { snapshot, retained, retainedFrom, retainedTo };
}

export async function providerUsageSnapshot(options = {}) {
  const days = options.days || 90;
  const now = options.now ?? Date.now();
  let snapshot;
  let retained;
  let retainedFrom = Number.POSITIVE_INFINITY;
  let retainedTo = Number.NEGATIVE_INFINITY;

  if (Array.isArray(options.events)) {
    const retainedEvents = options.events;
    const cutoff = now - days * 24 * 60 * 60 * 1_000;
    const recentEvents = retainedEvents
      .filter((event) => Date.parse(event.at) >= cutoff)
      .slice(-100_000);
    snapshot = aggregateProviderUsage(recentEvents, { ...options, days, now });
    retained = aggregateProviderUsage(retainedEvents, {
      ...options,
      days: Number.POSITIVE_INFINITY,
      now,
    });
    for (const event of retainedEvents) {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at > now) continue;
      retainedFrom = Math.min(retainedFrom, at);
      retainedTo = Math.max(retainedTo, at);
    }
  } else {
    const rollup = syncUsageEventsRollup();
    const toMs = rollup.providerUsage?.retained?.toMs;
    if (toMs !== null && Number.isFinite(toMs) && now < toMs && !existsSync(`${USAGE_EVENTS_PATH}.1`)) {
      const retainedEvents = allUsageEvents();
      const cutoff = now - days * 24 * 60 * 60 * 1_000;
      const recentEvents = retainedEvents
        .filter((event) => Date.parse(event.at) >= cutoff)
        .slice(-100_000);
      snapshot = aggregateProviderUsage(recentEvents, { ...options, days, now });
      retained = aggregateProviderUsage(retainedEvents, {
        ...options,
        days: Number.POSITIVE_INFINITY,
        now,
      });
      for (const event of retainedEvents) {
        const at = Date.parse(event.at);
        if (!Number.isFinite(at) || at > now) continue;
        retainedFrom = Math.min(retainedFrom, at);
        retainedTo = Math.max(retainedTo, at);
      }
    } else {
      ({ snapshot, retained, retainedFrom, retainedTo } = buildSnapshotsFromRollup(
        rollup.providerUsage,
        { days, now },
      ));
    }
  }

  const accounts = await providerAccountUsageSnapshot({
    ...options,
    providerIds: readProviderSelection(),
  });
  return {
    ...snapshot,
    retained: {
      fetchedAt: retained.fetchedAt,
      scope: "local-router-retained",
      from: Number.isFinite(retainedFrom) ? new Date(retainedFrom).toISOString() : null,
      to: Number.isFinite(retainedTo) ? new Date(retainedTo).toISOString() : null,
      providers: retained.providers,
    },
    providers: snapshot.providers.map((provider) => ({
      ...provider,
      // Consumers decode `account` as a required field, so never leave it unset
      // for providers the account layer does not cover (native OpenAI).
      account: accounts[provider.id] || {
        status: "local-only",
        source: "local-router",
        metrics: [],
        message: "Router-observed traffic; subscription quota is tracked separately.",
      },
    })),
  };
}
