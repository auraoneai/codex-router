import { routedAgentDefinition } from "../codex-agent-catalog.mjs";
import { LISTED_MODELS, MODEL_BY_SLUG } from "../model-registry.mjs";
import { immutableSnapshot } from "./contracts.mjs";

export const ENGINEERING_POLICY_SCHEMA_VERSION = 1;
export const DEEPSEEK_CAPACITY_POLICY = "deepseek-non-modal-fallback";
export const ENGINEERING_EXECUTION_SELECTION_MODES = Object.freeze(["pinned", "adaptive"]);
export const ENGINEERING_NATIVE_MODELS = Object.freeze([
  Object.freeze({
    slug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol (Codex native)",
    provider: "openai",
    upstreamModel: "gpt-5.6-sol",
    gatewayModel: "gpt-5.6-sol",
    native: true,
    listed: true,
    multiAgentVersion: "v2",
    defaultEffort: "low",
    reasoningLevels: Object.freeze(
      ["low", "medium", "high", "xhigh", "max", "ultra"]
        .map((effort) => Object.freeze({ effort })),
    ),
  }),
]);
export const ENGINEERING_ROLE_NAMES = Object.freeze([
  "lead_engineer",
  "architecture",
  "fast_general_worker",
  "repo_explorer",
  "mechanical_worker",
  "general_coder",
  "complex_coder",
  "debugger",
  "test_author",
  "reviewer",
  "integrator",
  "deputy_lead",
  "prose_docs",
  "synthesizer",
]);

