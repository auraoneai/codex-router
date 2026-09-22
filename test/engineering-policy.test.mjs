import assert from "node:assert/strict";
import test from "node:test";

import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { readEngineeringPolicyDefaults } from "../src/engineering/policy-state.mjs";
import {
  createEngineeringAssignmentSnapshot,
  DEEPSEEK_CAPACITY_POLICY,
  resolveEngineeringAssignment,
  resolveEngineeringLead,
  validateEngineeringPolicy,
} from "../src/engineering/policy.mjs";

function enabledPolicy(mutator = (policy) => policy) {
  const policy = structuredClone(readEngineeringPolicyDefaults());
  policy.enabled = true;
  return mutator(policy) || policy;
}

function offered(slug, extra = {}) {
  const model = MODEL_BY_SLUG.get(slug);
  return {
    model: slug,
    agentType: routedAgentDefinition(model).agentName,
    eligible: true,
    healthy: true,
    ...extra,
  };
}

test("policy rejects unknown roles, routes, aliases, efforts, and duplicate candidates", () => {
  const unknownRole = enabledPolicy((policy) => {
    policy.workspace.roles.typo_role = { candidates: [{ model: "kiro-prism/gpt-5.6-sol" }] };
  });
  assert.throws(() => validateEngineeringPolicy(unknownRole), /unsupported engineering role/u);

  const unknownModel = enabledPolicy((policy) => {
    policy.workspace.roles.complex_coder = { candidates: [{ model: "missing/model" }] };
  });
  assert.throws(() => validateEngineeringPolicy(unknownModel), /unknown model/u);

  const unsupportedEffort = enabledPolicy((policy) => {
    policy.workspace.roles.complex_coder = {
      candidates: [{ model: "gemini-api/models/gemini-3.8-flash", effort: "max" }],
    };
  });
  assert.throws(() => validateEngineeringPolicy(unsupportedEffort), /not advertised/u);

  const duplicate = enabledPolicy((policy) => {
    policy.workspace.roles.complex_coder = {
      candidates: [
        { model: "kiro-prism/claude-sonnet-5", effort: "high" },
        { model: "kiro-prism/claude-sonnet-5", effort: "low" },
      ],
    };
  });
  assert.throws(() => validateEngineeringPolicy(duplicate), /repeats a model/u);
});

test("disabled policy preserves ordinary Codex behavior without requiring child inventory", () => {
  const result = resolveEngineeringAssignment({
    policy: readEngineeringPolicyDefaults(),
    role: "complex_coder",
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.executionSelectionMode, "pinned");
  assert.equal(result.rejectedCandidates.length, 0);
});

test("pinned selection stays stable even when optional models are enabled", () => {
  const sonnet = "kiro-prism/claude-sonnet-5";
  const kimi = "kiro-prism/kimi-k3";
  const policy = enabledPolicy((value) => {
    value.enabledOptionalModels = [kimi];
  });
  assert.equal(policy.executionSelectionMode, "pinned");
  const result = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    configuredModels: [sonnet, kimi],
    offeredBindings: [offered(sonnet), offered(kimi)],
  });
  assert.equal(result.selected.model, sonnet);
  assert.equal(result.executionSelectionMode, "pinned");
  assert.equal(result.eligibleCandidates.some(({ model }) => model === kimi), false);
});

test("adaptive selection is opt-in and may use only explicitly enabled optional candidates", () => {
  const kimi = "kiro-prism/kimi-k3";
  const policy = enabledPolicy((value) => {
    value.executionSelectionMode = "adaptive";
    value.enabledOptionalModels = [kimi];
  });
  const result = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    configuredModels: [kimi],
    offeredBindings: [offered(kimi)],
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.selected.model, kimi);
  assert.equal(result.executionSelectionMode, "adaptive");

  policy.enabledOptionalModels = [];
  const gated = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    taskOverride: { model: kimi, effort: "high" },
    configuredModels: [kimi],
    offeredBindings: [offered(kimi)],
  });
  assert.equal(gated.status, "exhausted");
  assert.match(gated.rejectedCandidates[0].reason, /not enabled/u);
});

test("unknown execution selection modes are rejected", () => {
  const policy = enabledPolicy((value) => {
    value.executionSelectionMode = "automatic";
  });
  assert.throws(() => validateEngineeringPolicy(policy), /executionSelectionMode must be pinned or adaptive/u);
});

