import { immutableSnapshot } from "./contracts.mjs";
import { normalizeEngineeringFailure } from "./capacity.mjs";

export const DEEPSEEK_NON_MODAL_FALLBACK = "deepseek-non-modal-fallback";
export const DEFAULT_DEEPSEEK_RECOVERY_CHAIN = Object.freeze([
  "cloudflare-workers-ai/glm-5.3",
  "gpt-5.6-sol",
  "kiro-prism/claude-sonnet-5",
]);

function modelIdentity(candidate) {
  return [candidate?.model, candidate?.requestedSlug, candidate?.upstreamModel, candidate?.gatewayModel]
    .filter(Boolean).join(" ").toLowerCase();
}

export function isDeepSeekV41Flash(candidate) {
  return /(?:^|[/_\s-])deepseek-v4[._-]?1-flash(?:$|[/_\s-])/u.test(` ${modelIdentity(candidate)} `);
}

function family(candidate) {
  if (typeof candidate?.family === "string" && candidate.family) return candidate.family.toLowerCase();
  const identity = modelIdentity(candidate);
  if (identity.includes("deepseek")) return "deepseek";
  if (identity.includes("kimi")) return "kimi";
  if (identity.includes("glm")) return "glm";
  if (identity.includes("claude")) return "claude";
  if (identity.includes("gpt-5.6")) return "gpt-5.6";
  return `model:${identity}`;
}

function normalizedHost(candidate) {
  return String(candidate?.capacityHost || candidate?.provider || "").trim().toLowerCase();
}

function deeplyFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((nested) => deeplyFrozen(nested, seen));
}

function assignmentSequence(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Engineering fallback requires an assignment snapshot.");
  }
  if (!deeplyFrozen(snapshot)) {
    throw new TypeError("Engineering fallback requires an immutable assignment snapshot.");
  }
  if (!snapshot.selected || !Array.isArray(snapshot.fallbacks)) {
    throw new TypeError("Engineering assignment snapshot must contain selected and fallbacks.");
  }
  return [snapshot.selected, ...snapshot.fallbacks];
}

export function validateDeepSeekFallbackSnapshot(snapshot) {
  const assignments = assignmentSequence(snapshot);
  const errors = [];
  for (let index = 0; index < assignments.length; index += 1) {
    const candidate = assignments[index];
    if (!isDeepSeekV41Flash(candidate)) continue;
    if (candidate.capacityFailurePolicy !== DEEPSEEK_NON_MODAL_FALLBACK) {
      errors.push(`${candidate.model || `candidate ${index}`} is missing ${DEEPSEEK_NON_MODAL_FALLBACK}`);
      continue;
    }
    const recovery = assignments.slice(index + 1).find((later) => (
      !isDeepSeekV41Flash(later) && family(later) !== "kimi" && normalizedHost(later) !== "modal"
    ));
    if (!recovery) errors.push(`${candidate.model || `candidate ${index}`} has no later eligible non-Modal recovery route`);
  }
  if (errors.length) {
    const error = new Error(`Invalid DeepSeek recovery snapshot:\n- ${errors.join("\n- ")}`);
    error.code = "invalid_deepseek_recovery_snapshot";
    error.errors = Object.freeze(errors);
    throw error;
  }
  return true;
}

function currentIndex(assignments, current) {
  const model = typeof current === "string" ? current : current?.model;
  if (!model) return 0;
  const index = assignments.findIndex((candidate) => candidate.model === model);
  if (index < 0) throw new Error(`Current model ${JSON.stringify(model)} is not present in the immutable assignment snapshot.`);
  return index;
}

function rejectReason(candidate, current, normalized, snapshot, circuits, at) {
  if (candidate.disabled === true) return "disabled";
  const currentFamily = family(current);
  const candidateFamily = family(candidate);
  const currentHost = normalizedHost(current);
  const candidateHost = normalizedHost(candidate);
  if (snapshot.familyConstraint?.differentFrom === candidateFamily) return "violates reviewer family constraint";
  if (normalized.failureClass === "MODEL_QUALITY_FAILURE" && candidateFamily === currentFamily) {
    return "quality remediation requires a different model family";
  }
  if (["AUTH", "ENTITLEMENT", "BUDGET_EXHAUSTED"].includes(normalized.failureClass) && candidate.provider === current.provider) {
    return "shares the failed provider credential or entitlement";
  }
  if (isDeepSeekV41Flash(current) && normalized.capacityFailure) {
    if (candidateFamily === "deepseek") return "DeepSeek recovery must leave the saturated family";
    if (candidateFamily === "kimi") return "Kimi is excluded from default DeepSeek recovery";
    if (candidateHost === "modal") return "DeepSeek recovery must leave the Modal capacity host";
  } else if (normalized.capacityFailure && currentHost && candidateHost === currentHost) {
    return "shares the failed capacity host";
  }
  if (circuits) {
    const availability = circuits.peek({ route: candidate.model, host: candidate.capacityHost, at });
    if (!availability.available) return availability.reason;
  }
  return undefined;
}

export function selectEngineeringFallback({
  snapshot,
  current,
  failure,
  failureContext,
  circuits,
  taskId,
  at = Date.now(),
} = {}) {
  validateDeepSeekFallbackSnapshot(snapshot);
  const assignments = assignmentSequence(snapshot);
  const index = currentIndex(assignments, current);
  const active = assignments[index];
  const normalized = failure?.failureClass
    ? immutableSnapshot(failure)
    : normalizeEngineeringFailure(failure, { ...(failureContext || {}), now: at });
  if (!normalized.maySwitchRoute) {
    return immutableSnapshot({
      status: "blocked",
      reason: normalized.requiresReconciliation ? "reconciliation_required" : "switch_not_permitted",
      failure: normalized,
      rejectedCandidates: [],
    });
  }
  const rejectedCandidates = [];
  for (const candidate of assignments.slice(index + 1)) {
    const reason = rejectReason(candidate, active, normalized, snapshot, circuits, at);
    if (reason) {
      rejectedCandidates.push({ model: candidate.model, reason });
      continue;
    }
    if (circuits) {
      const acquired = circuits.acquire({ route: candidate.model, host: candidate.capacityHost, taskId, at });
      if (!acquired.allowed) {
        rejectedCandidates.push({ model: candidate.model, reason: acquired.reason });
        continue;
      }
      return immutableSnapshot({
        status: "selected",
        selected: candidate,
        failure: normalized,
        circuitProbe: acquired.probe,
        rejectedCandidates,
      });
    }
    return immutableSnapshot({ status: "selected", selected: candidate, failure: normalized, circuitProbe: false, rejectedCandidates });
  }
  return immutableSnapshot({ status: "exhausted", failure: normalized, rejectedCandidates });
}
