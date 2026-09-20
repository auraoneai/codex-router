import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

// Declared here rather than in paths.mjs for the same reason usage-events.mjs
// keeps its own: an append-only diagnostic log this module alone owns.
export const PROVIDER_LATENCY_TRACES_PATH = path.join(
  STATE_DIR,
  "provider-latency-traces.jsonl",
);

const ROUTER_ID = /^router-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Prism owns the authoritative context estimate used for admission and
// compaction. Router may repair missing *reported usage* after a response, but
// must never repeat Prism's preflight estimate while selecting a route. Recorded
// in every trace so a reader can tell which component's estimate it is seeing.
export const CONTEXT_ESTIMATION_BOUNDARY = Object.freeze({
  authority: "prism",
  routerPerformsAuthoritativeEstimate: false,
});

// Provider and model names reach this log from request payloads and upstream
// responses. Bounding them keeps one malformed field from writing an unbounded
// line into a file that has no reader to reject it.
function boundedText(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
}

function writeTrace(record) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(PROVIDER_LATENCY_TRACES_PATH, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(PROVIDER_LATENCY_TRACES_PATH, 0o600);
  } catch {
    // Observation-only telemetry must never fail a model request.
  }
}

export function validRouterCorrelationId(value) {
  return typeof value === "string" && ROUTER_ID.test(value);
}