const POLICY_KEYS = new Set([
  "version", "providers", "models",
  "schemaVersion", "enabled", "activePreset", "executionSelectionMode", "enabledOptionalModels",
  "operatorModelDefaults", "workspace", "presets", "lead", "deepSeekRecovery",
]);
const ROLE_KEYS = new Set([
  "candidates", "optionalCandidates", "capacityFailurePolicy",
  "requireDifferentFamilyFromAuthor", "minimumCapabilities",
]);
const CANDIDATE_KEYS = new Set([
  "model", "effort", "capacityHost", "disabled", "minimumCapabilities",
]);
const PRESET_KEYS = new Set(["roles"]);
const WORKSPACE_KEYS = new Set(["roles"]);
const OVERRIDE_KEYS = new Set(["model", "effort"]);
const LEAD_KEYS = new Set(["executionMode", "model", "effort"]);
const ROLE_NAMES = new Set(ENGINEERING_ROLE_NAMES);
const CHILD_ROLE_NAMES = ENGINEERING_ROLE_NAMES.filter((name) => name !== "lead_engineer");

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unsupported field ${key}.`);
  }
}

function canonicalListedModel(slug, { modelBySlug, listedModels }) {
  if (typeof slug !== "string" || !slug.trim()) return { error: "model must be a non-empty string" };
  const model = modelBySlug.get(slug);
  if (!model) return { error: `unknown model ${slug}` };
  if (model.slug !== slug) return { error: `${slug} is an alias; use exact route ${model.slug}` };
  if (!listedModels.some((candidate) => candidate.slug === slug)) {
    return { error: `model ${slug} is not listed` };
  }
  return { model };
}

function resolvedRegistry({
  modelBySlug = MODEL_BY_SLUG,
  listedModels = LISTED_MODELS,
  modelInventory = [],
} = {}) {
  if (!(modelBySlug instanceof Map)) throw new TypeError("Engineering modelBySlug must be a Map.");
  if (!Array.isArray(listedModels)) throw new TypeError("Engineering listedModels must be an array.");
  if (!Array.isArray(modelInventory)) throw new TypeError("Engineering modelInventory must be an array.");
  const combinedMap = new Map(modelBySlug);
  const combinedListed = new Map(listedModels.map((model) => [model?.slug, model]));
  const inventory = [...ENGINEERING_NATIVE_MODELS, ...modelInventory];
  for (const [index, model] of inventory.entries()) {
    if (!plainObject(model) || typeof model.slug !== "string" || !model.slug.trim()) {
      throw new TypeError(`Engineering modelInventory[${index}] must have a non-empty slug.`);
    }
    if (typeof model.provider !== "string" || !model.provider.trim()) {
      throw new TypeError(`Engineering modelInventory[${index}] must have a non-empty provider.`);
    }
    if (
      model.reasoningLevels !== undefined &&
      (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.some((level) => (
        !plainObject(level) || typeof level.effort !== "string" || !level.effort.trim()
      )))
    ) throw new TypeError(`Engineering modelInventory[${index}] has invalid reasoningLevels.`);
    combinedMap.set(model.slug, model);
    combinedListed.set(model.slug, model);
  }
  return { modelBySlug: combinedMap, listedModels: [...combinedListed.values()].filter(Boolean) };
}

export function engineeringModel(slug) {
  return MODEL_BY_SLUG.get(slug) || ENGINEERING_NATIVE_MODELS.find((model) => model.slug === slug);
}

export function engineeringAgentName(model) {
  if (model?.native === true) return `native_${String(model.slug).replace(/[^a-z0-9]+/giu, "_").replace(/^_|_$/gu, "")}`;
  return routedAgentDefinition(model).agentName;
}

function effortSupport(model, effort) {
  if (effort === undefined || effort === "default") return undefined;
  if (typeof effort !== "string" || !effort.trim()) {
    return "effort must be a non-empty string or default";
  }
  const efforts = new Set((model.reasoningLevels || []).map((level) => level.effort));
  return efforts.has(effort)
    ? undefined
    : `effort ${effort} is not advertised by ${model.slug}`;
}

function normalizedCapacityHost(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || undefined;
}

function validateCandidate(candidate, path, registry, errors) {
  if (!plainObject(candidate)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  rejectUnknownKeys(candidate, CANDIDATE_KEYS, path, errors);
  if (typeof candidate.model !== "string" || !candidate.model.trim()) {
    errors.push(`${path}.model must be a non-empty string.`);
    return;
  }
  const resolved = canonicalListedModel(candidate.model, registry);
  if (resolved.error) errors.push(`${path}: ${resolved.error}.`);
  else {
    const effortError = effortSupport(resolved.model, candidate.effort);
    if (effortError) errors.push(`${path}: ${effortError}.`);
  }
  if (candidate.effort !== undefined && typeof candidate.effort !== "string") {
    errors.push(`${path}.effort must be a string.`);
  }
  if (
    candidate.capacityHost !== undefined &&
    (typeof candidate.capacityHost !== "string" || !candidate.capacityHost.trim())
  ) {
    errors.push(`${path}.capacityHost must be a non-empty string.`);
  }
  if (candidate.disabled !== undefined && typeof candidate.disabled !== "boolean") {
    errors.push(`${path}.disabled must be a boolean.`);
  }
  if (
    candidate.minimumCapabilities !== undefined &&
    (!Array.isArray(candidate.minimumCapabilities) ||
      candidate.minimumCapabilities.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(candidate.minimumCapabilities).size !== candidate.minimumCapabilities.length)
  ) errors.push(`${path}.minimumCapabilities must be an array of non-empty strings.`);
}

function validateRoleName(roleName, path, errors) {
  if (!ROLE_NAMES.has(roleName)) {
    errors.push(`${path} names unsupported engineering role ${JSON.stringify(roleName)}.`);
    return false;
  }
  return true;
}

function validateRole(role, path, registry, errors) {
  if (!plainObject(role)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  rejectUnknownKeys(role, ROLE_KEYS, path, errors);
  if (!Array.isArray(role.candidates) || role.candidates.length === 0) {
    errors.push(`${path}.candidates must be a non-empty array.`);
  } else {
    role.candidates.forEach((candidate, index) => validateCandidate(candidate, `${path}.candidates[${index}]`, registry, errors));
  }
  if (role.optionalCandidates !== undefined) {
    if (!Array.isArray(role.optionalCandidates)) errors.push(`${path}.optionalCandidates must be an array.`);
    else role.optionalCandidates.forEach((candidate, index) => validateCandidate(candidate, `${path}.optionalCandidates[${index}]`, registry, errors));
  }
  const candidates = [
    ...(Array.isArray(role.candidates) ? role.candidates : []),
    ...(Array.isArray(role.optionalCandidates) ? role.optionalCandidates : []),
  ];
  const slugs = candidates.map((candidate) => candidate?.model).filter((slug) => typeof slug === "string");
  if (new Set(slugs).size !== slugs.length) {
    errors.push(`${path} repeats a model across candidates and optionalCandidates.`);
  }
  if (
    role.capacityFailurePolicy !== undefined &&
    role.capacityFailurePolicy !== DEEPSEEK_CAPACITY_POLICY
  ) errors.push(`${path}.capacityFailurePolicy is unsupported.`);
  if (
    role.requireDifferentFamilyFromAuthor !== undefined &&
    typeof role.requireDifferentFamilyFromAuthor !== "boolean"
  ) errors.push(`${path}.requireDifferentFamilyFromAuthor must be a boolean.`);
  if (
    role.minimumCapabilities !== undefined &&
    (!Array.isArray(role.minimumCapabilities) ||
      role.minimumCapabilities.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(role.minimumCapabilities).size !== role.minimumCapabilities.length)
  ) errors.push(`${path}.minimumCapabilities must be an array of unique non-empty strings.`);
}

function validateOverride(value, label) {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !OVERRIDE_KEYS.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported field ${unknown[0]}.`);
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new TypeError(`${label}.model must be a non-empty string.`);
  }
  if (value.effort !== undefined && (typeof value.effort !== "string" || !value.effort.trim())) {
    throw new TypeError(`${label}.effort must be a non-empty string.`);
  }
  if (value.model === undefined && value.effort === undefined) {
    throw new TypeError(`${label} must override model or effort.`);
  }
  return value;
}