test("Kimi remains sparse and optional in every preset", () => {
  const policy = readEngineeringPolicyDefaults();
  for (const preset of Object.values(policy.presets)) {
    const primaryKimi = Object.values(preset.roles)
      .flatMap((role) => role.candidates)
      .filter(({ model }) => model.includes("kimi"));
    const optionalKimiRoles = Object.entries(preset.roles)
      .filter(([, role]) => (role.optionalCandidates || []).some(({ model }) => model === "kiro-prism/kimi-k3"))
      .map(([roleName]) => roleName)
      .sort();
    assert.deepEqual(primaryKimi, []);
    assert.deepEqual(optionalKimiRoles, ["complex_coder", "reviewer"]);
  }
});

test("adaptive child selection cannot replace the native Astra lead", () => {
  const policy = enabledPolicy((value) => {
    value.executionSelectionMode = "adaptive";
    value.enabledOptionalModels = ["kiro-prism/kimi-k3"];
  });
  const result = resolveEngineeringLead({
    policy,
    offeredBindings: [{
      model: "gpt-6-astra",
      provider: "native-codex",
      nativeParent: true,
      executionMode: "native-parent",
      eligible: true,
      healthy: true,
      defaultEffort: "high",
      supportedEfforts: ["high"],
    }],
  });
  assert.equal(result.selected.model, "gpt-6-astra");
  assert.equal(result.selected.executionMode, "native-parent");
  assert.equal(result.executionSelectionMode, "adaptive");
});

test("task and attempt effort overrides are isolated and fallbacks retain their own effort", () => {
  const policy = enabledPolicy();
  const configuredModels = ["kiro-prism/claude-sonnet-5", "kiro-prism/gpt-5.6-sol"];
  const offeredBindings = configuredModels.map((slug) => offered(slug));
  const low = resolveEngineeringAssignment({
    policy,
    policyRevision: 7,
    role: "complex_coder",
    attemptOverride: { model: "kiro-prism/gpt-5.6-sol", effort: "low" },
    configuredModels,
    offeredBindings,
  });
  const max = resolveEngineeringAssignment({
    policy,
    policyRevision: 7,
    role: "complex_coder",
    attemptOverride: { model: "kiro-prism/gpt-5.6-sol", effort: "max" },
    configuredModels,
    offeredBindings,
  });
  assert.equal(low.selected.model, "kiro-prism/gpt-5.6-sol");
  assert.equal(low.selected.effectiveEffort, "low");
  assert.equal(low.selected.effortSource, "attempt");
  assert.equal(low.fallbacks[0].model, "kiro-prism/claude-sonnet-5");
  assert.equal(low.fallbacks[0].effectiveEffort, "high");
  assert.equal(max.selected.effectiveEffort, "max");
  assert.equal(low.selected.effectiveEffort, "low");
  assert.equal(Object.isFrozen(low), true);
  assert.equal(Object.isFrozen(low.selected), true);

  const snapshot = createEngineeringAssignmentSnapshot(low);
  assert.equal(snapshot.policyRevision, 7);
  assert.equal(snapshot.executionSelectionMode, "pinned");
  assert.equal(snapshot.selected.effectiveEffort, "low");
  assert.equal(Object.isFrozen(snapshot.fallbacks), true);
});

test("effort precedence is role then operator model default then advertised route default", () => {
  const slug = "kiro-prism/gpt-5.6-sol";
  const policy = enabledPolicy((value) => {
    value.workspace.roles.complex_coder = { candidates: [{ model: slug, effort: "default" }] };
    value.operatorModelDefaults[slug] = "low";
  });
  const fromOperator = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    configuredModels: [slug],
    offeredBindings: [offered(slug)],
  });
  assert.equal(fromOperator.selected.effectiveEffort, "low");
  assert.equal(fromOperator.selected.effortSource, "operator-model-default");

  delete policy.operatorModelDefaults[slug];
  const fromRoute = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    configuredModels: [slug],
    offeredBindings: [offered(slug)],
  });
  assert.equal(fromRoute.selected.effectiveEffort, MODEL_BY_SLUG.get(slug).defaultEffort);
  assert.equal(fromRoute.selected.effortSource, "route-default");
  assert.notEqual(fromRoute.selected.effectiveEffort, "default");
});