// One trace per logical request, with one record per upstream attempt inside it.
// The aggregate timing line the router already logs cannot answer which of
// several failover attempts was slow, or whether the delay was local parsing,
// route selection, or the provider itself. Those are the questions that decide
// whether a slow turn is the router's fault or the provider's.
export function createProviderLatencyTrace({
  requestedModel,
  routeClass = "inference",
  logicalRequestId: inheritedId,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const startedWallAt = Date.now();
  // A caller-supplied id is honoured only in the router's own format, so a
  // client-controlled header cannot decide how records correlate.
  const logicalRequestId = validRouterCorrelationId(inheritedId)
    ? inheritedId
    : `router-${randomUUID()}`;
  const attempts = [];
  let nextAttemptNumber = 0;
  let requested = boundedText(requestedModel);
  let payloadClass = "ordinary";
  let resolvedModel;
  let returnedModel;
  let status = "pending";
  let errorCode;
  let finished = false;
  let localhostParseMs;
  let routeSelectionMs;

  function phaseTimer(assign) {
    const phaseStartedAt = process.hrtime.bigint();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      assign(elapsedMs(phaseStartedAt));
    };
  }

  function beginAttempt({
    provider,
    model,
    kind = "generation",
    accountPseudonym,
  } = {}) {
    const attempt = {
      upstreamAttemptId: `attempt-${randomUUID()}`,
      attemptNumber: ++nextAttemptNumber,
      provider: boundedText(provider),
      model: boundedText(model),
      kind: boundedText(kind),
      // A pseudonym, never an account id: which account was slow is a real
      // question, and identifying it in a log file is not the way to answer it.
      ...(accountPseudonym
        ? { accountPseudonym: boundedText(accountPseudonym) }
        : {}),
      startedMs: elapsedMs(startedAt),
      status: "pending",
    };
    attempts.push(attempt);
    return attempt;
  }

  function fetchCallbacks(metadata) {
    const active = new Map();
    return {
      onAttemptStart({ attempt }) {
        active.set(attempt, beginAttempt(metadata));
      },
      onAttemptFinish({ attempt, response, error }) {
        const record = active.get(attempt);
        if (!record) return;
        if (response) record.upstreamHeadersMs = elapsedMs(startedAt);
        record.status = response ? `http_${response.status}` : "transport_error";
        // A non-2xx attempt has no stream to wait for, so it completes here. A
        // 2xx one stays open until the body finishes.
        if (!response || response.status < 200 || response.status >= 300) {
          record.streamCompleteMs = elapsedMs(startedAt);
        }
        if (error) record.errorCode = boundedText(error.cause?.code || error.name || "Error");
      },
    };
  }

  // Headers arriving is not the same as the model saying anything. The gap
  // between them is where a provider that accepted the request but is queueing
  // it becomes visible, so both marks are kept separately.
  function markSemantic(at = Date.now()) {
    const attempt = [...attempts].reverse().find((candidate) => /^http_2\d\d$/.test(candidate.status));
    if (!attempt || attempt.firstSemanticEventMs !== undefined) return;
    const wallElapsed = Math.max(0, at - startedWallAt);
    attempt.firstSemanticEventMs = Math.round(wallElapsed);
  }

  function markFirstFrame(at = Date.now()) {
    const attempt = [...attempts].reverse().find((candidate) => /^http_2\d\d$/.test(candidate.status));
    if (!attempt || attempt.firstUpstreamFrameMs !== undefined) return;
    attempt.firstUpstreamFrameMs = Math.max(0, Math.round(at - startedWallAt));
  }

  function finishAttempt(statusCode) {
    const attempt = attempts.at(-1);
    if (!attempt || attempt.streamCompleteMs !== undefined) return;
    attempt.streamCompleteMs = elapsedMs(startedAt);
    if (attempt.status === "pending") attempt.status = `http_${statusCode || 0}`;
  }

  function finish({ statusCode, error } = {}) {
    if (finished) return;
    finished = true;
    finishAttempt(statusCode);
    // A zero status is a client that disconnected, which is neither the
    // router's failure nor the provider's and must not read as an error.
    status = statusCode >= 200 && statusCode < 400 ? "success" : statusCode === 0 ? "cancelled" : "error";
    errorCode = error ? boundedText(error.cause?.code || error.code || error.name || "Error") : undefined;
    writeTrace(snapshot());
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      at: new Date().toISOString(),
      logicalRequestId,
      routeClass: boundedText(routeClass),
      requestedModel: requested,
      payloadClass,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(returnedModel ? { returnedModel } : {}),
      contextEstimationAuthority: CONTEXT_ESTIMATION_BOUNDARY.authority,
      routerAuthoritativeContextEstimate: CONTEXT_ESTIMATION_BOUNDARY.routerPerformsAuthoritativeEstimate,
      durationMs: elapsedMs(startedAt),
      ...(localhostParseMs !== undefined ? { localhostParseMs } : {}),
      ...(routeSelectionMs !== undefined ? { routeSelectionMs } : {}),
      // Everything before the first upstream byte is the router's own cost, and
      // it is the number that says whether the router is the slow part.
      ...(attempts[0] ? { routerPreUpstreamMs: attempts[0].startedMs } : {}),
      status,
      ...(errorCode ? { errorCode } : {}),
      attempts: attempts.map((attempt) => ({ ...attempt })),
    };
  }

  return {
    logicalRequestId,
    beginAttempt,
    finishAttemptRecord(attempt, { response, error } = {}) {
      if (!attempt) return;
      if (response) attempt.upstreamHeadersMs = elapsedMs(startedAt);
      attempt.status = response ? `http_${response.status}` : "transport_error";
      if (!response || response.status < 200 || response.status >= 300) {
        attempt.streamCompleteMs = elapsedMs(startedAt);
      }
      if (error) attempt.errorCode = boundedText(error.cause?.code || error.name || "Error");
    },
    fetchCallbacks,
    markSemantic,
    markFirstFrame,
    startLocalhostParse() {
      return phaseTimer((duration) => {
        if (localhostParseMs === undefined) localhostParseMs = duration;
      });
    },
    startRouteSelection() {
      return phaseTimer((duration) => {
        if (routeSelectionMs === undefined) routeSelectionMs = duration;
      });
    },
    finishAttempt,
    finish,
    snapshot,
    setResolvedModel(model) {
      resolvedModel = boundedText(model);
    },
    setRequestedModel(model) {
      requested = boundedText(model);
    },
    setPayloadClass(value) {
      payloadClass = boundedText(value, "ordinary");
    },
    setReturnedModel(model) {
      returnedModel = boundedText(model);
    },
    correlationHeaders() {
      return { "X-Codex-Router-Request-Id": logicalRequestId };
    },
  };
}