export function validateEngineeringPolicy(input, registryOptions = {}) {
  const { modelBySlug, listedModels } = resolvedRegistry(registryOptions);
  const errors = [];
  if (!plainObject(input)) throw new TypeError("Engineering policy must be an object.");
  rejectUnknownKeys(input, POLICY_KEYS, "Engineering policy", errors);
  if (
    input.version !== undefined &&
    (input.version !== 1 || !Array.isArray(input.providers) || input.providers.length || !Array.isArray(input.models) || input.models.length)
  ) {
    errors.push("Engineering policy registry compatibility fields must be version 1 with empty providers and models arrays.");
  }
  if (input.schemaVersion !== ENGINEERING_POLICY_SCHEMA_VERSION) {
    errors.push(`Engineering policy schemaVersion must be ${ENGINEERING_POLICY_SCHEMA_VERSION}.`);
  }
  if (typeof input.enabled !== "boolean") errors.push("Engineering policy enabled must be a boolean.");
  if (!ENGINEERING_EXECUTION_SELECTION_MODES.includes(input.executionSelectionMode)) {
    errors.push("Engineering policy executionSelectionMode must be pinned or adaptive.");
  }
  if (!plainObject(input.lead)) {
    errors.push("Engineering policy lead must be an object.");
  } else {
    rejectUnknownKeys(input.lead, LEAD_KEYS, "lead", errors);
    if (input.lead.executionMode !== "native-parent") {
      errors.push("Engineering policy lead.executionMode must be native-parent.");
    }
    if (typeof input.lead.model !== "string" || !input.lead.model.trim()) {
      errors.push("Engineering policy lead.model must be a non-empty exact Codex model id.");
    }
    if (typeof input.lead.effort !== "string" || !input.lead.effort.trim()) {
      errors.push("Engineering policy lead.effort must be a non-empty string.");
    }
  }
  if (!Array.isArray(input.deepSeekRecovery) || input.deepSeekRecovery.length === 0) {
    errors.push("Engineering policy deepSeekRecovery must be a non-empty candidate array.");
  } else {
    input.deepSeekRecovery.forEach((candidate, index) => {
      validateCandidate(candidate, `deepSeekRecovery[${index}]`, { modelBySlug, listedModels }, errors);
      const resolved = plainObject(candidate)
        ? canonicalListedModel(candidate.model, { modelBySlug, listedModels })
        : {};
      if (resolved.model && isDeepSeekV41Flash(resolved.model)) {
        errors.push(`deepSeekRecovery[${index}] cannot target DeepSeek V4.1 Flash.`);
      }
    });
    const recoverySlugs = input.deepSeekRecovery.map((candidate) => candidate?.model).filter(Boolean);
    if (new Set(recoverySlugs).size !== recoverySlugs.length) {
      errors.push("Engineering policy deepSeekRecovery must not contain duplicate routes.");
    }
  }
  if (typeof input.activePreset !== "string" || !input.activePreset) {
    errors.push("Engineering policy activePreset must be a non-empty string.");
  }
  if (!plainObject(input.presets) || Object.keys(input.presets).length === 0) {
    errors.push("Engineering policy presets must be a non-empty object.");
  } else {
    for (const [presetName, preset] of Object.entries(input.presets)) {
      if (!presetName.trim()) {
        errors.push("Engineering policy preset names must be non-empty.");
        continue;
      }
      if (!plainObject(preset) || !plainObject(preset.roles)) {
        errors.push(`presets.${presetName}.roles must be an object.`);
        continue;
      }
      rejectUnknownKeys(preset, PRESET_KEYS, `presets.${presetName}`, errors);
      for (const [roleName, role] of Object.entries(preset.roles)) {
        if (!validateRoleName(roleName, `presets.${presetName}.roles`, errors)) continue;
        validateRole(role, `presets.${presetName}.roles.${roleName}`, { modelBySlug, listedModels }, errors);
      }
      for (const roleName of CHILD_ROLE_NAMES) {
        if (!Object.hasOwn(preset.roles, roleName)) {
          errors.push(`presets.${presetName}.roles is missing required role ${roleName}.`);
        }
      }
    }
  }
  if (plainObject(input.presets) && !Object.hasOwn(input.presets, input.activePreset)) {
    errors.push(`Engineering policy activePreset ${JSON.stringify(input.activePreset)} does not exist.`);
  }
  if (!Array.isArray(input.enabledOptionalModels)) {
    errors.push("Engineering policy enabledOptionalModels must be an array.");
  } else {
    const optionalRoutes = new Set();
    if (plainObject(input.presets)) {
      for (const preset of Object.values(input.presets)) {
        if (!plainObject(preset?.roles)) continue;
        for (const role of Object.values(preset.roles)) {
          for (const candidate of role?.optionalCandidates || []) optionalRoutes.add(candidate?.model);
        }
      }
    }
    if (new Set(input.enabledOptionalModels).size !== input.enabledOptionalModels.length) {
      errors.push("Engineering policy enabledOptionalModels must not contain duplicates.");
    }
    for (const [index, slug] of input.enabledOptionalModels.entries()) {
      const resolved = canonicalListedModel(slug, { modelBySlug, listedModels });
      if (resolved.error) errors.push(`enabledOptionalModels[${index}]: ${resolved.error}.`);
      else if (!optionalRoutes.has(slug)) {
        errors.push(`enabledOptionalModels[${index}]: ${slug} is not an optional candidate in any preset.`);
      }
    }
  }
  if (!plainObject(input.operatorModelDefaults)) {
    errors.push("Engineering policy operatorModelDefaults must be an object.");
  } else {
    for (const [slug, effort] of Object.entries(input.operatorModelDefaults)) {
      const resolved = canonicalListedModel(slug, { modelBySlug, listedModels });
      if (resolved.error) errors.push(`operatorModelDefaults.${slug}: ${resolved.error}.`);
      else {
        const effortError = effortSupport(resolved.model, effort);
        if (effortError) errors.push(`operatorModelDefaults.${slug}: ${effortError}.`);
      }
    }
  }
  if (!plainObject(input.workspace) || !plainObject(input.workspace.roles)) {
    errors.push("Engineering policy workspace.roles must be an object.");
  } else {
    rejectUnknownKeys(input.workspace, WORKSPACE_KEYS, "workspace", errors);
    for (const [roleName, role] of Object.entries(input.workspace.roles)) {
      if (!validateRoleName(roleName, "workspace.roles", errors)) continue;
      validateRole(role, `workspace.roles.${roleName}`, { modelBySlug, listedModels }, errors);
    }
  }
  if (errors.length) {
    const error = new Error(`Invalid engineering policy:\n- ${errors.join("\n- ")}`);
    error.code = "invalid_engineering_policy";
    error.errors = Object.freeze(errors);
    throw error;
  }
  return immutableSnapshot(input);
}

