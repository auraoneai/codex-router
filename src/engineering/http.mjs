import {
  engineeringControlSnapshot,
  engineeringUsageSnapshot,
  previewEngineeringAssignment,
  sanitizeEngineeringPolicy,
} from "./control-snapshot.mjs";
import { readEngineeringPolicyState, updateEngineeringPolicy } from "./policy-state.mjs";

const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8" });
const ACTIONS = new Set(["status", "policy", "usage", "preview", "on", "off", "patch"]);

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw httpError(400, "invalid_request", `${label} must be a JSON object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw httpError(400, "invalid_request", `${label} contains unsupported field ${key}.`);
  }
}

function pathAction(url) {
  let parsed;
  try {
    parsed = new URL(url, "http://127.0.0.1");
  } catch {
    throw httpError(400, "invalid_request", "Engineering control URL is invalid.");
  }
  if (parsed.search || parsed.hash) {
    throw httpError(400, "invalid_request", "Engineering control URLs cannot contain a query or fragment.");
  }
  const pathname = parsed.pathname;
  const match = pathname.match(/^\/(?:v1\/)?engineering(?:\/([^/]+))?\/?$/u);
  if (!match) throw httpError(404, "not_found", "Engineering control route was not found.");
  return { action: match[1] || "status", base: !match[1] };
}

export function parseEngineeringHttpRequest({ method, url, body } = {}) {
  const path = pathAction(url || "/engineering");
  let { action } = path;
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (path.base && normalizedMethod === "PATCH") action = "patch";
  if (!ACTIONS.has(action)) throw httpError(404, "not_found", "Engineering control route was not found.");
  const expectedMethod = action === "patch"
    ? "PATCH"
    : ["on", "off", "preview"].includes(action) ? "POST" : "GET";
  if (normalizedMethod !== expectedMethod) {
    const error = httpError(405, "method_not_allowed", `${action} requires ${expectedMethod}.`);
    error.allow = expectedMethod;
    throw error;
  }
  if (expectedMethod === "GET" && body !== undefined && body !== null && body !== "") {
    throw httpError(400, "invalid_request", "GET engineering control requests cannot include a body.");
  }
  let parsed = body;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      parsed = JSON.parse(String(body));
    } catch {
      throw httpError(400, "invalid_json", "Engineering control body must be valid JSON.");
    }
  }
  if (expectedMethod === "POST" && parsed === undefined) parsed = {};
  return Object.freeze({ action, method: normalizedMethod, body: parsed });
}

function toggleBody(body) {
  exactKeys(body, new Set(["expectedRevision"]), "Engineering toggle body");
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw httpError(400, "invalid_request", "expectedRevision must be a non-negative safe integer.");
  }
  return body;
}

function patchBody(body) {
  exactKeys(body, new Set(["expectedRevision", "enabled"]), "Engineering patch body");
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw httpError(400, "invalid_request", "expectedRevision must be a non-negative safe integer.");
  }
  if (typeof body.enabled !== "boolean") {
    throw httpError(400, "invalid_request", "enabled must be a boolean.");
  }
  return body;
}

function previewBody(body) {
  exactKeys(body, new Set([
    "role", "attemptOverride", "taskOverride", "authorBinding", "highRisk",
  ]), "Engineering preview body");
  if (typeof body.role !== "string" || !body.role) {
    throw httpError(400, "invalid_request", "role is required.");
  }
  if (body.highRisk !== undefined && typeof body.highRisk !== "boolean") {
    throw httpError(400, "invalid_request", "highRisk must be a boolean.");
  }
  return body;
}

/**
 * Execute one already-authenticated engineering control request. Authentication
 * and opaque execution-binding lookup stay with the Router integration; this
 * module owns only strict request parsing and policy CAS semantics.
 */
export function executeEngineeringControlAction(action, {
  body,
  stateOptions,
  usageEvents = [],
  configuredModels = [],
  offeredBindings = [],
  modelBySlug,
  listedModels,
  modelInventory,
} = {}) {
  const state = readEngineeringPolicyState(stateOptions);
  if (action === "status") return engineeringControlSnapshot({ state, usageEvents });
  if (action === "policy") {
    return sanitizeEngineeringPolicy({ ...state.policy, enabled: state.degraded ? false : state.policy.enabled });
  }
  if (action === "usage") return engineeringUsageSnapshot(usageEvents);
  if (action === "preview") {
    const request = previewBody(body);
    return previewEngineeringAssignment({
      ...request,
      state,
      configuredModels,
      offeredBindings,
      modelBySlug,
      listedModels,
      modelInventory,
    });
  }
  if (action === "on" || action === "off" || action === "patch") {
    const request = action === "patch" ? patchBody(body) : toggleBody(body);
    const enabled = action === "patch" ? request.enabled : action === "on";
    const next = updateEngineeringPolicy(
      (policy) => ({ ...policy, enabled }),
      { ...stateOptions, expectedRevision: request.expectedRevision },
    );
    return engineeringControlSnapshot({ state: next, usageEvents });
  }
  throw httpError(404, "not_found", "Engineering control action was not found.");
}

export function engineeringControlHttpResponse(request, options = {}) {
  try {
    const parsed = parseEngineeringHttpRequest(request);
    const result = executeEngineeringControlAction(parsed.action, {
      ...options,
      body: parsed.body,
    });
    return Object.freeze({ status: 200, headers: JSON_HEADERS, body: result });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = typeof error?.code === "string"
      ? error.code
      : status === 500 ? "engineering_control_failed" : "invalid_request";
    return Object.freeze({
      status,
      headers: Object.freeze({
        ...JSON_HEADERS,
        ...(error?.allow ? { allow: error.allow } : {}),
      }),
      body: Object.freeze({
        error: code,
        message: status === 500 ? "Engineering control request failed." : error.message,
        ...(Number.isSafeInteger(error?.expectedRevision)
          ? { expectedRevision: error.expectedRevision }
          : {}),
        ...(Number.isSafeInteger(error?.currentRevision)
          ? { currentRevision: error.currentRevision }
          : {}),
      }),
    });
  }
}
