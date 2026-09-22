import assert from "node:assert/strict";
import test from "node:test";

import {
  PrismDecisionError,
  PrismDecisionsClient,
  validateDecisionRequest,
  validateDecisionResponse,
} from "../src/engineering/prism-decisions.mjs";

function request() {
  return validateDecisionRequest({
    request_id: "decision-1",
    state: { objective: "Repair the parser", risk: "medium" },
    questions: {
      parallel: { type: "noul", question: "Can independent work proceed?" },
      family: { type: "choice", question: "Which family?", options: ["debug", "implementation"] },
      risk: { type: "score", question: "How risky?", criteria: ["low", "medium", "high"], min_score: 0, max_score: 2 },
    },
  });
}

function responsePayload() {
  return {
    request_id: "decision-1", provider: "typesafe", model: "jev-1.13",
    answers: {
      parallel: { type: "noul", probability: 0.8 },
      family: {
        type: "choice", selected: "debug", confidence: 0.7,
        probabilities: { debug: 0.7, implementation: 0.3 },
      },
      risk: { type: "score", score: 1, confidence: 0.9, probabilities: { low: 0.1, medium: 0.8, high: 0.1 } },
    },
    usage: { input_tokens: 12, output_tokens: 3 }, latency_ms: 90,
    serving_gateway: "vercel",
    attempts: [
      { gateway: "typesafe", model: "jev-latest", ordinal: 1, kind: "capacity", code: "rate_limited", http_status: 429, dispatch_state: "dispatched", outcome: "FAILED", latency_ms: 30, retry_after_ms: 1000 },
      { gateway: "vercel", model: "typesafe-ai/jev", ordinal: 2, kind: "success", code: "ok", http_status: 200, dispatch_state: "dispatched", outcome: "SUCCEEDED", latency_ms: 60 },
    ],
  };
}

test("typed Noul, Choice, and Score answers retain calibrated values and provenance", () => {
  const result = validateDecisionResponse(responsePayload(), request());
  assert.equal(result.answers.parallel.probability, 0.8);
  assert.equal(result.answers.family.selected, "debug");
  assert.equal(result.answers.risk.score, 1);
  assert.equal(result.provenance.servingGateway, "vercel");
  assert.equal(result.provenance.attempts.length, 2);
});

test("malformed choice distributions, mismatched ids, and missing provenance fail closed", () => {
  const badDistribution = responsePayload();
  badDistribution.answers.family.probabilities = { debug: 0.9, implementation: 0.9 };
  assert.throws(() => validateDecisionResponse(badDistribution, request()), /sum to 1/);
  const badIds = responsePayload();
  delete badIds.answers.risk;
  assert.throws(() => validateDecisionResponse(badIds, request()), /answer ids/);
  const missingProvenance = responsePayload();
  delete missingProvenance.serving_gateway;
  assert.throws(() => validateDecisionResponse(missingProvenance, request()), /serving_gateway/);
  const reordered = responsePayload();
  reordered.attempts[1].ordinal = 3;
  assert.throws(() => validateDecisionResponse(reordered, request()), /ordinals/);
});

test("client sends only the Prism credential and validates successful response", async () => {
  let observed;
  const client = new PrismDecisionsClient({
    baseUrl: "https://prism.example.test",
    apiKey: "test-prism-key",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify(responsePayload()), { status: 200 });
    },
  });
  const result = await client.decide(request(), { attribution: { session: "run-1", agentId: "task-1" } });
  assert.equal(observed.url, "https://prism.example.test/v1/decisions");
  assert.equal(observed.init.headers.authorization, "Bearer test-prism-key");
  assert.equal(observed.init.headers["x-prism-session"], "run-1");
  assert.equal(observed.init.headers["x-prism-agent-id"], "task-1");
  assert.equal(JSON.parse(observed.init.body).model, "jev-latest");
  assert.equal(result.provenance.servingGateway, "vercel");
  await assert.rejects(
    client.decide(request(), { attribution: { session: "bad\nheader" } }),
    /invalid header characters/,
  );
});