export function modelFamily(model) {
  const id = String(model?.upstreamModel || model?.slug || "").toLowerCase();
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("kimi")) return "kimi";
  if (id.includes("glm")) return "glm";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("claude")) return "claude";
  if (/gpt[-_/]?5\.6/.test(id)) return "gpt-5.6";
  if (/gpt[-_/]?6/.test(id)) return "gpt-6";
  return `model:${id}`;
}

function isDeepSeekV41Flash(model) {
  const identities = [model?.slug, model?.upstreamModel, model?.gatewayModel]
    .map((value) => String(value || "").toLowerCase());
  return identities.some((identity) => /(?:^|[/_-])deepseek-v4[._-]?1-flash$/u.test(identity));
}

function normalizeSlugSet(values) {
  return new Set((values || []).map((value) => typeof value === "string" ? value : value?.slug).filter(Boolean));
}

function offeredBindingMap(values) {
  const map = new Map();
  for (const binding of values || []) {
    if (!binding || typeof binding.model !== "string") continue;
    if (map.has(binding.model)) {
      map.set(binding.model, { model: binding.model, duplicate: true });
    } else {
      map.set(binding.model, binding);
    }
  }
  return map;
}

function compiledRole(policy, roleName) {
  const preset = policy.presets[policy.activePreset];
  const base = preset.roles[roleName];
  const override = policy.workspace.roles[roleName];
  return override || base;
}

