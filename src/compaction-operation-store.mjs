import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const COMPACTION_POLICY_VERSION = "kcr2-singleflight-v1";
export const COMPACTION_OPERATION_STATES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed_retriable",
  "failed_terminal",
  "abandoned_or_expired",
]);

const DEFAULT_MAX_ENTRIES = 256;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function compactionOperationId({ owner, rootSession, sourceBoundary, model }) {
  return `cmpop_${digest({
    owner: String(owner || "local"),
    rootSession: String(rootSession || "unscoped"),
    sourceBoundary: String(sourceBoundary || ""),
    model: String(model || ""),
    policy: COMPACTION_POLICY_VERSION,
  })}`;
}

export function compactionSourceBoundary(input) {
  return digest(Array.isArray(input) ? input : []);
}

export class CompactionOperationStore {
  constructor({
    filePath = path.join(STATE_DIR, "compaction-operations.json"),
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = () => Date.now(),
  } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.operations = this.#read();
    this.#reconcileStale();
  }

  get(id, owner) {
    const operation = this.operations[id];
    if (!operation) return undefined;
    if (operation.owner !== owner) {
      const error = new Error("compaction operation belongs to a different owner");
      error.code = "compaction_operation_conflict";
      throw error;
    }
    return structuredClone(operation);
  }

  begin({ id, owner, rootSession, sourceBoundary, model, fallbackCheckpoint }) {
    const existing = this.get(id, owner);
    if (existing) {
      const operation = {
        ...existing,
        reuseCount: Number(existing.reuseCount || 0) + 1,
        duplicatePreventionCount:
          Number(existing.duplicatePreventionCount || 0) +
          (existing.state === "running" ? 1 : 0),
        reattachmentCount:
          Number(existing.reattachmentCount || 0) +
          (existing.state === "completed" && existing.checkpoint ? 1 : 0),
        lastReusedAt: this.now(),
        updatedAt: this.now(),
      };
      this.operations[id] = operation;
      this.#persist();
      return { created: false, operation: structuredClone(operation) };
    }
    const timestamp = this.now();
    const operation = {
      id,
      owner,
      rootSession,
      sourceBoundary,
      model,
      policyVersion: COMPACTION_POLICY_VERSION,
      state: "running",
      attemptCount: 1,
      reuseCount: 0,
      duplicatePreventionCount: 0,
      reattachmentCount: 0,
      fallbackCheckpoint,
      checkpoint: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations[id] = operation;
    this.#persist();
    return { created: true, operation: structuredClone(operation) };
  }

  complete(id, owner, checkpoint, { completedAfterDisconnect = false } = {}) {
    return this.#transition(id, owner, "completed", {
      checkpoint,
      completedAt: this.now(),
      completedAfterDisconnect: Boolean(completedAfterDisconnect),
    });
  }

  fail(id, owner, { terminal = false, failureCode = "compaction_transport_timeout" } = {}) {
    return this.#transition(
      id,
      owner,
      terminal ? "failed_terminal" : "failed_retriable",
      { failureCode },
    );
  }

  recordFallback(id, owner) {
    return this.#transition(id, owner, "failed_retriable", {
      fallbackDeliveredAt: this.now(),
    });
  }

  snapshot() {
    const operations = Object.values(this.operations);
    const states = Object.fromEntries(
      COMPACTION_OPERATION_STATES.map((state) => [
        state,
        operations.filter((operation) => operation.state === state).length,
      ]),
    );
    const recoveryLatencies = operations
      .map((operation) => {
        const finishedAt = operation.completedAt || operation.fallbackDeliveredAt;
        return Number.isFinite(finishedAt) && Number.isFinite(operation.createdAt)
          ? Math.max(0, finishedAt - operation.createdAt)
          : null;
      })
      .filter(Number.isFinite);
    const failuresByCode = {};
    for (const operation of operations) {
      if (!operation.failureCode) continue;
      failuresByCode[operation.failureCode] =
        Number(failuresByCode[operation.failureCode] || 0) + 1;
    }
    return {
      retainedOperations: operations.length,
      states,
      idempotentReuses: operations.reduce(
        (total, operation) => total + Number(operation.reuseCount || 0),
        0,
      ),
      concurrentDuplicatesPrevented: operations.reduce(
        (total, operation) => total + Number(operation.duplicatePreventionCount || 0),
        0,
      ),
      completedAfterDisconnect: operations.filter(
        (operation) => operation.completedAfterDisconnect === true,
      ).length,
      storedResults: operations.filter((operation) => operation.checkpoint).length,
      storedResultsReattached: operations.reduce(
        (total, operation) => total + Number(operation.reattachmentCount || 0),
        0,
      ),
      deterministicFallbacks: operations.filter(
        (operation) => Number.isFinite(operation.fallbackDeliveredAt),
      ).length,
      recoveryLatencyMs: {
        count: recoveryLatencies.length,
        max: recoveryLatencies.length ? Math.max(...recoveryLatencies) : null,
        average: recoveryLatencies.length
          ? Math.round(recoveryLatencies.reduce((sum, value) => sum + value, 0) / recoveryLatencies.length)
          : null,
      },
      failuresByCode,
    };
  }

  #transition(id, owner, state, changes) {
    const current = this.get(id, owner);
    if (!current) throw new Error(`unknown compaction operation: ${id}`);
    const operation = {
      ...current,
      ...changes,
      state,
      updatedAt: this.now(),
    };
    this.operations[id] = operation;
    this.#persist();
    return structuredClone(operation);
  }

  #read() {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  #reconcileStale() {
    let changed = false;
    for (const operation of Object.values(this.operations)) {
      // Construction happens only at router process start. In-process work is
      // held by the singleton, so any persisted `running` row necessarily
      // belongs to a process that no longer exists and cannot complete it.
      if (operation.state === "running") {
        operation.state = "failed_retriable";
        operation.failureCode = "compaction_transport_timeout";
        operation.updatedAt = this.now();
        changed = true;
      }
    }
    if (changed) this.#persist();
  }

  #persist() {
    const entries = Object.values(this.operations)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, this.maxEntries);
    this.operations = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.operations)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

export const compactionOperationStore = new CompactionOperationStore();
