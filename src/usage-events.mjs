import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";
import { acceptedInputTokens } from "./context-window-drift.mjs";
import { serviceTierMetadata, usageDiagnosticMetadata } from "./request-diagnostics.mjs";

export const USAGE_EVENTS_PATH = path.join(STATE_DIR, "usage-events.jsonl");
export const USAGE_EVENTS_ROLLUP_PATH = path.join(STATE_DIR, "usage-events-rollup.json");
export const DEFAULT_MAX_USAGE_EVENTS_BYTES = 32 * 1024 * 1024;
export const USAGE_EVENTS_CHUNK_BYTES = 512 * 1024;

const AT_FIELD = '"at":"';
const TAIL_SLACK_MS = 10 * 60 * 1_000;
const ROTATION_CHECK_INTERVAL = 250;

function extractLineIsoAt(line) {
  const start = line.indexOf(AT_FIELD);
  if (start === -1) return undefined;
  const from = start + AT_FIELD.length;
  const end = line.indexOf('"', from);
  if (end === -1) return undefined;
  const at = line.slice(from, end);
  if (at.length !== 24 || at[at.length - 1] !== "Z") return undefined;
  return at;
}

function lineOlderThan(line, cutoffIso) {
  const at = extractLineIsoAt(line);
  if (at === undefined || at.length !== cutoffIso.length) return false;
  return at < cutoffIso;
}

export function readRecentUsageEventLines({
  filePath = USAGE_EVENTS_PATH,
  chunkBytes = USAGE_EVENTS_CHUNK_BYTES,
  cutoffIso = "",
  slackMs = TAIL_SLACK_MS,
  maxMatchingLines = Number.POSITIVE_INFINITY,
  linePredicate,
  onLine,
} = {}) {
  if (!existsSync(filePath)) return [];
  const cap = Number.isFinite(maxMatchingLines)
    ? Math.max(0, Math.floor(maxMatchingLines))
    : Number.POSITIVE_INFINITY;
  if (cap <= 0) return [];

  let stopCutoffIso = "";
  if (cutoffIso) {
    const parsedCutoff = Date.parse(cutoffIso);
    if (Number.isFinite(parsedCutoff)) {
      try {
        stopCutoffIso = new Date(parsedCutoff - Math.max(0, slackMs)).toISOString();
      } catch {
        stopCutoffIso = cutoffIso;
      }
    } else {
      stopCutoffIso = cutoffIso;
    }
  }

  let fd;
  const matchedLines = [];
  let matchCount = 0;
  try {
    fd = openSync(filePath, "r");
    const stats = fstatSync(fd);
    let endOffset = stats.size;
    if (endOffset <= 0) return [];

    const stepBytes = Math.max(64, Math.floor(chunkBytes) || USAGE_EVENTS_CHUNK_BYTES);
    const readBuf = Buffer.allocUnsafe(Math.min(stepBytes, endOffset));
    let remainder = Buffer.alloc(0);

    while (endOffset > 0 && matchCount < cap) {
      const startOffset = Math.max(0, endOffset - stepBytes);
      const lengthToRead = endOffset - startOffset;
      const bytesRead = readSync(fd, readBuf, 0, lengthToRead, startOffset);
      if (bytesRead <= 0) break;
      endOffset = startOffset;

      const slice = bytesRead === readBuf.length ? readBuf : readBuf.subarray(0, bytesRead);
      const combined = remainder.length > 0 ? Buffer.concat([slice, remainder]) : slice;

      let segmentBuf;
      if (startOffset > 0) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline === -1) {
          remainder = Buffer.from(combined);
          continue;
        }
        remainder = Buffer.from(combined.subarray(0, firstNewline));
        segmentBuf = combined.subarray(firstNewline + 1);
      } else {
        remainder = Buffer.alloc(0);
        segmentBuf = combined;
      }

      if (segmentBuf.length === 0) continue;
      const lines = segmentBuf.toString("utf8").split("\n");
      let chunkHasTimestamp = false;
      let chunkAllOlderThanStop = true;

      for (let index = lines.length - 1; index >= 0 && matchCount < cap; index -= 1) {
        let line = lines[index];
        if (!line) continue;
        if (line.charCodeAt(line.length - 1) === 13) {
          line = line.slice(0, -1);
          if (!line) continue;
        }
        if (stopCutoffIso) {
          const lineAt = extractLineIsoAt(line);
          if (lineAt !== undefined) {
            chunkHasTimestamp = true;
            if (lineAt >= stopCutoffIso) {
              chunkAllOlderThanStop = false;
            }
          }
        }
        if (cutoffIso && lineOlderThan(line, cutoffIso)) continue;
        if (linePredicate && !linePredicate(line)) continue;
        if (onLine) {
          if (onLine(line)) {
            matchCount += 1;
          }
        } else {
          matchedLines.push(line);
          matchCount += 1;
        }
      }

      if (stopCutoffIso && chunkHasTimestamp && chunkAllOlderThanStop) {
        break;
      }
    }
  } catch {
    return matchedLines.reverse();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
  return matchedLines.reverse();
}

export function forEachUsageEventLine(
  callback,
  {
    startOffset = 0,
    endOffset = Number.POSITIVE_INFINITY,
    filePath = USAGE_EVENTS_PATH,
    chunkBytes = USAGE_EVENTS_CHUNK_BYTES,
  } = {},
) {
  if (!existsSync(filePath)) return 0;
  let fd;
  let offset = Math.max(0, Math.floor(startOffset) || 0);
  try {
    fd = openSync(filePath, "r");
    const stats = fstatSync(fd);
    const targetEnd = Math.min(stats.size, Number.isFinite(endOffset) ? Math.floor(endOffset) : stats.size);
    if (offset >= targetEnd) return offset;

    const stepBytes = Math.max(64, Math.floor(chunkBytes) || USAGE_EVENTS_CHUNK_BYTES);
    const readBuf = Buffer.allocUnsafe(Math.min(stepBytes, targetEnd - offset));
    let remainder = Buffer.alloc(0);

    while (offset < targetEnd) {
      const lengthToRead = Math.min(readBuf.length, targetEnd - offset);
      const bytesRead = readSync(fd, readBuf, 0, lengthToRead, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;

      const slice = bytesRead === readBuf.length ? readBuf : readBuf.subarray(0, bytesRead);
      const combined = remainder.length > 0 ? Buffer.concat([remainder, slice]) : slice;
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        remainder = Buffer.from(combined);
        continue;
      }
      const complete = combined.subarray(0, lastNewline);
      remainder = Buffer.from(combined.subarray(lastNewline + 1));
      const lines = complete.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index];
        if (!line) continue;
        if (line.charCodeAt(line.length - 1) === 13) {
          line = line.slice(0, -1);
          if (!line) continue;
        }
        callback(line);
      }
    }
    if (remainder.length > 0) {
      const trailing = remainder.toString("utf8").replace(/\r$/, "");
      if (trailing) callback(trailing);
    }
    return offset;
  } catch {
    return offset;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

export function recentEngineeringUsageEvents({ limit = 1_000 } = {}) {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 10_000)
    : 1_000;
  const events = [];
  readRecentUsageEventLines({
    maxMatchingLines: boundedLimit,
    linePredicate: (line) => line.includes('"engineering"'),
    onLine: (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return false;
      }
      if (!event?.engineering?.bindingId || !event.engineering.usage) return false;
      events.push({
        ...event.engineering,
        at: event.at,
        model: event.model,
        provider: event.provider,
        routerRequestId: event.requestId,
        servingRoute: event.model,
        latencyMs: event.durationMs,
        retries: event.retries,
      });
      return true;
    },
  });
  return events.reverse();
}

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

// Retries are recorded only when there were any, so an ordinary event keeps the
// exact shape it always had. A transparently absorbed upstream failure records
// a 200 like any other turn, and this field is the only thing that says the
// upstream is flaky rather than healthy.
function safeRetryCount(value) {
  const count = safeTokenCount(value);
  return count ? count : undefined;
}

const ENGINEERING_TEXT_FIELDS = Object.freeze([
  "bindingId",
  "runId",
  "taskId",
  "attemptId",
  "role",
  "sourceRevision",
  "childId",
  "decisionId",
  "requestedRoute",
  "requestedEffort",
  "effectiveEffort",
  "effortSource",
  "circuitState",
  "verificationOutcome",
]);