function overrideCandidate(role, attemptOverride, taskOverride, {
  executionSelectionMode,
  enabledOptional,
}) {
  const source = attemptOverride?.model ? "attempt" : taskOverride?.model ? "task" : "role";
  const model = attemptOverride?.model || taskOverride?.model;
  if (!model) return { candidates: role.candidates, source };
  const roleOptionalRoutes = new Set((role.optionalCandidates || []).map((candidate) => candidate.model));
  if (roleOptionalRoutes.has(model) && (
    executionSelectionMode !== "adaptive" || !enabledOptional.has(model)
  )) {
    return {
      candidates: role.candidates,
      source: "role",
      rejectedOverride: {
        model,
        reason: executionSelectionMode !== "adaptive"
          ? "optional route requires adaptive execution selection mode"
          : "optional route is not enabled by enabledOptionalModels",
      },
    };
  }
  const configured = [...role.candidates, ...(role.optionalCandidates || [])].find((candidate) => candidate.model === model);
  return {
    source,
    candidates: [{ ...(configured || {}), model }, ...role.candidates.filter((candidate) => candidate.model !== model)],
  };
}

function effectiveEffort({ model, candidate, attemptOverride, taskOverride, operatorDefaults }) {
  const choices = [
    [attemptOverride?.effort, "attempt"],
    [taskOverride?.effort, "task"],
    [candidate.effort, "role"],
    [operatorDefaults[model.slug], "operator-model-default"],
    [model.defaultEffort, "route-default"],
  ];
  for (const [effort, source] of choices) {
    if (effort === undefined || effort === null || effort === "" || effort === "default") continue;
    const problem = effortSupport(model, effort);
    if (problem) return { error: problem, requestedEffort: effort, effortSource: source };
    return { requestedEffort: effort, effectiveEffort: effort, effortSource: source };
  }
  if (typeof model.defaultEffort === "string" && model.defaultEffort) {
    return { requestedEffort: "default", effectiveEffort: model.defaultEffort, effortSource: "route-default" };
  }
  return { requestedEffort: "default", effectiveEffort: "unknown", effortSource: "unknown" };
}

function candidateCapabilities(model, candidate, role) {
  const required = [...(role.minimumCapabilities || []), ...(candidate.minimumCapabilities || [])];
  const missing = required.filter((capability) => {
    if (capability === "vision") return !(model.inputModalities || []).includes("image");
    if (capability === "tools") return model.multiAgentVersion !== "v2";
    return model[capability] !== true;
  });
  return missing.length ? `missing capabilities: ${missing.join(", ")}` : undefined;
}

