// Passive rate-limit discovery.
//
// Most OpenAI-compatible providers report the caller's remaining quota on every
// response through `x-ratelimit-*` headers, and Anthropic reports the same facts
// under an `anthropic-ratelimit-*` prefix. Reading them costs no extra request
// and needs no provider-specific balance endpoint, so a provider reports its own
// limits as soon as the user makes a real call.
//
// This module is pure parsing. Persistence lives in rate-limit-state.mjs.

const DURATION_PATTERN = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)m?s)?$/;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function count(value) {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

// Providers express resets three different ways: a Go-style duration
// ("2m59.56s", "7.66s"), bare seconds ("60"), or an absolute timestamp. All three
// normalize to an absolute epoch milliseconds value so consumers never re-parse.
export function resetAt(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  const bare = finiteNumber(text);
  if (bare !== undefined) {
    // A plain number is seconds-from-now when small, and an epoch when it is
    // large enough to be a real timestamp (some gateways send epoch seconds).
    if (bare >= 1_000_000_000) return Math.round(bare * (bare >= 1e12 ? 1 : 1000));
    return bare >= 0 ? now + Math.round(bare * 1000) : undefined;
  }

  const duration = DURATION_PATTERN.exec(text.toLowerCase());
  if (duration && duration.slice(1).some(Boolean)) {
    const hours = finiteNumber(duration[1]) || 0;
    const minutes = finiteNumber(duration[2]) || 0;
    const seconds = finiteNumber(duration[3]) || 0;
    const ms = text.toLowerCase().endsWith("ms") ? seconds : seconds * 1000;
    return now + Math.round(hours * 3_600_000 + minutes * 60_000 + ms);
  }

  const absolute = Date.parse(text);
  return Number.isFinite(absolute) ? absolute : undefined;
}

function window(headers, limitKeys, remainingKeys, resetKeys, now) {
  const read = (keys) => {
    for (const key of keys) {
      const value = headers.get(key);
      if (value !== null && value !== undefined && String(value).trim() !== "") return value;
    }
    return undefined;
  };
  const limit = count(read(limitKeys));
  const remaining = count(read(remainingKeys));
  const reset = resetAt(read(resetKeys), now);
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { resetAt: new Date(reset).toISOString() } : {}),
  };
}

// `headers` is a fetch Headers instance (case-insensitive lookup).
export function parseRateLimitHeaders(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;

  const requests = window(
    headers,
    ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit", "x-ratelimit-limit"],
    [
      "x-ratelimit-remaining-requests",
      "anthropic-ratelimit-requests-remaining",
      "x-ratelimit-remaining",
    ],
    ["x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset", "x-ratelimit-reset"],
    now,
  );
  const tokens = window(
    headers,
    ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"],
    ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"],
    ["x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"],
    now,
  );
  const retryAt = resetAt(headers.get("retry-after"), now);

  if (!requests && !tokens && retryAt === undefined) return undefined;
  return {
    ...(requests ? { requests } : {}),
    ...(tokens ? { tokens } : {}),
    ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
  };
}

// Pool selection needs one unambiguous unit per credential. Only a complete
// request window is safe to attach to the key that produced this response;
// token windows are intentionally left in provider-level telemetry because a
// streamed usage event is not guaranteed to retain the winning credential id.
export function requestQuotaFromRateLimitHeaders(headers, { now = Date.now() } = {}) {
  const requests = parseRateLimitHeaders(headers, { now })?.requests;
  if (!(requests?.limit > 0) || !Number.isFinite(requests.remaining)) return undefined;
  return {
    unit: "requests",
    limit: requests.limit,
    remaining: requests.remaining,
    ...(requests.resetAt ? { resetAt: requests.resetAt } : {}),
    observedAt: new Date(now).toISOString(),
  };
}