function usageObservation(value, estimatedValue) {
  const measured = safeTokenCount(value);
  if (measured !== undefined) return { kind: "measured", value: measured };
  const estimated = safeTokenCount(estimatedValue);
  if (estimated !== undefined) return { kind: "estimated", value: estimated };
  return { kind: "unknown" };
}

// Engineering attribution is optional and strictly additive: ordinary Router
// traffic keeps its historical event shape. A resolved binding may contribute
// only bounded identifiers, never a prompt, checkout path, capability, or raw
// header. Usage quality lives beside the correlation so absent provider counts
// remain explicitly unknown instead of becoming misleading zeroes.
function engineeringUsageMetadata(engineering, usage) {
  if (!engineering || typeof engineering !== "object" || Array.isArray(engineering)) {
    return undefined;
  }
  const bindingId = safeText(engineering.bindingId, "");
  if (!bindingId) return undefined;
  const metadata = { bindingId };
  for (const field of ENGINEERING_TEXT_FIELDS) {
    if (field === "bindingId") continue;
    const value = safeText(engineering[field], "");
    if (value) metadata[field] = value;
  }
  metadata.usage = {
    inputTokens: usageObservation(usage.inputTokens, usage.estimatedInputTokens),
    cachedInputTokens: usageObservation(usage.cachedInputTokens),
    outputTokens: usageObservation(usage.outputTokens),
    reasoningTokens: usageObservation(usage.reasoningTokens),
    totalTokens: usageObservation(usage.totalTokens),
    costMicros: usageObservation(usage.costMicros),
  };
  return metadata;
}

export function recordUsageEvent({
  model,
  provider,
  status,
  durationMs,
  // Milliseconds from receiving the request until the upstream response
  // headers arrived. Together with durationMs this isolates the streamed
  // generation phase from prompt processing, queueing, and router setup.
  // Historical rows omit it and must not be used for generation-rate math.
  responseStartMs,
  // Milliseconds from receiving the request until the first generated token
  // reached the client. This -- not responseStartMs -- is the split an
  // output-tokens-per-second figure divides by, matching how the industry
  // reports it: tokens after the first token, with the wait before it counted
  // separately as time-to-first-token.
  firstTokenMs,
  // Whether reasoning deltas were relayed in the stream. Measured booleans
  // only: absent means the row predates the field and the aggregator falls
  // back to the inclusive token count.
  reasoningStreamed,
  inputTokens,
  billedInputTokens,
  cachedInputTokens,
  outputTokens,
  billedOutputTokens,
  reasoningTokens,
  totalTokens,
  retries,
  requestedServiceTier,
  serviceTier,
  serviceTierUnknown,
  // True when the upstream stream died after its 200 head was already
  // committed, so `status` had to be rewritten (e.g. 502) and this marker is
  // the only thing that says the turn was truncated rather than successful.
  // Absent on ordinary events so old rows keep their exact shape.
  streamAborted,
  // True when the upstream answered 200 with `response.completed` but never
  // produced output text or a tool call, and the router suppressed the empty
  // completion instead of letting the client record a silent success.
  emptyCompletion,
  // True when the guard retried once against the same request body, either
  // after a proven empty completion or after a pre-content safety limit.
  // `status` describes the retry's own outcome; the token counts cover both
  // attempts, because both were sent and both were billed. This marker is what
  // says the reported spend belongs to two attempts at one turn.
  emptyCompletionRetried,
  // True when the Grok OAuth forwarder retried a progress-only stop. New rows
  // keep the selected attempt in the ordinary token fields and the aggregate
  // provider spend in billedInputTokens / billedOutputTokens. Historical rows
  // summed both attempts into the ordinary fields.
  progressOnlyRetried,
  // True when the turn was empty and the router could not repair it, because
  // the attempt had already been relayed: the upstream proved it was generating
  // before it produced nothing, so the hold was over and a retry would have
  // grafted a second response onto a stream the client was already reading.
  // Kept apart from `emptyCompletionRetried` because this failure reaches the
  // user and that one does not.
  emptyCompletionUnrepairable,
  // True when the guard released the stream at its byte/time hold budget
  // without a verdict, so this turn may have been an empty completion the
  // router chose not to retry. Kept apart from `emptyCompletion` because the
  // release is the conservative path: the turn is relayed as-is and cannot be
  // proven empty, but it must not read as a guaranteed-healthy turn either.
  emptyCompletionGuardReleased,
  // The byte or time safety limit ended the pre-content hold while no output
  // had reached the client. Current routers retry that attempt once and fail
  // explicitly if the retry also reaches the limit; historical routers used
  // `emptyCompletionGuardReleased` for the old fail-open behavior above.
  emptyCompletionPreludeLimit,
  // Present only when the router replaced an upstream `input_tokens: 0` with
  // its own estimate on the way to Codex (#95). The reported counts above stay
  // exactly as the provider sent them, so an estimated turn is never mistaken
  // for the provider having recovered -- and a run of these events is the
  // signal that it has not.
  estimatedInputTokens,
  // True when the router canceled a request at its separately configured
  // execution deadline. Activity-record retention never sets this field.
  requestDeadlineExceeded,
  // Present only when the routed request compacted old results or pressure-
  // shaped noisy results. Counts and bytes describe the request sent upstream,
  // never the result contents themselves.
  toolResultsAged,
  toolResultsShaped,
  toolResultBytesBefore,
  toolResultBytesAfter,
  toolResultBytesSaved,
  toolResultShapeBytesSaved,
  // Present whenever the aging pass ran, even when it changed nothing. Every
  // count above is omitted when zero, so without these an operator who enables
  // aging and sees an empty ledger cannot tell whether the pass never ran or
  // ran and found every result under the floor. `BytesLargest` separates the
  // two: compare it against the eligibility floor.
  toolResultsEvaluated,
  toolResultBytesLargest,
  // Present only on a turn the router moved to another model because the one
  // the operator asked for reported it had no usage left. `model` and
  // `provider` above name what actually served the turn; this names what was
  // asked for. Without it a rescued turn is indistinguishable from an operator
  // who simply changed models, which is the difference between "your provider
  // is empty" and "you switched".
  failoverFrom,
  // Codex standalone search normally spends the caller's native ChatGPT
  // session. These fields distinguish an explicitly configured external
  // sidecar request and whether it was served from its account-scoped cache.
  searchSidecar,
  searchCacheHit,
  searchResults,
  // Router-generated correlation id. Matches /activity's `requestId`. Optional so
  // historical rows keep their exact shape.
  requestId,
  // Grok OAuth 4.6 ingress UTF-8 JSON byte split. Optional, bounded, and never
  // a token estimate. Missing payload fields measure as zero.
  contextBytes,
  grokStructuredPatch,
  // Sanitized metadata from a locally verified immutable engineering binding.
  // Raw request headers and caller-supplied effort values never enter this
  // object; the Router resolves the opaque binding identifier first.
  engineering,
  at = Date.now(),
}) {
  const diagnostics = usageDiagnosticMetadata({ requestId, contextBytes, grokStructuredPatch });
  const engineeringMetadata = engineeringUsageMetadata(engineering, {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    estimatedInputTokens,
  });
  const event = {
    ...serviceTierMetadata({
      requestedServiceTier,
      serviceTier,
      serviceTierUnknown,
      retries,
      emptyCompletionRetried,
    }),
    meteringVersion: 1,
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(safeTokenCount(responseStartMs) !== undefined
      ? { responseStartMs: safeTokenCount(responseStartMs) }
      : {}),
    ...(safeTokenCount(firstTokenMs) !== undefined
      ? { firstTokenMs: safeTokenCount(firstTokenMs) }
      : {}),
    ...(typeof reasoningStreamed === "boolean" ? { reasoningStreamed } : {}),
    ...(streamAborted === true ? { streamAborted: true } : {}),
    ...(emptyCompletion === true ? { emptyCompletion: true } : {}),
    ...(emptyCompletionRetried === true ? { emptyCompletionRetried: true } : {}),
    ...(progressOnlyRetried === true ? { progressOnlyRetried: true } : {}),
    ...(emptyCompletionUnrepairable === true
      ? { emptyCompletionUnrepairable: true }
      : {}),
    ...(emptyCompletionGuardReleased === true
      ? { emptyCompletionGuardReleased: true }
      : {}),
    ...(requestDeadlineExceeded === true ? { requestDeadlineExceeded: true } : {}),
    ...(emptyCompletionPreludeLimit === "bytes" ||
    emptyCompletionPreludeLimit === "time"
      ? { emptyCompletionPreludeLimit }
      : {}),
    ...(safeRetryCount(retries) !== undefined ? { retries: safeRetryCount(retries) } : {}),
    ...(typeof failoverFrom === "string" && failoverFrom.trim()
      ? { failoverFrom: safeText(failoverFrom, "unknown") }
      : {}),
    ...(searchSidecar === true ? { searchSidecar: true } : {}),
    ...(searchSidecar === true && typeof searchCacheHit === "boolean"
      ? { searchCacheHit }
      : {}),
    ...(searchSidecar === true && safeTokenCount(searchResults) !== undefined
      ? { searchResults: safeTokenCount(searchResults) }
      : {}),
    ...(safeTokenCount(inputTokens) !== undefined
      ? { inputTokens: safeTokenCount(inputTokens) }
      : {}),
    ...(safeTokenCount(billedInputTokens) !== undefined
      ? { billedInputTokens: safeTokenCount(billedInputTokens) }
      : {}),
    ...(safeTokenCount(cachedInputTokens) !== undefined
      ? { cachedInputTokens: safeTokenCount(cachedInputTokens) }
      : {}),
    ...(safeTokenCount(outputTokens) !== undefined
      ? { outputTokens: safeTokenCount(outputTokens) }
      : {}),
    ...(safeTokenCount(billedOutputTokens) !== undefined
      ? { billedOutputTokens: safeTokenCount(billedOutputTokens) }
      : {}),
    ...(safeTokenCount(reasoningTokens) !== undefined
      ? { reasoningTokens: safeTokenCount(reasoningTokens) }
      : {}),
    ...(safeTokenCount(totalTokens) !== undefined
      ? { totalTokens: safeTokenCount(totalTokens) }
      : {}),
    ...(safeTokenCount(estimatedInputTokens) !== undefined
      ? { estimatedInputTokens: safeTokenCount(estimatedInputTokens) }
      : {}),
    ...(safeTokenCount(toolResultsAged) ? { toolResultsAged: safeTokenCount(toolResultsAged) } : {}),
    ...(safeTokenCount(toolResultsShaped)
      ? { toolResultsShaped: safeTokenCount(toolResultsShaped) }
      : {}),
    ...(safeTokenCount(toolResultBytesBefore)
      ? { toolResultBytesBefore: safeTokenCount(toolResultBytesBefore) }
      : {}),
    ...(safeTokenCount(toolResultBytesAfter)
      ? { toolResultBytesAfter: safeTokenCount(toolResultBytesAfter) }
      : {}),
    ...(safeTokenCount(toolResultBytesSaved)
      ? { toolResultBytesSaved: safeTokenCount(toolResultBytesSaved) }
      : {}),
    ...(safeTokenCount(toolResultShapeBytesSaved)
      ? { toolResultShapeBytesSaved: safeTokenCount(toolResultShapeBytesSaved) }
      : {}),
    // Zero is meaningful here -- it says the pass ran and saw no tool results
    // at all -- so these are written whenever defined rather than when truthy.
    ...(safeTokenCount(toolResultsEvaluated) !== undefined
      ? { toolResultsEvaluated: safeTokenCount(toolResultsEvaluated) }
      : {}),
    ...(safeTokenCount(toolResultBytesLargest) !== undefined
      ? { toolResultBytesLargest: safeTokenCount(toolResultBytesLargest) }
      : {}),
    ...(engineeringMetadata
      ? {
          engineering: engineeringMetadata,
          bindingId: engineeringMetadata.bindingId,
          runId: engineeringMetadata.runId,
          taskId: engineeringMetadata.taskId,
          attemptId: engineeringMetadata.attemptId,
          role: engineeringMetadata.role,
          sourceRevision: engineeringMetadata.sourceRevision,
          usage: engineeringMetadata.usage,
        }
      : {}),
    ...diagnostics,
  };
  const serialized = `${JSON.stringify(event)}\n`;
  try {
    ensureStateDirAndAppend(serialized);
  } catch {
    // Usage telemetry must never interrupt or fail a model request.
  }
}