function evaluateCandidate(candidate, context) {
  const { registry, configured, offered, role, authorFamily, requireDifferentFamily, effortOverrides } = context;
  if (candidate.disabled) return { rejected: "disabled by policy" };
  const resolved = canonicalListedModel(candidate.model, registry);
  if (resolved.error) return { rejected: resolved.error };
  const model = resolved.model;
  if (!configured.has(model.slug)) return { rejected: "route is not selected and credential-configured" };
  const expectedAgentName = engineeringAgentName(model);
  const binding = offered.get(model.slug);
  if (!binding) return { rejected: `agent type ${expectedAgentName} is not currently offered` };
  if (binding.duplicate) return { rejected: "multiple offered bindings claim the same exact route" };
  if (binding.agentType !== expectedAgentName || binding.model !== model.slug) {
    return { rejected: `offered binding does not exactly match ${expectedAgentName} -> ${model.slug}` };
  }
  if (binding.eligible !== true) return { rejected: binding.reason || "offered binding eligibility is not proven" };
  if (binding.healthy !== true) return { rejected: binding.reason || "offered binding health is not proven" };
  if (
    candidate.capacityHost && binding.capacityHost &&
    normalizedCapacityHost(candidate.capacityHost) !== normalizedCapacityHost(binding.capacityHost)
  ) {
    return { rejected: `capacity host ${candidate.capacityHost} conflicts with offered binding host ${binding.capacityHost}` };
  }
  const family = modelFamily(model);
  if (requireDifferentFamily && authorFamily && family === authorFamily) {
    return { rejected: `reviewer family ${family} matches author family` };
  }
  const capabilityError = candidateCapabilities(model, candidate, role);
  if (capabilityError) return { rejected: capabilityError };
  const effort = effectiveEffort({ model, candidate, ...effortOverrides });
  if (effort.error) return { rejected: effort.error };
  return {
    assignment: {
      requestedSlug: candidate.model,
      model: model.slug,
      provider: model.provider,
      codexProvider: model.native === true ? "openai" : "codex-router",
      upstreamModel: model.upstreamModel,
      gatewayModel: model.gatewayModel,
      family,
      agentType: binding.agentType,
      requestedEffort: effort.requestedEffort,
      effectiveEffort: effort.effectiveEffort,
      effortSource: effort.effortSource,
      capacityHost: normalizedCapacityHost(binding.capacityHost || candidate.capacityHost || model.provider),
      capacityFailurePolicy: isDeepSeekV41Flash(model) ? DEEPSEEK_CAPACITY_POLICY : undefined,
    },
  };
}

