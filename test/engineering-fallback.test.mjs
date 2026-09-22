import assert from "node:assert/strict";
import test from "node:test";

import { immutableSnapshot } from "../src/engineering/contracts.mjs";
import { EngineeringCapacityCircuits, normalizeEngineeringFailure } from "../src/engineering/capacity.mjs";
import {
  DEFAULT_DEEPSEEK_RECOVERY_CHAIN,
  DEEPSEEK_NON_MODAL_FALLBACK,
  selectEngineeringFallback,
  validateDeepSeekFallbackSnapshot,
} from "../src/engineering/fallback.mjs";

function candidate(model, provider, family, capacityHost, effectiveEffort = "high", extra = {}) {
  return { model, provider, family, capacityHost, effectiveEffort, ...extra };
}

function deepSeekSnapshot(overrides = {}) {
  const selected = candidate(
    "kiro-prism/deepseek-v4.1-flash",
    "kiro-prism",
    "deepseek",
    "modal",
    "high",
    { capacityFailurePolicy: DEEPSEEK_NON_MODAL_FALLBACK },
  );
  const fallbacks = [
    candidate("cloudflare-workers-ai/glm-5.3", "cloudflare-workers-ai", "glm", "cloudflare", "medium"),
    candidate("gpt-5.6-sol", "openai", "gpt-5.6", "openai", "max"),
    candidate("kiro-prism/claude-sonnet-5", "kiro-prism", "claude", "kiro-prism", "high"),
  ];
  return immutableSnapshot({
    schemaVersion: 1,
    policyRevision: 9,
    preset: "balanced",
    role: "debugger",
    selectionSource: "role",
    selected,
    fallbacks,
    rejectedCandidates: [],
    ...overrides,
  });
}

test("the default DeepSeek chain is full Cloudflare GLM, Sol, then Sonnet with Kimi absent", () => {
  assert.deepEqual(DEFAULT_DEEPSEEK_RECOVERY_CHAIN, [
    "cloudflare-workers-ai/glm-5.3",
    "gpt-5.6-sol",
    "kiro-prism/claude-sonnet-5",
  ]);
  assert.equal(DEFAULT_DEEPSEEK_RECOVERY_CHAIN.some((slug) => slug.includes("kimi")), false);
  const snapshot = deepSeekSnapshot();
  assert.equal(validateDeepSeekFallbackSnapshot(snapshot), true);
  assert.deepEqual(snapshot.fallbacks.map(({ model }) => model), DEFAULT_DEEPSEEK_RECOVERY_CHAIN);
});