let ensuredStateDir;
let ensuredFileKey;
let writesSinceCheck = 0;
let cachedRollup = { key: undefined, data: null };

function resolveMaxUsageEventsBytes() {
  const configured = Number(process.env.CODEX_ROUTER_MAX_USAGE_EVENTS_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_USAGE_EVENTS_BYTES;
}

function ensureStateDirAndAppend(serialized) {
  if (ensuredStateDir !== STATE_DIR) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    ensuredStateDir = STATE_DIR;
  }
  try {
    appendFileSync(USAGE_EVENTS_PATH, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    ensuredStateDir = STATE_DIR;
    appendFileSync(USAGE_EVENTS_PATH, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    ensuredFileKey = undefined;
  }
  writesSinceCheck += 1;
  const shouldCheck =
    writesSinceCheck === 1 ||
    writesSinceCheck >= ROTATION_CHECK_INTERVAL ||
    process.env.CODEX_ROUTER_MAX_USAGE_EVENTS_BYTES !== undefined;
  if (!shouldCheck) return;
  writesSinceCheck = 1;

  const stats = statSync(USAGE_EVENTS_PATH);
  const fileKey = `${stats.dev}:${stats.ino}`;
  if (
    ensuredFileKey !== fileKey ||
    (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600)
  ) {
    chmodSync(USAGE_EVENTS_PATH, 0o600);
    ensuredFileKey = fileKey;
  }
  const lineBytes = Buffer.byteLength(serialized, "utf8");
  if (stats.size === lineBytes && !existsSync(`${USAGE_EVENTS_PATH}.1`)) {
    if (existsSync(USAGE_EVENTS_ROLLUP_PATH)) {
      rmSync(USAGE_EVENTS_ROLLUP_PATH, { force: true });
    }
    cachedRollup = { key: undefined, data: null };
  }
  const maxBytes = resolveMaxUsageEventsBytes();
  if (stats.size > maxBytes) {
    rotateUsageEventsFile(stats.size, maxBytes);
  }
}

// Tool-result aging writes its per-request savings into the shared usage
// events, so the running total is derived here rather than kept as a second
// counter that could drift. Bytes are what the router actually measured;
// the token figure is the usual ~4 bytes/token estimate and is labelled as
// such everywhere it surfaces.
const BYTES_PER_TOKEN_ESTIMATE = 4;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const AGING_BUCKET_RETENTION_MS = 31 * DAY_MS;
const PROVIDER_DAILY_RETENTION_DAYS = 120;
const PROVIDER_RECENT_EVENTS_RETENTION_MS = 14 * DAY_MS;
const PROVIDER_RECENT_EVENTS_MAX = 5_000;
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 500;

// The tray's range tabs. Buckets are fixed-length and end at the current
// hour/day so a quiet stretch reads as a gap instead of reflowing the chart.
const AGING_RANGES = [
  { key: "24h", bucketMs: HOUR_MS, buckets: 24 },
  { key: "7d", bucketMs: DAY_MS, buckets: 7 },
  { key: "30d", bucketMs: DAY_MS, buckets: 30 },
];

function utcDateKey(value) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function modelDisplayName(slug) {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1) || slug;
}

function emptyAgingCumulative() {
  return {
    requests: 0,
    evaluatedRequests: 0,
    largestResultBytes: 0,
    resultsAged: 0,
    resultsShaped: 0,
    bytesSaved: 0,
    firstAt: null,
    lastAt: null,
    maxHourEpoch: null,
    hourlyBuckets: {},
  };
}

function emptyProviderRetainedState() {
  return {
    fromMs: null,
    toMs: null,
    cacheTelemetrySeen: false,
    dailyCachedInputTokens: {},
    providers: {},
  };
}

function emptyProviderUsageRollup() {
  return {
    retained: emptyProviderRetainedState(),
    dailyBuckets: {},
    recentEvents: [],
  };
}

function emptyRollupState() {
  return {
    schemaVersion: 1,
    byteOffset: 0,
    firstLineHash: null,
    observedCeilings: {},
    archivedCeilings: {},
    agingCumulative: emptyAgingCumulative(),
    archivedAgingCumulative: emptyAgingCumulative(),
    providerUsage: emptyProviderUsageRollup(),
    archivedProviderUsage: emptyProviderUsageRollup(),
  };
}

function readFirstLineHash(filePath = USAGE_EVENTS_PATH) {
  if (!existsSync(filePath)) return null;
  let fd;
  try {
    fd = openSync(filePath, "r");
    const stats = fstatSync(fd);
    if (stats.size <= 0) return null;
    const probeLen = Math.min(65_536, stats.size);
    const buf = Buffer.allocUnsafe(probeLen);
    const bytesRead = readSync(fd, buf, 0, probeLen, 0);
    if (bytesRead <= 0) return null;
    const slice = buf.subarray(0, bytesRead);
    const newlineIndex = slice.indexOf(0x0a);
    const firstLine = newlineIndex === -1 ? slice : slice.subarray(0, newlineIndex);
    return createHash("sha256").update(firstLine).digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function foldEventIntoCeilings(ceilings, event) {
  const accepted = acceptedInputTokens(event);
  if (accepted === undefined) return;
  const slug = typeof event?.model === "string" ? event.model : undefined;
  if (!slug) return;
  if (accepted > (ceilings[slug] ?? 0)) {
    ceilings[slug] = accepted;
  }
}

function foldEventIntoAging(aging, event) {
  const at = typeof event?.at === "string" ? Date.parse(event.at) : NaN;
  const evaluated = safeTokenCount(event?.toolResultsEvaluated);
  if (evaluated !== undefined) {
    aging.evaluatedRequests += 1;
    const largest = safeTokenCount(event?.toolResultBytesLargest) ?? 0;
    if (largest > aging.largestResultBytes) aging.largestResultBytes = largest;
  }
  const resultsAged = safeTokenCount(event?.toolResultsAged);
  const resultsShaped = safeTokenCount(event?.toolResultsShaped);
  const resultsCompacted = (resultsAged ?? 0) + (resultsShaped ?? 0);
  if (resultsCompacted) {
    aging.requests += 1;
    aging.resultsAged += resultsAged ?? 0;
    aging.resultsShaped += resultsShaped ?? 0;
    const bytesSaved = safeTokenCount(event.toolResultBytesSaved) ?? 0;
    aging.bytesSaved += bytesSaved;
    if (typeof event.at === "string") {
      aging.firstAt = aging.firstAt ?? event.at;
      aging.lastAt = event.at;
    }
    if (Number.isFinite(at)) {
      const savedTokens = Math.round(bytesSaved / BYTES_PER_TOKEN_ESTIMATE);
      const hourEpoch = at - (at % HOUR_MS);
      if (aging.maxHourEpoch === null || hourEpoch > aging.maxHourEpoch) {
        aging.maxHourEpoch = hourEpoch;
      }
      const key = String(hourEpoch);
      const bucket = (aging.hourlyBuckets[key] ??= {
        savedTokens: 0,
        requests: 0,
        agedInput: 0,
        agedCached: 0,
        agedTurns: 0,
        unagedInput: 0,
        unagedCached: 0,
        unagedTurns: 0,
      });
      bucket.savedTokens += savedTokens;
      bucket.requests += 1;
    }
  }
  const inputTokens = safeTokenCount(event?.inputTokens);
  const cachedInputTokens = safeTokenCount(event?.cachedInputTokens);
  if (inputTokens && cachedInputTokens !== undefined && Number.isFinite(at)) {
    const hourEpoch = at - (at % HOUR_MS);
    if (aging.maxHourEpoch === null || hourEpoch > aging.maxHourEpoch) {
      aging.maxHourEpoch = hourEpoch;
    }
    const key = String(hourEpoch);
    const bucket = (aging.hourlyBuckets[key] ??= {
      savedTokens: 0,
      requests: 0,
      agedInput: 0,
      agedCached: 0,
      agedTurns: 0,
      unagedInput: 0,
      unagedCached: 0,
      unagedTurns: 0,
    });
    const clampedCached = Math.min(cachedInputTokens, inputTokens);
    if (resultsCompacted) {
      bucket.agedInput += inputTokens;
      bucket.agedCached += clampedCached;
      bucket.agedTurns += 1;
    } else {
      bucket.unagedInput += inputTokens;
      bucket.unagedCached += clampedCached;
      bucket.unagedTurns += 1;
    }
  }
}

function pruneAgingBuckets(aging) {
  if (!aging?.hourlyBuckets || aging.maxHourEpoch === null) return;
  const minHourEpoch = aging.maxHourEpoch - AGING_BUCKET_RETENTION_MS;
  for (const key of Object.keys(aging.hourlyBuckets)) {
    const epoch = Number(key);
    if (!Number.isFinite(epoch) || epoch < minHourEpoch) {
      delete aging.hourlyBuckets[key];
    }
  }
}

function emptyRollupProviderEntry() {
  return {
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    daily: {},
    models: {},
  };
}

function emptyRollupDayProviderEntry() {
  return {
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: {},
  };
}

function emptyRollupModelEntry(slug, isoAt) {
  return {
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
}

function foldEventIntoProviderUsage(providerUsage, event) {
  if (
    !event ||
    typeof event.at !== "string" ||
    typeof event.model !== "string" ||
    typeof event.provider !== "string"
  ) {
    return;
  }
  const at = Date.parse(event.at);
  if (!Number.isFinite(at)) return;

  const retained = providerUsage.retained;
  if (retained.fromMs === null || at < retained.fromMs) retained.fromMs = at;
  if (retained.toMs === null || at > retained.toMs) retained.toMs = at;

  const inputRaw = safeTokenCount(event.inputTokens);
  const billedInputRaw = safeTokenCount(event.billedInputTokens);
  const cachedInputRaw = safeTokenCount(event.cachedInputTokens);
  const outputRaw = safeTokenCount(event.outputTokens);
  const billedOutputRaw = safeTokenCount(event.billedOutputTokens);
  const totalRaw = safeTokenCount(event.totalTokens);
  const reasoningRaw = safeTokenCount(event.reasoningTokens);

  const isMetered =
    totalRaw !== undefined ||
    inputRaw !== undefined ||
    outputRaw !== undefined ||
    billedInputRaw !== undefined ||
    billedOutputRaw !== undefined;
  if (event.meteringVersion !== 1 && !isMetered) return;

  const providerId = canonicalProviderId(safeText(event.provider, "unknown"));
  const slug = safeText(event.model, "unknown");
  const status = Number.isInteger(event.status) ? event.status : 0;
  const isSuccess = status >= 200 && status < 400;
  const selectedOutputTokens = outputRaw ?? 0;
  const inputTokens = (billedInputRaw ?? inputRaw) ?? 0;
  const outputTokens = (billedOutputRaw ?? outputRaw) ?? 0;
  const totalTokens =
    billedInputRaw !== undefined || billedOutputRaw !== undefined
      ? inputTokens + outputTokens
      : totalRaw ??
        (inputRaw !== undefined || outputRaw !== undefined ? inputTokens + outputTokens : 0);
  const hasCache = cachedInputRaw !== undefined;
  const measuredCached = hasCache ? Math.min(cachedInputRaw, inputTokens) : 0;
  const regularInput = Math.max(0, inputTokens - measuredCached);
  const day = utcDateKey(at);
  const isoAt = new Date(at).toISOString();

  const durationMs = Number.isFinite(event.durationMs)
    ? Math.max(0, Math.round(event.durationMs))
    : 0;
  const firstTokenMs = safeTokenCount(event.firstTokenMs);
  const generationDurationMs = durationMs - (firstTokenMs ?? durationMs);
  const reasoningTokens = reasoningRaw ?? 0;
  const inclusiveOutputTokens =
    reasoningTokens > selectedOutputTokens
      ? selectedOutputTokens + reasoningTokens
      : selectedOutputTokens;
  const speedOutputTokens =
    event.reasoningStreamed === false
      ? Math.max(0, inclusiveOutputTokens - reasoningTokens)
      : inclusiveOutputTokens;
  const retries = safeRetryCount(event.retries);
  const measurable =
    isSuccess &&
    !retries &&
    event.emptyCompletion !== true &&
    event.emptyCompletionRetried !== true &&
    event.progressOnlyRetried !== true;
  const impossibleRate =
    (speedOutputTokens * 1_000) / generationDurationMs > MAX_PLAUSIBLE_TOKENS_PER_SECOND;
  const speedSample =
    measurable &&
    speedOutputTokens > 0 &&
    firstTokenMs !== undefined &&
    generationDurationMs > 0 &&
    !impossibleRate
      ? { outputTokens: speedOutputTokens, generationDurationMs }
      : null;
  const firstTokenSample =
    measurable && firstTokenMs !== undefined && firstTokenMs > 0 && firstTokenMs <= durationMs
      ? firstTokenMs
      : null;

  if (hasCache) {
    retained.cacheTelemetrySeen = true;
    retained.dailyCachedInputTokens[day] =
      (retained.dailyCachedInputTokens[day] || 0) + measuredCached;
  }

  const rProv = (retained.providers[providerId] ??= emptyRollupProviderEntry());
  rProv.requests += 1;
  if (isSuccess) rProv.successfulRequests += 1;
  if (isMetered) rProv.meteredRequests += 1;
  rProv.inputTokens += inputTokens;
  rProv.regularInputTokens += regularInput;
  rProv.cachedInputTokens += measuredCached;
  rProv.outputTokens += outputTokens;
  rProv.totalTokens += totalTokens;

  const rDay = (rProv.daily[day] ??= {
    startDate: day,
    tokens: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  rDay.tokens += totalTokens;
  rDay.requests += 1;
  rDay.inputTokens += inputTokens;
  rDay.cachedInputTokens += measuredCached;
  rDay.outputTokens += outputTokens;

  const rModel = (rProv.models[slug] ??= emptyRollupModelEntry(slug, isoAt));
  rModel.requests += 1;
  if (isSuccess) rModel.successfulRequests += 1;
  if (isMetered) rModel.meteredRequests += 1;
  rModel.inputTokens += inputTokens;
  rModel.outputTokens += outputTokens;
  rModel.totalTokens += totalTokens;
  if (speedSample) {
    rModel.speedSamples.push(speedSample);
    if (rModel.speedSamples.length > 20) rModel.speedSamples.shift();
  }
  if (firstTokenSample !== null) {
    rModel.firstTokenSamples.push(firstTokenSample);
    if (rModel.firstTokenSamples.length > 20) rModel.firstTokenSamples.shift();
  }
  if (at >= Date.parse(rModel.lastUsedAt)) rModel.lastUsedAt = isoAt;

  const dayBucket = (providerUsage.dailyBuckets[day] ??= {
    minAt: at,
    maxAt: at,
    cacheTelemetrySeen: false,
    cachedInputTokens: 0,
    providers: {},
  });
  if (at < dayBucket.minAt) dayBucket.minAt = at;
  if (at > dayBucket.maxAt) dayBucket.maxAt = at;
  if (hasCache) {
    dayBucket.cacheTelemetrySeen = true;
    dayBucket.cachedInputTokens += measuredCached;
  }

  const dProv = (dayBucket.providers[providerId] ??= emptyRollupDayProviderEntry());
  dProv.requests += 1;
  if (isSuccess) dProv.successfulRequests += 1;
  if (isMetered) dProv.meteredRequests += 1;
  dProv.inputTokens += inputTokens;
  dProv.regularInputTokens += regularInput;
  dProv.cachedInputTokens += measuredCached;
  dProv.outputTokens += outputTokens;
  dProv.totalTokens += totalTokens;

  const dModel = (dProv.models[slug] ??= emptyRollupModelEntry(slug, isoAt));
  dModel.requests += 1;
  if (isSuccess) dModel.successfulRequests += 1;
  if (isMetered) dModel.meteredRequests += 1;
  dModel.inputTokens += inputTokens;
  dModel.outputTokens += outputTokens;
  dModel.totalTokens += totalTokens;
  if (speedSample) {
    dModel.speedSamples.push(speedSample);
    if (dModel.speedSamples.length > 20) dModel.speedSamples.shift();
  }
  if (firstTokenSample !== null) {
    dModel.firstTokenSamples.push(firstTokenSample);
    if (dModel.firstTokenSamples.length > 20) dModel.firstTokenSamples.shift();
  }
  if (at >= Date.parse(dModel.lastUsedAt)) dModel.lastUsedAt = isoAt;

  providerUsage.recentEvents.push([
    at,
    day,
    providerId,
    slug,
    isSuccess ? 1 : 0,
    isMetered ? 1 : 0,
    inputTokens,
    regularInput,
    measuredCached,
    hasCache ? 1 : 0,
    outputTokens,
    totalTokens,
    speedSample,
    firstTokenSample,
  ]);
  if (providerUsage.recentEvents.length > PROVIDER_RECENT_EVENTS_MAX * 2) {
    pruneProviderUsageRollup(providerUsage);
  }
}

function pruneProviderUsageRollup(providerUsage) {
  if (!providerUsage) return;
  const maxAt = providerUsage.retained?.toMs;
  if (maxAt !== null && Number.isFinite(maxAt)) {
    const minDay = utcDateKey(maxAt - PROVIDER_DAILY_RETENTION_DAYS * DAY_MS);
    for (const day of Object.keys(providerUsage.dailyBuckets || {})) {
      if (day < minDay) {
        delete providerUsage.dailyBuckets[day];
      }
    }
    const minRecentAt = maxAt - PROVIDER_RECENT_EVENTS_RETENTION_MS;
    if (Array.isArray(providerUsage.recentEvents)) {
      providerUsage.recentEvents = providerUsage.recentEvents.filter(
        (entry) => Array.isArray(entry) && entry[0] >= minRecentAt,
      );
    }
  }
  if (
    Array.isArray(providerUsage.recentEvents) &&
    providerUsage.recentEvents.length > PROVIDER_RECENT_EVENTS_MAX
  ) {
    providerUsage.recentEvents = providerUsage.recentEvents.slice(-PROVIDER_RECENT_EVENTS_MAX);
  }
}

function foldLineIntoRollupTargets(ceilings, aging, providerUsage, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || typeof event !== "object") return;
  foldEventIntoCeilings(ceilings, event);
  foldEventIntoAging(aging, event);
  foldEventIntoProviderUsage(providerUsage, event);
}

function normalizeLoadedRollup(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
  const base = emptyRollupState();
  return {
    schemaVersion: 1,
    byteOffset: Number.isInteger(raw.byteOffset) && raw.byteOffset >= 0 ? raw.byteOffset : 0,
    firstLineHash: typeof raw.firstLineHash === "string" ? raw.firstLineHash : null,
    observedCeilings:
      raw.observedCeilings && typeof raw.observedCeilings === "object"
        ? { ...raw.observedCeilings }
        : {},
    archivedCeilings:
      raw.archivedCeilings && typeof raw.archivedCeilings === "object"
        ? { ...raw.archivedCeilings }
        : {},
    agingCumulative:
      raw.agingCumulative && typeof raw.agingCumulative === "object"
        ? {
            ...base.agingCumulative,
            ...raw.agingCumulative,
            hourlyBuckets: { ...(raw.agingCumulative.hourlyBuckets || {}) },
          }
        : emptyAgingCumulative(),
    archivedAgingCumulative:
      raw.archivedAgingCumulative && typeof raw.archivedAgingCumulative === "object"
        ? {
            ...base.archivedAgingCumulative,
            ...raw.archivedAgingCumulative,
            hourlyBuckets: { ...(raw.archivedAgingCumulative.hourlyBuckets || {}) },
          }
        : emptyAgingCumulative(),
    providerUsage:
      raw.providerUsage && typeof raw.providerUsage === "object"
        ? {
            retained: {
              ...emptyProviderRetainedState(),
              ...(raw.providerUsage.retained || {}),
              dailyCachedInputTokens: {
                ...(raw.providerUsage.retained?.dailyCachedInputTokens || {}),
              },
              providers: { ...(raw.providerUsage.retained?.providers || {}) },
            },
            dailyBuckets: { ...(raw.providerUsage.dailyBuckets || {}) },
            recentEvents: Array.isArray(raw.providerUsage.recentEvents)
              ? raw.providerUsage.recentEvents
              : [],
          }
        : emptyProviderUsageRollup(),
    archivedProviderUsage:
      raw.archivedProviderUsage && typeof raw.archivedProviderUsage === "object"
        ? {
            retained: {
              ...emptyProviderRetainedState(),
              ...(raw.archivedProviderUsage.retained || {}),
              dailyCachedInputTokens: {
                ...(raw.archivedProviderUsage.retained?.dailyCachedInputTokens || {}),
              },
              providers: { ...(raw.archivedProviderUsage.retained?.providers || {}) },
            },
            dailyBuckets: { ...(raw.archivedProviderUsage.dailyBuckets || {}) },
            recentEvents: Array.isArray(raw.archivedProviderUsage.recentEvents)
              ? raw.archivedProviderUsage.recentEvents
              : [],
          }
        : emptyProviderUsageRollup(),
  };
}

function loadRollupFromDisk() {
  if (!existsSync(USAGE_EVENTS_ROLLUP_PATH)) return null;
  try {
    const stats = statSync(USAGE_EVENTS_ROLLUP_PATH);
    const key = `${stats.size}:${stats.mtimeMs}`;
    if (cachedRollup.key === key && cachedRollup.data) {
      return cachedRollup.data;
    }
    const parsed = JSON.parse(readFileSync(USAGE_EVENTS_ROLLUP_PATH, "utf8"));
    const normalized = normalizeLoadedRollup(parsed);
    if (normalized) {
      cachedRollup = { key, data: normalized };
    }
    return normalized;
  } catch {
    return null;
  }
}

function saveRollupToDisk(rollup) {
  try {
    if (ensuredStateDir !== STATE_DIR) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      ensuredStateDir = STATE_DIR;
    }
    const tmpPath = `${USAGE_EVENTS_ROLLUP_PATH}.tmp.${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(rollup)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, USAGE_EVENTS_ROLLUP_PATH);
    const stats = statSync(USAGE_EVENTS_ROLLUP_PATH);
    cachedRollup = { key: `${stats.size}:${stats.mtimeMs}`, data: rollup };
  } catch {
    // Rollup persistence failure must never interrupt callers.
  }
}

export function syncUsageEventsRollup() {
  const loaded = loadRollupFromDisk();
  if (!existsSync(USAGE_EVENTS_PATH)) {
    if (loaded && existsSync(`${USAGE_EVENTS_PATH}.1`)) {
      return loaded;
    }
    return emptyRollupState();
  }

  let currentSize = 0;
  try {
    currentSize = statSync(USAGE_EVENTS_PATH).size;
  } catch {
    return loaded ?? emptyRollupState();
  }
  const currentFirstLineHash = readFirstLineHash(USAGE_EVENTS_PATH);

  if (
    loaded &&
    loaded.firstLineHash === currentFirstLineHash &&
    currentSize >= loaded.byteOffset
  ) {
    if (currentSize === loaded.byteOffset) {
      return loaded;
    }
    forEachUsageEventLine(
      (line) =>
        foldLineIntoRollupTargets(
          loaded.observedCeilings,
          loaded.agingCumulative,
          loaded.providerUsage,
          line,
        ),
      { startOffset: loaded.byteOffset, endOffset: currentSize },
    );
    pruneAgingBuckets(loaded.agingCumulative);
    pruneProviderUsageRollup(loaded.providerUsage);
    loaded.byteOffset = currentSize;
    saveRollupToDisk(loaded);
    return loaded;
  }

  // File was rotated, truncated, or rollup has not been created yet.
  const hasArchivedData =
    loaded &&
    (existsSync(`${USAGE_EVENTS_PATH}.1`) ||
      Object.keys(loaded.archivedCeilings || {}).length > 0 ||
      (loaded.archivedAgingCumulative?.requests ?? 0) > 0 ||
      (loaded.archivedAgingCumulative?.evaluatedRequests ?? 0) > 0 ||
      Object.keys(loaded.archivedProviderUsage?.retained?.providers || {}).length > 0);

  const archivedCeilings = hasArchivedData ? structuredClone(loaded.archivedCeilings) : {};
  const archivedAgingCumulative = hasArchivedData
    ? structuredClone(loaded.archivedAgingCumulative)
    : emptyAgingCumulative();
  const archivedProviderUsage = hasArchivedData
    ? structuredClone(loaded.archivedProviderUsage)
    : emptyProviderUsageRollup();

  const rebuilt = {
    schemaVersion: 1,
    byteOffset: 0,
    firstLineHash: currentFirstLineHash,
    observedCeilings: structuredClone(archivedCeilings),
    archivedCeilings,
    agingCumulative: structuredClone(archivedAgingCumulative),
    archivedAgingCumulative,
    providerUsage: structuredClone(archivedProviderUsage),
    archivedProviderUsage,
  };

  forEachUsageEventLine(
    (line) =>
      foldLineIntoRollupTargets(
        rebuilt.observedCeilings,
        rebuilt.agingCumulative,
        rebuilt.providerUsage,
        line,
      ),
    { startOffset: 0, endOffset: currentSize },
  );
  pruneAgingBuckets(rebuilt.agingCumulative);
  pruneProviderUsageRollup(rebuilt.providerUsage);
  rebuilt.byteOffset = currentSize;
  saveRollupToDisk(rebuilt);
  return rebuilt;
}

function findNewlineAlignedOffset(filePath, rawOffset, fileSize) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const step = 65_536;
    const buf = Buffer.allocUnsafe(Math.min(step, Math.max(1, fileSize)));
    let pos = Math.max(0, Math.min(rawOffset, fileSize));
    while (pos < fileSize) {
      const toRead = Math.min(buf.length, fileSize - pos);
      const bytesRead = readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) {
        const candidate = pos + nl + 1;
        if (candidate < fileSize) return candidate;
        break;
      }
      pos += bytesRead;
    }
    // If no newline before EOF after rawOffset, search backwards from rawOffset
    pos = Math.max(0, Math.min(rawOffset, fileSize));
    while (pos > 0) {
      const start = Math.max(0, pos - buf.length);
      const toRead = pos - start;
      const bytesRead = readSync(fd, buf, 0, toRead, start);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.lastIndexOf(0x0a);
      if (nl !== -1) {
        const candidate = start + nl + 1;
        if (candidate > 0 && candidate < fileSize) return candidate;
      }
      pos = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function copyFileRangeAtomic(srcPath, startOffset, endOffset, destPath) {
  const tmpPath = `${destPath}.tmp.${process.pid}`;
  let inFd;
  let outFd;
  try {
    inFd = openSync(srcPath, "r");
    outFd = openSync(tmpPath, "w", 0o600);
    const total = Math.max(0, endOffset - startOffset);
    const buf = Buffer.allocUnsafe(Math.min(USAGE_EVENTS_CHUNK_BYTES, Math.max(1, total)));
    let pos = startOffset;
    while (pos < endOffset) {
      const toRead = Math.min(buf.length, endOffset - pos);
      const bytesRead = readSync(inFd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      writeSync(outFd, buf, 0, bytesRead);
      pos += bytesRead;
    }
  } finally {
    if (inFd !== undefined) {
      try {
        closeSync(inFd);
      } catch {
        // Ignore close errors.
      }
    }
    if (outFd !== undefined) {
      try {
        closeSync(outFd);
      } catch {
        // Ignore close errors.
      }
    }
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, destPath);
}

export function rotateUsageEventsIfNeeded(maxBytes = resolveMaxUsageEventsBytes()) {
  if (!existsSync(USAGE_EVENTS_PATH)) return { rotated: false };
  const currentSize = statSync(USAGE_EVENTS_PATH).size;
  if (currentSize <= maxBytes) return { rotated: false, size: currentSize };
  rotateUsageEventsFile(currentSize, maxBytes);
  return { rotated: true, size: statSync(USAGE_EVENTS_PATH).size };
}

function rotateUsageEventsFile(currentSize, maxBytes) {
  const keepTargetBytes = Math.max(1, Math.floor(maxBytes / 2));
  const rawSplit = Math.max(0, currentSize - keepTargetBytes);
  const splitOffset = findNewlineAlignedOffset(USAGE_EVENTS_PATH, rawSplit, currentSize);
  if (splitOffset <= 0 || splitOffset >= currentSize) return;

  const loaded = loadRollupFromDisk() ?? emptyRollupState();
  const archivedCeilings = structuredClone(loaded.archivedCeilings || {});
  const archivedAgingCumulative = structuredClone(
    loaded.archivedAgingCumulative || emptyAgingCumulative(),
  );
  const archivedProviderUsage = structuredClone(
    loaded.archivedProviderUsage || emptyProviderUsageRollup(),
  );

  // Fold the evicted older prefix [0, splitOffset) into the archived rollup state
  forEachUsageEventLine(
    (line) =>
      foldLineIntoRollupTargets(
        archivedCeilings,
        archivedAgingCumulative,
        archivedProviderUsage,
        line,
      ),
    { startOffset: 0, endOffset: splitOffset },
  );
  pruneAgingBuckets(archivedAgingCumulative);
  pruneProviderUsageRollup(archivedProviderUsage);

  // Write the older portion to USAGE_EVENTS_PATH.1 (bounded to maxBytes if huge)
  let archiveStart = 0;
  if (splitOffset > maxBytes) {
    archiveStart = findNewlineAlignedOffset(
      USAGE_EVENTS_PATH,
      splitOffset - maxBytes,
      splitOffset,
    );
  }
  const backupPath = `${USAGE_EVENTS_PATH}.1`;
  copyFileRangeAtomic(USAGE_EVENTS_PATH, archiveStart, splitOffset, backupPath);

  // Keep the trailing Math.floor(maxBytes / 2) newline-aligned bytes in USAGE_EVENTS_PATH
  copyFileRangeAtomic(USAGE_EVENTS_PATH, splitOffset, currentSize, USAGE_EVENTS_PATH);

  const newStats = statSync(USAGE_EVENTS_PATH);
  ensuredFileKey = `${newStats.dev}:${newStats.ino}`;
  const newSize = newStats.size;
  const newFirstLineHash = readFirstLineHash(USAGE_EVENTS_PATH);

  const updatedRollup = {
    schemaVersion: 1,
    byteOffset: newSize,
    firstLineHash: newFirstLineHash,
    observedCeilings: structuredClone(archivedCeilings),
    archivedCeilings,
    agingCumulative: structuredClone(archivedAgingCumulative),
    archivedAgingCumulative,
    providerUsage: structuredClone(archivedProviderUsage),
    archivedProviderUsage,
  };

  forEachUsageEventLine(
    (line) =>
      foldLineIntoRollupTargets(
        updatedRollup.observedCeilings,
        updatedRollup.agingCumulative,
        updatedRollup.providerUsage,
        line,
      ),
    { startOffset: 0, endOffset: newSize },
  );
  pruneAgingBuckets(updatedRollup.agingCumulative);
  pruneProviderUsageRollup(updatedRollup.providerUsage);
  saveRollupToDisk(updatedRollup);
}

function emptyRange(buckets) {
  return {
    savedTokens: 0,
    requests: 0,
    buckets: new Array(buckets).fill(0),
    // Measured prompt-cache rates in this window, split by whether the
    // request carried compacted results. Only providers that report
    // cachedInputTokens contribute (native GPT does; most routed do not), so
    // either rate can be null when nothing measurable happened.
    cache: { agedRate: null, unagedRate: null, agedTurns: 0, unagedTurns: 0 },
  };
}

export function toolResultAgingTotals({ now = Date.now() } = {}) {
  const totals = {
    requests: 0,
    // Requests where the pass ran, whether or not it changed anything, plus the
    // largest single result any of them saw. `evaluatedRequests` above zero
    // with `requests` at zero is the signature of a workload whose results all
    // sit under the eligibility floor: proof the pass is wired in, and the
    // number that says by how much it missed.
    evaluatedRequests: 0,
    largestResultBytes: 0,
    resultsAged: 0,
    resultsShaped: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
    firstAt: undefined,
    lastAt: undefined,
    ranges: Object.fromEntries(
      AGING_RANGES.map((range) => [range.key, emptyRange(range.buckets)]),
    ),
  };
  if (!existsSync(USAGE_EVENTS_PATH) && !existsSync(`${USAGE_EVENTS_PATH}.1`)) return totals;
  const floors = AGING_RANGES.map((range) => now - (now % range.bucketMs));
  const cacheSums = AGING_RANGES.map(() => ({ aged: [0, 0], unaged: [0, 0] }));
  try {
    const rollup = syncUsageEventsRollup();
    const aging = rollup.agingCumulative;
    totals.requests = aging.requests || 0;
    totals.evaluatedRequests = aging.evaluatedRequests || 0;
    totals.largestResultBytes = aging.largestResultBytes || 0;
    totals.resultsAged = aging.resultsAged || 0;
    totals.resultsShaped = aging.resultsShaped || 0;
    totals.bytesSaved = aging.bytesSaved || 0;
    totals.firstAt = aging.firstAt ?? undefined;
    totals.lastAt = aging.lastAt ?? undefined;

    for (const [hourKey, bucketData] of Object.entries(aging.hourlyBuckets || {})) {
      const hourEpoch = Number(hourKey);
      if (!Number.isFinite(hourEpoch) || !bucketData) continue;
      AGING_RANGES.forEach((range, index) => {
        const bucket =
          range.buckets -
          1 -
          Math.floor((floors[index] - (hourEpoch - (hourEpoch % range.bucketMs))) / range.bucketMs);
        if (bucket >= 0 && bucket < range.buckets) {
          const slot = totals.ranges[range.key];
          slot.buckets[bucket] += bucketData.savedTokens || 0;
          slot.savedTokens += bucketData.savedTokens || 0;
          slot.requests += bucketData.requests || 0;
        }
        if (hourEpoch + HOUR_MS > now - range.bucketMs * range.buckets && hourEpoch <= now) {
          cacheSums[index].aged[0] += bucketData.agedInput || 0;
          cacheSums[index].aged[1] += bucketData.agedCached || 0;
          totals.ranges[range.key].cache.agedTurns += bucketData.agedTurns || 0;
          cacheSums[index].unaged[0] += bucketData.unagedInput || 0;
          cacheSums[index].unaged[1] += bucketData.unagedCached || 0;
          totals.ranges[range.key].cache.unagedTurns += bucketData.unagedTurns || 0;
        }
      });
    }
  } catch {
    // Telemetry must never break a status surface; report what was readable.
  }
  totals.estimatedTokensSaved = Math.round(totals.bytesSaved / BYTES_PER_TOKEN_ESTIMATE);
  const rate = ([input, cached]) =>
    input ? Math.round((cached / input) * 1_000) / 1_000 : null;
  AGING_RANGES.forEach((range, index) => {
    totals.ranges[range.key].cache.agedRate = rate(cacheSums[index].aged);
    totals.ranges[range.key].cache.unagedRate = rate(cacheSums[index].unaged);
  });
  return totals;
}

function sanitizeUsageEvent(event) {
  const inputTokens = safeTokenCount(event.inputTokens);
  const billedInputTokens = safeTokenCount(event.billedInputTokens);
  const cachedInputTokens = safeTokenCount(event.cachedInputTokens);
  const outputTokens = safeTokenCount(event.outputTokens);
  const billedOutputTokens = safeTokenCount(event.billedOutputTokens);
  const reasoningTokens = safeTokenCount(event.reasoningTokens);
  const totalTokens = safeTokenCount(event.totalTokens);
  const retries = safeRetryCount(event.retries);
  const estimatedInputTokens = safeTokenCount(event.estimatedInputTokens);
  const toolResultsAged = safeTokenCount(event.toolResultsAged);
  const toolResultsShaped = safeTokenCount(event.toolResultsShaped);
  const toolResultBytesBefore = safeTokenCount(event.toolResultBytesBefore);
  const toolResultBytesAfter = safeTokenCount(event.toolResultBytesAfter);
  const toolResultBytesSaved = safeTokenCount(event.toolResultBytesSaved);
  const toolResultShapeBytesSaved = safeTokenCount(event.toolResultShapeBytesSaved);
  const searchResults = safeTokenCount(event.searchResults);
  const diagnostics = usageDiagnosticMetadata({
    requestId: event.requestId,
    contextBytes: event.contextBytes,
    grokStructuredPatch: event.grokStructuredPatch,
  });
  return {
    ...serviceTierMetadata(event),
    ...(event.meteringVersion === 1 ? { meteringVersion: 1 } : {}),
    at: event.at,
    model: safeText(event.model, "unknown"),
    // Historical events may carry a protocol-variant provider id; fold
    // the whole family into its canonical provider so usage stays one
    // series per subscription.
    provider: canonicalProviderId(safeText(event.provider, "unknown")),
    status: Number.isInteger(event.status) ? event.status : 0,
    durationMs: Number.isFinite(event.durationMs)
      ? Math.max(0, Math.round(event.durationMs))
      : 0,
    ...(safeTokenCount(event.responseStartMs) !== undefined
      ? { responseStartMs: safeTokenCount(event.responseStartMs) }
      : {}),
    ...(safeTokenCount(event.firstTokenMs) !== undefined
      ? { firstTokenMs: safeTokenCount(event.firstTokenMs) }
      : {}),
    ...(typeof event.reasoningStreamed === "boolean"
      ? { reasoningStreamed: event.reasoningStreamed }
      : {}),
    ...(event.streamAborted === true ? { streamAborted: true } : {}),
    ...(event.emptyCompletion === true ? { emptyCompletion: true } : {}),
    ...(event.emptyCompletionUnrepairable === true
      ? { emptyCompletionUnrepairable: true }
      : {}),
    ...(event.emptyCompletionRetried === true
      ? { emptyCompletionRetried: true }
      : {}),
    ...(event.progressOnlyRetried === true ? { progressOnlyRetried: true } : {}),
    ...(event.emptyCompletionGuardReleased === true
      ? { emptyCompletionGuardReleased: true }
      : {}),
    ...(event.emptyCompletionPreludeLimit === "bytes" ||
    event.emptyCompletionPreludeLimit === "time"
      ? { emptyCompletionPreludeLimit: event.emptyCompletionPreludeLimit }
      : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(event.searchSidecar === true ? { searchSidecar: true } : {}),
    ...(event.searchSidecar === true && typeof event.searchCacheHit === "boolean"
      ? { searchCacheHit: event.searchCacheHit }
      : {}),
    ...(event.searchSidecar === true && searchResults !== undefined
      ? { searchResults }
      : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(billedInputTokens !== undefined ? { billedInputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(billedOutputTokens !== undefined ? { billedOutputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
    ...(toolResultsAged ? { toolResultsAged } : {}),
    ...(toolResultsShaped ? { toolResultsShaped } : {}),
    ...(toolResultBytesBefore ? { toolResultBytesBefore } : {}),
    ...(toolResultBytesAfter ? { toolResultBytesAfter } : {}),
    ...(toolResultBytesSaved ? { toolResultBytesSaved } : {}),
    ...(toolResultShapeBytesSaved ? { toolResultShapeBytesSaved } : {}),
    ...diagnostics,
  };
}

// The cap a caller gets when it does not choose one. Exported so a consumer
// that reads the window once and derives several views from it can apply the
// same bound without restating the number.
export const RECENT_USAGE_EVENT_LIMIT = 1_000;

export function recentUsageEvents({
  sinceMs = 24 * 60 * 60 * 1000,
  limit = RECENT_USAGE_EVENT_LIMIT,
} = {}) {
  if (!existsSync(USAGE_EVENTS_PATH)) return [];
  const cutoff = Date.now() - sinceMs;
  let cutoffIso = "";
  if (Number.isFinite(sinceMs)) {
    try {
      cutoffIso = new Date(cutoff).toISOString();
    } catch {
      // An out-of-range window has no text form; the parse-time check covers it.
      cutoffIso = "";
    }
  }
  try {
    if (Number.isFinite(sinceMs) || Number.isFinite(limit)) {
      const maxMatchingLines = Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : Number.POSITIVE_INFINITY;
      const events = [];
      readRecentUsageEventLines({
        cutoffIso,
        maxMatchingLines,
        onLine: (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return false;
          }
          if (
            !event ||
            typeof event.at !== "string" ||
            !(Date.parse(event.at) >= cutoff) ||
            typeof event.model !== "string" ||
            typeof event.provider !== "string"
          ) {
            return false;
          }
          events.push(sanitizeUsageEvent(event));
          return true;
        },
      });
      return events.reverse();
    }

    const events = [];
    forEachUsageEventLine((line) => {
      if (cutoffIso && lineOlderThan(line, cutoffIso)) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !event ||
        typeof event.at !== "string" ||
        !(Date.parse(event.at) >= cutoff) ||
        typeof event.model !== "string" ||
        typeof event.provider !== "string"
      ) {
        return;
      }
      events.push(sanitizeUsageEvent(event));
    });
    return events;
  } catch {
    return [];
  }
}

// The Control Center's hourly traffic chart was built entirely from
// recentUsageEvents(), whose default cap is 1,000 rows. An ordinary busy day is
// many times that -- 9,000 events in 24 hours is routine -- so the most recent
// 1,000 covered under two hours: twenty-two of the twenty-four bars were drawn
// empty, and the caption reported that truncated sum as the day's total while
// the summary tile beside it added up every provider row. Aggregate the whole
// window here and ship 24 small buckets instead. The chart gets an honest shape
// and a total that agrees with the tile, and the payload stays bounded however
// busy the router was.
export const HOURLY_USAGE_ROLLUP_HOURS = 24;

// Both helpers mirror the renderer's tokenCountFromEvent/trafficPartsFromEvent
// exactly, including the billed-over-raw preference and the cached-share clamp.
// recentUsageEvents() omits an absent count rather than writing a zero, so an
// unreported field stays distinguishable from a measured zero.
function rollupTokenCount(event) {
  if (event.totalTokens !== undefined) return event.totalTokens;
  const input = event.billedInputTokens ?? event.inputTokens;
  const output = event.billedOutputTokens ?? event.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

function rollupTokenParts(event) {
  const input = event.billedInputTokens ?? event.inputTokens;
  const cached = event.cachedInputTokens;
  const output = event.billedOutputTokens ?? event.outputTokens;
  if (input === undefined && cached === undefined && output === undefined) return undefined;
  const inputTokens = input ?? 0;
  const cachedInputTokens = input === undefined
    ? cached ?? 0
    : Math.min(inputTokens, cached ?? 0);
  return {
    regularInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output ?? 0,
  };
}

export function hourlyUsageRollup({
  hours = HOURLY_USAGE_ROLLUP_HOURS,
  now = Date.now(),
  readEvents = recentUsageEvents,
} = {}) {
  const span = Math.max(1, Math.min(24 * 31, Math.floor(hours) || 0));
  // Keep clock-hour labels, but cover the exact rolling window. When `now`
  // sits between hour boundaries, the window touches both an oldest partial
  // hour and the current partial hour, so it can span `hours + 1` clock buckets.
  const windowStart = now - span * HOUR_MS;
  const firstAnchor = new Date(windowStart);
  firstAnchor.setMinutes(0, 0, 0);
  const lastAnchor = new Date(now);
  lastAnchor.setMinutes(0, 0, 0);
  const first = firstAnchor.getTime();
  const lastHour = lastAnchor.getTime();
  const lastBucket = now === lastHour ? lastHour - HOUR_MS : lastHour;
  const bucketCount = Math.floor((lastBucket - first) / HOUR_MS) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startedAt: new Date(first + index * HOUR_MS).toISOString(),
    tokens: 0,
    requests: 0,
    measuredTokens: false,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    measuredBreakdown: false,
  }));
  // Reading the whole window is the point: the cap this replaces is the defect.
  const events = readEvents({
    sinceMs: Math.max(HOUR_MS, now - first),
    limit: Number.POSITIVE_INFINITY,
  });
  for (const event of events) {
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at < windowStart || at >= now) continue;
    const index = Math.floor((at - first) / HOUR_MS);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    const tokens = rollupTokenCount(event);
    if (tokens !== undefined) {
      bucket.tokens += tokens;
      bucket.measuredTokens = true;
    }
    const parts = rollupTokenParts(event);
    if (parts) {
      bucket.regularInputTokens += parts.regularInputTokens;
      bucket.cachedInputTokens += parts.cachedInputTokens;
      bucket.outputTokens += parts.outputTokens;
      bucket.measuredBreakdown = true;
    }
  }
  return buckets;
}

// The append-only ledger is the source of truth for "everything this router
// has observed". Keep this separate from recentUsageEvents' bounded default so
// callers have to opt into the potentially larger read explicitly.
export function allUsageEvents({ limit = Number.POSITIVE_INFINITY } = {}) {
  return recentUsageEvents({ sinceMs: Number.POSITIVE_INFINITY, limit });
}

// Highest prompt each model has been observed to have accepted, scanned across
// the whole ledger rather than a recent window: the turn that disproves a
// declared context window may be months old and must not age out of the
// evidence. Incrementally checkpointed in usage-events-rollup.json so
// checking drift reads only newly appended bytes and preserves ceilings across
// ledger rotation.
export function observedInputCeilings() {
  const highest = new Map();
  if (!existsSync(USAGE_EVENTS_PATH) && !existsSync(`${USAGE_EVENTS_PATH}.1`)) return highest;
  try {
    const rollup = syncUsageEventsRollup();
    for (const [slug, ceiling] of Object.entries(rollup.observedCeilings || {})) {
      if (Number.isInteger(ceiling) && ceiling > 0) {
        highest.set(slug, ceiling);
      }
    }
  } catch {
    // Telemetry must never break a status surface; report what was readable.
  }
  return highest;
}