export function resolveEngineeringAssignment({
  policy: policyInput,
  policyRevision = 0,
  role: roleName,
  attemptOverride,
  taskOverride,
  authorBinding,
  highRisk = false,
  configuredModels = [],
  offeredBindings = [],
  modelBySlug = MODEL_BY_SLUG,
  listedModels = LISTED_MODELS,
  modelInventory = [],
} = {}) {
  const registry = resolvedRegistry({ modelBySlug, listedModels, modelInventory });
  modelBySlug = registry.modelBySlug;
  listedModels = registry.listedModels;
  const policy = validateEngineeringPolicy(policyInput, registry);
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 0) {
    throw new TypeError("Engineering policyRevision must be a non-negative safe integer.");
  }
  if (typeof roleName !== "string" || !ROLE_NAMES.has(roleName)) {
    throw new TypeError(`Unsupported engineering role ${JSON.stringify(roleName)}.`);
  }
  validateOverride(attemptOverride, "attemptOverride");
  validateOverride(taskOverride, "taskOverride");
  if (!policy.enabled) {
    return immutableSnapshot({
      status: "disabled",
      policyRevision,
      preset: policy.activePreset,
      role: roleName,
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [],
    });
  }
  const role = compiledRole(policy, roleName);
  if (!role) {
    if (roleName === "lead_engineer") {
      throw new Error("Native lead assignments must use resolveEngineeringLead; they are not child-agent routes.");
    }
    throw new Error(`Engineering role ${JSON.stringify(roleName)} is not defined by preset ${policy.activePreset}.`);
  }
  const configured = normalizeSlugSet(configuredModels);
  const offered = offeredBindingMap(offeredBindings);
  const authorModel = authorBinding?.model ? modelBySlug.get(authorBinding.model) : undefined;
  const authorFamily = authorBinding?.family || (authorModel ? modelFamily(authorModel) : undefined);
  const requireDifferentFamily = Boolean(role.requireDifferentFamilyFromAuthor || (highRisk && roleName === "reviewer"));
  const enabledOptional = new Set(policy.enabledOptionalModels);
  const base = overrideCandidate(role, attemptOverride, taskOverride, {
    executionSelectionMode: policy.executionSelectionMode,
    enabledOptional,
  });
  const configuredCandidates = [
    ...base.candidates,
    ...(policy.executionSelectionMode === "adaptive"
      ? (role.optionalCandidates || []).filter((candidate) => enabledOptional.has(candidate.model))
      : []),
  ];
  const candidatesWithRecovery = [];
  for (const candidate of configuredCandidates) {
    candidatesWithRecovery.push(candidate);
    const resolved = modelBySlug.get(candidate.model);
    if (resolved && isDeepSeekV41Flash(resolved)) {
      candidatesWithRecovery.push(...policy.deepSeekRecovery);
    }
  }
  const candidates = candidatesWithRecovery.filter((candidate, index, all) => (
    all.findIndex((entry) => entry.model === candidate.model) === index
  ));
  const evaluated = candidates.map((candidate, index) => ({
    candidate,
    ...evaluateCandidate(candidate, {
      registry,
      configured,
      offered,
      role,
      authorFamily,
      requireDifferentFamily,
      effortOverrides: {
        // A scoped override belongs to the selected attempt, not to every
        // fallback. Each fallback keeps its own policy/operator/route effort.
        attemptOverride: index === 0 ? attemptOverride : undefined,
        taskOverride: index === 0 ? taskOverride : undefined,
        operatorDefaults: policy.operatorModelDefaults,
      },
    }),
  }));

  for (let index = 0; index < evaluated.length; index += 1) {
    const item = evaluated[index];
    if (!item.assignment || !isDeepSeekV41Flash(modelBySlug.get(item.assignment.model))) continue;
    const recovery = evaluated.slice(index + 1).find((later) => (
      later.assignment &&
      later.assignment.family !== "deepseek" &&
      normalizedCapacityHost(later.assignment.capacityHost) !== "modal"
    ));
    if (!recovery) {
      delete item.assignment;
      item.rejected = "DeepSeek V4.1 Flash has no later eligible non-Modal fallback";
    }
  }

  const eligible = evaluated.filter((item) => item.assignment).map((item) => item.assignment);
  const rejectedCandidates = [
    ...(base.rejectedOverride ? [base.rejectedOverride] : []),
    ...evaluated
    .filter((item) => !item.assignment)
    .map((item) => ({ model: item.candidate.model, reason: item.rejected })),
  ];
  if (!eligible.length) {
    return immutableSnapshot({
      status: "exhausted",
      policyRevision,
      preset: policy.activePreset,
      role: roleName,
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates,
    });
  }
  const selected = eligible[0];
  return immutableSnapshot({
    status: "resolved",
    policyRevision,
    preset: policy.activePreset,
    role: roleName,
    executionSelectionMode: policy.executionSelectionMode,
    selectionSource: base.source,
    selected,
    fallbacks: eligible.slice(1),
    eligibleCandidates: eligible,
    rejectedCandidates,
    familyConstraint: requireDifferentFamily && authorFamily
      ? { differentFrom: authorFamily }
      : undefined,
  });
}

function inventoryEfforts(binding) {
  const values = binding?.supportedEfforts || binding?.reasoningLevels || [];
  return new Set(values.map((entry) => typeof entry === "string" ? entry : entry?.effort).filter(Boolean));
}