test("DeepSeek capacity failure selects the first healthy non-Modal snapshot route and preserves its effort", () => {
  const result = selectEngineeringFallback({
    snapshot: deepSeekSnapshot(),
    current: "kiro-prism/deepseek-v4.1-flash",
    failure: { status: 429 },
    failureContext: { dispatched: true },
    taskId: "task-a",
    at: 0,
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selected.model, "cloudflare-workers-ai/glm-5.3");
  assert.equal(result.selected.effectiveEffort, "medium");
  assert.equal(Object.isFrozen(result), true);
});

test("an open full-GLM route is skipped cross-task in favor of Sol", () => {
  const circuits = new EngineeringCapacityCircuits({ failureThreshold: 1, openMs: 10_000, now: () => 0 });
  const failure = normalizeEngineeringFailure({ status: 503 }, { dispatched: true, now: 0 });
  circuits.recordFailure({
    route: "cloudflare-workers-ai/glm-5.3",
    host: "cloudflare",
    taskId: "other-task",
    failure,
    at: 0,
  });
  const result = selectEngineeringFallback({
    snapshot: deepSeekSnapshot(),
    current: "kiro-prism/deepseek-v4.1-flash",
    failure: { status: 429 },
    failureContext: { dispatched: true },
    circuits,
    taskId: "new-task",
    at: 0,
  });
  assert.equal(result.selected.model, "gpt-5.6-sol");
  assert.deepEqual(result.rejectedCandidates, [{
    model: "cloudflare-workers-ai/glm-5.3",
    reason: "circuit_open",
  }]);
});

test("no fallback occurs after output starts or while a tool action is ambiguous", () => {
  const streamed = selectEngineeringFallback({
    snapshot: deepSeekSnapshot(),
    failure: { status: 429 },
    failureContext: { dispatched: true, outputBytes: 1 },
  });
  assert.equal(streamed.status, "blocked");
  assert.equal(streamed.reason, "reconciliation_required");

  const tool = selectEngineeringFallback({
    snapshot: deepSeekSnapshot(),
    failure: { status: 503 },
    failureContext: { dispatched: true, toolActionState: "ambiguous" },
  });
  assert.equal(tool.status, "blocked");
  assert.equal(tool.failure.maySwitchRoute, false);
});

test("auth fallback skips routes sharing the failed provider credential", () => {
  const snapshot = deepSeekSnapshot({
    selected: candidate("provider-a/model", "provider-a", "family-a", "host-a"),
    fallbacks: [
      candidate("provider-a/other", "provider-a", "family-b", "host-b"),
      candidate("provider-b/model", "provider-b", "family-c", "host-c"),
    ],
  });
  const result = selectEngineeringFallback({
    snapshot,
    current: "provider-a/model",
    failure: { status: 401 },
    taskId: "task-auth",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.selected.model, "provider-b/model");
  assert.match(result.rejectedCandidates[0].reason, /credential|entitlement/u);
});

test("quality fallback requires a different family and keeps acceptance failure visible", () => {
  const snapshot = deepSeekSnapshot({
    selected: candidate("provider-a/model", "provider-a", "family-a", "host-a"),
    fallbacks: [
      candidate("provider-b/same-family", "provider-b", "family-a", "host-b"),
      candidate("provider-c/stronger", "provider-c", "family-c", "host-c"),
    ],
  });
  const result = selectEngineeringFallback({
    snapshot,
    failure: { code: "quality_failure", message: "failed test gate" },
    failureContext: { dispatched: true },
  });
  assert.equal(result.selected.model, "provider-c/stronger");
  assert.equal(result.failure.failureClass, "MODEL_QUALITY_FAILURE");
  assert.match(result.rejectedCandidates[0].reason, /different model family/u);
});

test("every DeepSeek occurrence must carry the named policy and a later non-Modal recovery", () => {
  const missingPolicy = deepSeekSnapshot({
    selected: candidate("kiro-prism/deepseek-v4.1-flash", "kiro-prism", "deepseek", "modal"),
  });
  assert.throws(() => validateDeepSeekFallbackSnapshot(missingPolicy), /missing deepseek-non-modal-fallback/u);

  const laterDeepSeek = deepSeekSnapshot({
    fallbacks: [
      candidate("kiro-prism/gpt-5.6-sol", "kiro-prism", "gpt-5.6", "kiro-prism"),
      candidate("kiro-prism/deepseek-v4.1-flash", "kiro-prism", "deepseek", "modal", "high", {
        capacityFailurePolicy: DEEPSEEK_NON_MODAL_FALLBACK,
      }),
    ],
  });
  assert.throws(() => validateDeepSeekFallbackSnapshot(laterDeepSeek), /no later eligible non-Modal/u);

  const mutable = structuredClone(deepSeekSnapshot());
  assert.throws(() => validateDeepSeekFallbackSnapshot(mutable), /immutable assignment snapshot/u);

  const shallowFrozen = Object.freeze(structuredClone(deepSeekSnapshot()));
  assert.throws(() => validateDeepSeekFallbackSnapshot(shallowFrozen), /immutable assignment snapshot/u);
});

test("Kimi and same-Modal alternatives cannot satisfy DeepSeek recovery", () => {
  const snapshot = deepSeekSnapshot({
    fallbacks: [
      candidate("kiro-prism/kimi-k3", "kiro-prism", "kimi", "kiro-prism"),
      candidate("other/deepseek", "other", "deepseek", "other"),
      candidate("modal/glm-5.3", "modal-provider", "glm", "modal"),
      candidate("kiro-prism/gpt-5.6-sol", "kiro-prism", "gpt-5.6", "kiro-prism"),
    ],
  });
  const result = selectEngineeringFallback({
    snapshot,
    failure: { status: 429 },
    failureContext: { dispatched: true },
  });
  assert.equal(result.selected.model, "kiro-prism/gpt-5.6-sol");
  assert.deepEqual(result.rejectedCandidates.map(({ reason }) => reason), [
    "Kimi is excluded from default DeepSeek recovery",
    "DeepSeek recovery must leave the saturated family",
    "DeepSeek recovery must leave the Modal capacity host",
  ]);
});
