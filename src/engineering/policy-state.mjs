import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { withAtomicStateLock } from "../atomic-state-lock.mjs";
import { privateFileIsProtected, writePrivateJson } from "../file-security.mjs";
import { SOURCE_ROOT, STATE_DIR } from "../paths.mjs";
import { assertStateOwnership } from "../state-owner.mjs";
import { immutableSnapshot } from "./contracts.mjs";
import { validateEngineeringPolicy } from "./policy.mjs";

export const ENGINEERING_POLICY_STATE_VERSION = 1;
export const ENGINEERING_POLICY_DEFAULTS_PATH = path.join(
  SOURCE_ROOT,
  "config",
  "engineering-policy.defaults.json",
);

export function engineeringPolicyStatePath(stateDir = STATE_DIR) {
  return path.join(stateDir, "engineering-policy.json");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readEngineeringPolicyDefaults(
  defaultsPath = ENGINEERING_POLICY_DEFAULTS_PATH,
  registry,
) {
  const policy = validateEngineeringPolicy(readJson(defaultsPath, "Engineering policy defaults"), registry);
  if (policy.enabled !== false) {
    throw new Error("Checked-in engineering policy defaults must be disabled.");
  }
  return policy;
}

function parseStateDocument(payload, registry) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Engineering policy state must be an object.");
  }
  const allowed = new Set(["version", "revision", "updatedAt", "policy"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`Engineering policy state contains unsupported field ${key}.`);
  }
  if (payload.version !== ENGINEERING_POLICY_STATE_VERSION) {
    throw new Error(`Engineering policy state version must be ${ENGINEERING_POLICY_STATE_VERSION}.`);
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) {
    throw new Error("Engineering policy state revision must be a positive safe integer.");
  }
  if (typeof payload.updatedAt !== "string" || !Number.isFinite(Date.parse(payload.updatedAt))) {
    throw new Error("Engineering policy state updatedAt must be an ISO timestamp.");
  }
  return immutableSnapshot({
    version: ENGINEERING_POLICY_STATE_VERSION,
    revision: payload.revision,
    updatedAt: payload.updatedAt,
    policy: validateEngineeringPolicy(payload.policy, registry),
  });
}

function readStrict({ stateDir, defaultsPath, registry }) {
  const filePath = engineeringPolicyStatePath(stateDir);
  if (!existsSync(filePath)) {
    return immutableSnapshot({
      version: ENGINEERING_POLICY_STATE_VERSION,
      revision: 0,
      updatedAt: null,
      policy: readEngineeringPolicyDefaults(defaultsPath, registry),
    });
  }
  if (!privateFileIsProtected(filePath)) {
    throw new Error(`Engineering policy state is not owner-only: ${filePath}`);
  }
  return parseStateDocument(readJson(filePath, "Engineering policy state"), registry);
}

export function readEngineeringPolicyState({
  stateDir = STATE_DIR,
  defaultsPath = ENGINEERING_POLICY_DEFAULTS_PATH,
  registry,
} = {}) {
  try {
    const state = readStrict({ stateDir, defaultsPath, registry });
    return immutableSnapshot({
      status: state.revision === 0 ? "default" : "ok",
      degraded: false,
      enabled: state.policy.enabled,
      path: engineeringPolicyStatePath(stateDir),
      ...state,
    });
  } catch (error) {
    let defaults;
    try {
      defaults = readEngineeringPolicyDefaults(defaultsPath, registry);
    } catch {
      defaults = immutableSnapshot({
        schemaVersion: 1,
        enabled: false,
        activePreset: "unavailable",
        enabledOptionalModels: [],
        operatorModelDefaults: {},
        workspace: { roles: {} },
        presets: {},
      });
    }
    return immutableSnapshot({
      status: "degraded",
      degraded: true,
      enabled: false,
      version: ENGINEERING_POLICY_STATE_VERSION,
      revision: null,
      updatedAt: null,
      path: engineeringPolicyStatePath(stateDir),
      error: error instanceof Error ? error.message : String(error),
      policy: immutableSnapshot({ ...defaults, enabled: false }),
    });
  }
}

function revisionConflict(expectedRevision, currentRevision) {
  const error = new Error(
    `Engineering policy revision conflict: expected ${expectedRevision}, current ${currentRevision}.`,
  );
  error.code = "revision_conflict";
  error.status = 409;
  error.expectedRevision = expectedRevision;
  error.currentRevision = currentRevision;
  return error;
}

export function updateEngineeringPolicy(
  transform,
  {
    expectedRevision,
    stateDir = STATE_DIR,
    defaultsPath = ENGINEERING_POLICY_DEFAULTS_PATH,
    registry,
    now = () => new Date(),
    waitMs,
  } = {},
) {
  if (typeof transform !== "function") throw new TypeError("Engineering policy transform must be a function.");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer.");
  }
  if (stateDir === STATE_DIR) assertStateOwnership("update engineering policy");
  const filePath = engineeringPolicyStatePath(stateDir);
  return withAtomicStateLock(filePath, () => {
    const current = readStrict({ stateDir, defaultsPath, registry });
    if (current.revision !== expectedRevision) {
      throw revisionConflict(expectedRevision, current.revision);
    }
    const candidate = transform(immutableSnapshot(current.policy));
    if (candidate && typeof candidate.then === "function") {
      throw new TypeError("Engineering policy transforms must be synchronous.");
    }
    const policy = validateEngineeringPolicy(candidate, registry);
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Engineering policy clock returned an invalid date.");
    }
    const next = immutableSnapshot({
      version: ENGINEERING_POLICY_STATE_VERSION,
      revision: current.revision + 1,
      updatedAt: timestamp.toISOString(),
      policy,
    });
    writePrivateJson(filePath, next, { directoryMode: 0o700 });
    return immutableSnapshot({
      status: "ok",
      degraded: false,
      enabled: policy.enabled,
      path: filePath,
      ...next,
    });
  }, { waitMs });
}

export function replaceEngineeringPolicy(policy, options) {
  return updateEngineeringPolicy(() => policy, options);
}