export function resolveEngineeringLead({
  policy: policyInput,
  policyRevision = 0,
  override,
  offeredBindings = [],
  modelBySlug = MODEL_BY_SLUG,
  listedModels = LISTED_MODELS,
  modelInventory = [],
} = {}) {
  const registry = resolvedRegistry({ modelBySlug, listedModels, modelInventory });
  const policy = validateEngineeringPolicy(policyInput, registry);
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 0) {
    throw new TypeError("Engineering policyRevision must be a non-negative safe integer.");
  }
  validateOverride(override, "leadOverride");
  if (!policy.enabled) {
    return immutableSnapshot({
      status: "disabled",
      policyRevision,
      preset: policy.activePreset,
      role: "lead_engineer",
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [],
    });
  }
  const candidate = { ...policy.lead, ...(override || {}) };
  const matches = offeredBindings.filter((binding) => binding?.model === candidate.model);
  if (matches.length !== 1) {
    return immutableSnapshot({
      status: "exhausted",
      policyRevision,
      preset: policy.activePreset,
      role: "lead_engineer",
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [{
        model: candidate.model,
        reason: matches.length === 0
          ? "native parent model is not in the offered Codex inventory"
          : "multiple offered bindings claim the native parent model",
      }],
    });
  }
  const binding = matches[0];
  if (binding.nativeParent !== true || binding.executionMode !== "native-parent") {
    return immutableSnapshot({
      status: "exhausted",
      policyRevision,
      preset: policy.activePreset,
      role: "lead_engineer",
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [{ model: candidate.model, reason: "offered model is not the native Codex parent" }],
    });
  }
  if (binding.eligible !== true || binding.healthy !== true) {
    return immutableSnapshot({
      status: "exhausted",
      policyRevision,
      preset: policy.activePreset,
      role: "lead_engineer",
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [{ model: candidate.model, reason: binding.reason || "native parent is ineligible" }],
    });
  }
  const requestedEffort = candidate.effort;
  const advertised = inventoryEfforts(binding);
  if (requestedEffort !== "default" && !advertised.has(requestedEffort)) {
    return immutableSnapshot({
      status: "exhausted",
      policyRevision,
      preset: policy.activePreset,
      role: "lead_engineer",
      executionSelectionMode: policy.executionSelectionMode,
      rejectedCandidates: [{
        model: candidate.model,
        reason: `effort ${requestedEffort} is not advertised by native Codex inventory`,
      }],
    });
  }
  const effectiveEffort = requestedEffort === "default"
    ? (binding.defaultEffort || "unknown")
    : requestedEffort;
  const selected = {
    requestedSlug: candidate.model,
    model: candidate.model,
    provider: binding.provider || "native-codex",
    family: binding.family || modelFamily({ upstreamModel: candidate.model }),
    agentType: null,
    executionMode: "native-parent",
    requestedEffort,
    effectiveEffort,
    effortSource: requestedEffort === "default" ? "route-default" : (override?.effort ? "override" : "lead-policy"),
  };
  return immutableSnapshot({
    status: "resolved",
    policyRevision,
    preset: policy.activePreset,
    role: "lead_engineer",
    executionSelectionMode: policy.executionSelectionMode,
    selectionSource: override?.model ? "override" : "lead-policy",
    selected,
    fallbacks: [],
    eligibleCandidates: [selected],
    rejectedCandidates: [],
  });
}

export function createEngineeringAssignmentSnapshot(resolution) {
  if (!plainObject(resolution) || resolution.status !== "resolved") {
    throw new TypeError("An assignment snapshot requires a resolved engineering assignment.");
  }
  const required = ["policyRevision", "preset", "role", "executionSelectionMode", "selectionSource", "selected"];
  for (const field of required) {
    if (resolution[field] === undefined) {
      throw new TypeError(`Resolved engineering assignment is missing ${field}.`);
    }
  }
  return immutableSnapshot({
    schemaVersion: ENGINEERING_POLICY_SCHEMA_VERSION,
    policyRevision: resolution.policyRevision,
    preset: resolution.preset,
    role: resolution.role,
    executionSelectionMode: resolution.executionSelectionMode,
    selectionSource: resolution.selectionSource,
    selected: resolution.selected,
    fallbacks: resolution.fallbacks || [],
    rejectedCandidates: resolution.rejectedCandidates || [],
    familyConstraint: resolution.familyConstraint,
  });
}