test("deadline aborts the complete decision and typed error payload does not echo state", async () => {
  const client = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  await assert.rejects(
    client.decide(request()),
    (error) => error instanceof PrismDecisionError && error.code === "deadline_exceeded" && !error.message.includes("Repair the parser"),
  );

  const cancellation = new AbortController();
  const cancelledClient = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  const cancelled = cancelledClient.decide(request(), { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(cancelled, (error) => (
    error.code === "cancelled" && error.retryable === false && error.outcome === "CANCELLED"
  ));

  const failed = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    fetchImpl: async () => new Response(JSON.stringify({
      request_id: "decision-1",
      error: { message: "capacity unavailable", type: "decision_provider_error", code: "capacity", retryable: true, dispatch_state: "dispatched", outcome: "FAILED" },
      attempts: [{ gateway: "typesafe", model: "jev-latest", ordinal: 1, kind: "capacity", code: "rate_limited", http_status: 429, dispatch_state: "dispatched", outcome: "FAILED", latency_ms: 4 }],
    }), { status: 503, headers: { "retry-after": "2" } }),
  });
  await assert.rejects(failed.decide(request()), (error) => {
    assert.equal(error.code, "capacity");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
    assert.equal(error.retryAfterMs, 2_000);
    assert.equal(error.attempts[0].gateway, "typesafe");
    return true;
  });
});

test("decision errors reject mismatched identity, invalid ambiguity, and unordered provenance", async () => {
  const payload = {
    request_id: "different-id",
    error: {
      message: "failed", type: "decision_provider_error", code: "failed", retryable: false,
      dispatch_state: "definitely-safe", outcome: "SUCCEEDED",
    },
    attempts: [{ gateway: "typesafe", model: "jev-latest", ordinal: 2, kind: "error", code: "failed", http_status: 500, dispatch_state: "dispatched", outcome: "FAILED", latency_ms: 1 }],
  };
  const client = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 502 }),
  });
  await assert.rejects(client.decide(request()), (error) => error.code === "invalid_response");
});

test("decision errors preserve ambiguous attempts and omit absent retry-after", async () => {
  const hiddenAmbiguity = {
    request_id: "decision-1",
    error: {
      message: "failed", type: "decision_provider_error", code: "failed", retryable: true,
      dispatch_state: "dispatched", outcome: "FAILED",
    },
    attempts: [{
      gateway: "typesafe", model: "jev-latest", ordinal: 1, kind: "timeout", code: "timeout",
      http_status: 504, dispatch_state: "ambiguous", outcome: "UNKNOWN", latency_ms: 10,
    }],
  };
  const invalid = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    fetchImpl: async () => new Response(JSON.stringify(hiddenAmbiguity), { status: 504 }),
  });
  await assert.rejects(invalid.decide(request()), (error) => error.code === "invalid_response");

  const definite = structuredClone(hiddenAmbiguity);
  definite.error.dispatch_state = "pre_dispatch";
  definite.attempts[0].dispatch_state = "pre_dispatch";
  definite.attempts[0].outcome = "FAILED";
  const noRetryAfter = new PrismDecisionsClient({
    apiKey: "test-prism-key",
    fetchImpl: async () => new Response(JSON.stringify(definite), { status: 503 }),
  });
  await assert.rejects(noRetryAfter.decide(request()), (error) => {
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("decision state rejects lossy non-JSON values", () => {
  const base = request();
  assert.throws(() => validateDecisionRequest({ ...base, state: { value: undefined } }), /non-JSON/);
  assert.throws(() => validateDecisionRequest({ ...base, state: { value: Number.NaN } }), /non-finite/);
  assert.throws(() => validateDecisionRequest({ ...base, state: { value: new Map([["a", 1]]) } }), /non-plain/);
});