// `Retry-After` in seconds-from-now, whichever of its two legal forms the
// provider chose. RFC 9110 allows an HTTP-date as well as delay-seconds, so
// reading the header as a bare number answers NaN for a value that is perfectly
// valid. Every caller that turns this header into behavior -- a failover
// decision, a provider cooldown, the "retry in about Ns" hint -- discards NaN,
// so a dated header reads as "the provider said nothing" and the window it
// named is spent re-asking a provider that already answered the question.
//
// `undefined` means the provider named no window at all -- the header is
// absent or unparseable -- and every caller treats that as "decide for
// yourself". A number is what it said, including `0`: RFC 9110's
// delay-seconds is a non-negative integer, so `Retry-After: 0` is a provider
// answering "now", not a provider staying silent, and a date whose instant has
// already passed says the same thing. Distinguishing the two is this
// function's whole job; whether a zero-length wait is worth wording is the
// caller's, and `translateGatewayError` decides it there.
//
// Absence is the case that made this worth a shared helper alongside the date
// form: `headers.get` answers null for a header that was never sent, and
// `Number(null)` is 0 -- a finite value the old call sites could not tell from
// a real zero.
export function retryAfterSeconds(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;
  const at = resetAt(headers.get("retry-after"), now);
  if (at === undefined) return undefined;
  // `ceil` keeps a sub-second wait at 1 rather than rounding it into the zero
  // that means "no wait"; the clamp keeps an elapsed window there instead of
  // reporting a negative one.
  return Math.max(0, Math.ceil((at - now) / 1_000));
}

// The soonest moment a provider is worth retrying, or undefined when nothing in
// the response says the caller is currently limited. A cooldown map reads this.
export function cooldownUntil(snapshot) {
  if (!snapshot) return undefined;
  const candidates = [
    snapshot.retryAt,
    snapshot.requests?.remaining === 0 ? snapshot.requests.resetAt : undefined,
    snapshot.tokens?.remaining === 0 ? snapshot.tokens.resetAt : undefined,
  ].filter(Boolean);
  if (!candidates.length) return undefined;
  return candidates.sort()[candidates.length - 1];
}

// Claude subscription quota, reported as utilization fractions on every
// response an OAuth account produces. These are the windows that drive account
// rotation, and they are a different shape from the API-key windows above:
// utilization (0-1, not a count) against a reset epoch in *seconds*, with a
// per-response upstream verdict and a model-family weekly bucket that rides
// only that family's responses. Parsed here so the forwarder's per-account
// learner and every status surface share one reading of the same headers.
//
// Header names verified against Anthropic's own subscription traffic (see
// docs/CLAUDE-ACCOUNT-ROTATION-PRD.md section 1.1); absence of any of them is
// normal -- plain API-key responses carry none -- so a partial or missing set
// means "unknown window", never an error.

const UNIFIED_STATUS_VALUES = new Set(["allowed", "allowed_warning", "rejected"]);

// An epoch-seconds reset header as epoch milliseconds, or undefined. The
// unified windows report absolute epochs (unlike the durations and relative
// seconds the API-key windows accept), so anything that is not a positive
// integer is treated as absent and never stored: a NaN reset would park an
// account out of rotation forever because `now >= NaN` is always false.
function unifiedResetMs(value) {
  // headers.get answers null for a header that was never sent, and
  // Number(null) is 0 -- a value that would parse as "epoch 0" below. An
  // absent header is absent, not a zero.
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  // 1e12 is year 33658 in seconds and ~1970-01-12 in milliseconds; above it
  // the value is already milliseconds, below it is seconds from the epoch.
  return number >= 1e12 ? number : number * 1000;
}

// A utilization fraction (0..~1.2; the family window may exceed 1 in overage),
// or undefined when the header is absent or not a finite number.
function utilizationFraction(value) {
  // The same null-as-zero trap: Number(null) is 0, so a window an absent
  // header never reported would read as freshly empty.
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function unifiedWindow(utilization, resetValue, now = Date.now()) {
  const used = utilizationFraction(utilization);
  const resetMs = unifiedResetMs(resetValue);
  if (used === undefined && resetMs === undefined) return undefined;
  return {
    ...(used !== undefined ? {
      usedPercent: Math.round(used * 100),
      remainingPercent: Math.max(0, Math.round((1 - used) * 100)),
    } : {}),
    ...(resetMs !== undefined ? { resetsAtMs: resetMs } : {}),
  };
}

function unifiedStatus(value, now = Date.now()) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UNIFIED_STATUS_VALUES.has(text) ? { value: text, seenAtMs: now } : undefined;
}