test("runtime model inventory can add an exact offered Codex child route", () => {
  const runtime = {
    slug: "runtime-provider/specialist",
    provider: "runtime-provider",
    upstreamModel: "specialist-v1",
    gatewayModel: "specialist-v1",
    displayName: "Runtime Specialist",
    defaultEffort: "low",
    reasoningLevels: [{ effort: "low" }, { effort: "high" }],
    listed: true,
  };
  const policy = enabledPolicy((value) => {
    value.workspace.roles.complex_coder = {
      candidates: [{ model: runtime.slug, effort: "high" }],
    };
  });
  const result = resolveEngineeringAssignment({
    policy,
    role: "complex_coder",
    modelInventory: [runtime],
    configuredModels: [runtime.slug],
    offeredBindings: [{
      model: runtime.slug,
      agentType: routedAgentDefinition(runtime).agentName,
      eligible: true,
      healthy: true,
    }],
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.selected.model, runtime.slug);
  assert.equal(result.selected.effectiveEffort, "high");
});

test("catalog presence alone is insufficient; the exact offered agent binding must match", () => {
  const slug = "gemini-api/models/gemini-3.8-flash";
  const result = resolveEngineeringAssignment({
    policy: enabledPolicy(),
    role: "general_coder",
    configuredModels: [slug],
    offeredBindings: [{ model: slug, agentType: "router_stale_name", eligible: true }],
  });
  assert.equal(result.status, "exhausted");
  assert.match(result.rejectedCandidates[0].reason, /does not exactly match/u);
});

test("high-risk reviewer resolution excludes the author's model family", () => {
  const sol = "kiro-prism/gpt-5.6-sol";
  const opus = "kiro-prism/claude-opus-5";
  const result = resolveEngineeringAssignment({
    policy: enabledPolicy(),
    role: "reviewer",
    highRisk: true,
    authorBinding: { model: sol },
    configuredModels: [sol, opus],
    offeredBindings: [offered(sol), offered(opus)],
  });
  assert.equal(result.selected.model, opus);
  assert.match(result.rejectedCandidates[0].reason, /matches author family/u);
});

test("every DeepSeek assignment inherits ordered non-Modal recovery and is rejected without it", () => {
  const deepseek = "kiro-prism/deepseek-v4.1-flash";
  const glm = "cloudflare-workers-ai/glm-5.3";
  const sol = "kiro-prism/gpt-5.6-sol";
  const sonnet = "kiro-prism/claude-sonnet-5";
  const configuredModels = [deepseek, glm, sol, sonnet];
  const offeredBindings = [
    offered(deepseek, { capacityHost: "modal" }),
    offered(glm, { capacityHost: "cloudflare-workers-ai" }),
    offered(sol, { capacityHost: "kiro-prism" }),
    offered(sonnet, { capacityHost: "kiro-prism" }),
  ];
  const result = resolveEngineeringAssignment({
    policy: enabledPolicy(),
    role: "complex_coder",
    taskOverride: { model: deepseek, effort: "high" },
    configuredModels,
    offeredBindings,
  });
  assert.equal(result.selected.model, deepseek);
  assert.equal(result.selected.capacityFailurePolicy, DEEPSEEK_CAPACITY_POLICY);
  assert.deepEqual(result.fallbacks.slice(0, 3).map(({ model }) => model), [glm, sol, sonnet]);
  assert.equal(result.fallbacks[0].capacityHost, "cloudflare-workers-ai");

  const exhausted = resolveEngineeringAssignment({
    policy: enabledPolicy(),
    role: "complex_coder",
    taskOverride: { model: deepseek, effort: "high" },
    configuredModels: [deepseek],
    offeredBindings: [offered(deepseek, { capacityHost: "modal" })],
  });
  assert.equal(exhausted.status, "exhausted");
  assert.match(exhausted.rejectedCandidates[0].reason, /no later eligible non-Modal fallback/u);
});

test("native Astra lead is separate from routed deputies and validated against live Codex inventory", () => {
  const policy = enabledPolicy();
  assert.throws(() => resolveEngineeringAssignment({
    policy,
    role: "lead_engineer",
  }), /resolveEngineeringLead/u);

  const missing = resolveEngineeringLead({ policy, offeredBindings: [] });
  assert.equal(missing.status, "exhausted");
  const resolved = resolveEngineeringLead({
    policy,
    policyRevision: 4,
    offeredBindings: [{
      model: "gpt-6-astra",
      provider: "native-codex",
      nativeParent: true,
      executionMode: "native-parent",
      eligible: true,
      healthy: true,
      defaultEffort: "high",
      supportedEfforts: ["medium", "high", "max"],
    }],
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.selected.model, "gpt-6-astra");
  assert.equal(resolved.selected.executionMode, "native-parent");
  assert.equal(resolved.selected.agentType, null);
  assert.equal(resolved.selected.effectiveEffort, "high");
});