// The whole Claude unified reading from one response's headers. `headers` is a
// fetch Headers instance (case-insensitive), matching parseRateLimitHeaders.
// Every field is optional: a response may report only the windows it can see,
// and an empty reading returns undefined so callers skip persistence entirely.
export function parseClaudeUnifiedHeaders(headers, { now = Date.now() } = {}) {
  if (!headers || typeof headers.get !== "function") return undefined;
  const fiveHour = unifiedWindow(
    headers.get("anthropic-ratelimit-unified-5h-utilization"),
    headers.get("anthropic-ratelimit-unified-5h-reset"),
    now,
  );
  const weekly = unifiedWindow(
    headers.get("anthropic-ratelimit-unified-7d-utilization"),
    headers.get("anthropic-ratelimit-unified-7d-reset"),
    now,
  );
  // The 7d_oi family bucket ("7-day, overage included") rides Fable responses
  // only, so its reading carries the moment it was observed: a spent family
  // reading is trusted for a bounded staleness window and then dropped, since
  // nothing but another Fable request can refresh it.
  const fableSeenAtMs = headers.get("anthropic-ratelimit-unified-7d_oi-utilization") !== null
    ? now
    : undefined;
  const fableWindow = unifiedWindow(
    headers.get("anthropic-ratelimit-unified-7d_oi-utilization"),
    headers.get("anthropic-ratelimit-unified-7d_oi-reset"),
    now,
  );
  const fable = fableWindow && fableSeenAtMs !== undefined
    ? { ...fableWindow, seenAtMs: fableSeenAtMs }
    : undefined;
  const status = unifiedStatus(headers.get("anthropic-ratelimit-unified-status"), now);
  const fiveHourStatus = unifiedStatus(headers.get("anthropic-ratelimit-unified-5h-status"), now);
  const weeklyStatus = unifiedStatus(headers.get("anthropic-ratelimit-unified-7d-status"), now);
  const fableStatus = unifiedStatus(headers.get("anthropic-ratelimit-unified-7d_oi-status"), now);
  const windowStatuses = {
    ...(fiveHourStatus ? { fiveHour: fiveHourStatus.value } : {}),
    ...(weeklyStatus ? { weekly: weeklyStatus.value } : {}),
    ...(fableStatus ? { fable: fableStatus.value } : {}),
  };
  if (!fiveHour && !weekly && !fable && !status && !Object.keys(windowStatuses).length) {
    return undefined;
  }
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(fable ? { fable } : {}),
    ...(status ? { status: status.value, statusSeenAtMs: status.seenAtMs } : {}),
    windowStatuses,
    observedAtMs: now,
  };
}

// Which shared window (5h or 7d), if either, signed the rejection that the
// overall `-unified-status: rejected` verdict describes. A family-cap 429
// (Fable's 7d_oi bucket spent) also carries the overall rejected verdict while
// the shared 5h/7d statuses on the same response still say allowed, so a
// rejection the shared windows did not sign -- or explicitly cleared -- is the
// family's, and the account stays usable for every other model. When the
// per-window statuses are silent the overall verdict is the only signal and is
// read as shared, because assuming "family" on silence would retry a spent
// shared bucket onto the same account all night.
export function claudeSharedRejection(reading) {
  if (!reading) return false;
  if (reading.status !== "rejected") return false;
  const statuses = reading.windowStatuses || {};
  const shared = [statuses.fiveHour, statuses.weekly];
  if (shared.some((value) => value === "rejected")) return true;
  if (shared.some((value) => value && value !== "rejected")) return false;
  if (statuses.fable === "rejected") return false;
  return true;
}
