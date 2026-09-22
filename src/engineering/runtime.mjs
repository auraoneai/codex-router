import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { withAtomicStateLock } from "../atomic-state-lock.mjs";
import { routedAgentDefinition } from "../codex-agent-catalog.mjs";
import { privateFileIsProtected, writePrivateJson } from "../file-security.mjs";
import { MODEL_BY_SLUG, providerForModel } from "../model-registry.mjs";
import { STATE_DIR } from "../paths.mjs";
import { credentialStatus, resolveProviderCredential } from "../provider-credentials.mjs";
import { EngineeringCapacityCircuits, normalizeEngineeringFailure } from "./capacity.mjs";
import { immutableSnapshot } from "./contracts.mjs";
import {
  CodexAppServerClient,
  CodexAppServerExecutor,
  StdioAppServerTransport,
} from "./codex-executor.mjs";
import { createExecutionBinding } from "./execution-binding.mjs";
import { selectEngineeringFallback } from "./fallback.mjs";
import { readEngineeringPolicyState } from "./policy-state.mjs";
import { resolveEngineeringAssignment } from "./policy.mjs";
import { PrismDecisionsClient } from "./prism-decisions.mjs";
import { EngineeringRunController } from "./run-controller.mjs";
import {
  createDurableSchedulerState,
  engineeringSchedulerStatePath,
} from "./scheduler-state-adapter.mjs";
import { EngineeringScheduler } from "./scheduler.mjs";
import { compileStrategyGraph } from "./strategies.mjs";
import { DeterministicVerificationRunner } from "./verification.mjs";
import { EngineeringWorktrees } from "./worktrees.mjs";

const WORKTREE_STATE_VERSION = 1;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyWorktreeStore() {
  return { version: WORKTREE_STATE_VERSION, revision: 0, records: {} };
}

function validateWorktreeStore(value) {
  if (!plainObject(value) || value.version !== WORKTREE_STATE_VERSION) {
    throw new Error("Engineering worktree state is malformed or unsupported.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !plainObject(value.records)) {
    throw new Error("Engineering worktree state has invalid revision metadata.");
  }
  return value;
}

/** Durable, owner-only state for managed worktrees. */
class DurableWorktreeState {
  constructor(target) {
    this.target = requiredText(target, "Engineering worktree state path");
  }

  #read() {
    if (!existsSync(this.target)) return emptyWorktreeStore();
    const metadata = lstatSync(this.target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !privateFileIsProtected(this.target)) {
      throw new Error(`Engineering worktree state is not an owner-only regular file: ${this.target}`);
    }
    try {
      return validateWorktreeStore(JSON.parse(readFileSync(this.target, "utf8")));
    } catch (error) {
      throw new Error(`Engineering worktree state could not be read: ${this.target}`, { cause: error });
    }
  }

  #mutate(operation) {
    return withAtomicStateLock(this.target, () => {
      const store = this.#read();
      const next = copy(store);
      const result = operation(next);
      next.revision += 1;
      writePrivateJson(this.target, validateWorktreeStore(next), { space: 2, directoryMode: 0o700 });
      return copy(result);
    });
  }

  async putWorktree(record, { expectedRevision } = {}) {
    if (!plainObject(record) || typeof record.worktreeId !== "string" || !record.worktreeId) {
      throw new TypeError("A worktree record with worktreeId is required.");
    }
    return this.#mutate((store) => {
      const current = store.records[record.worktreeId];
      const revision = current?.stateRevision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new Error(`Worktree ${record.worktreeId} revision conflict: expected ${expectedRevision}, found ${revision}.`);
      }
      const next = { ...copy(record), stateRevision: revision + 1 };
      store.records[record.worktreeId] = next;
      return next;
    });
  }

  async getWorktree(worktreeId) {
    return copy(this.#read().records[worktreeId]);
  }

  async deleteWorktree(worktreeId, { expectedRevision } = {}) {
    return this.#mutate((store) => {
      const current = store.records[worktreeId];
      if (expectedRevision !== undefined && current?.stateRevision !== expectedRevision) {
        throw new Error(`Worktree ${worktreeId} revision conflict during deletion.`);
      }
      delete store.records[worktreeId];
      return current !== undefined;
    });
  }

  async listWorktrees() {
    return Object.values(this.#read().records).map(copy);
  }
}

function defaultRouteAvailability(route) {
  const model = MODEL_BY_SLUG.get(route);
  if (!model || model.slug !== route || model.hidden === true || model.listed === false) {
    return { available: false, reason: "route is not an exact listed model" };
  }
  const provider = providerForModel(model);
  if (!provider) return { available: false, reason: "route provider is unavailable" };
  try {
    const status = credentialStatus(provider, { persistent: true });
    return status.configured
      ? { available: true, provider: provider.id }
      : { available: false, provider: provider.id, reason: "provider credential is unavailable" };
  } catch (error) {
    return { available: false, provider: provider.id, reason: String(error?.message || error) };
  }
}

function requiredRoutes(request) {
  const result = new Set();
  for (const route of request.requiredRoutes || []) result.add(requiredText(route, "required route"));
  for (const task of request.tasks || []) {
    const route = task?.route ?? task?.model ?? task?.executionBinding?.model;
    if (typeof route === "string" && route) result.add(route);
  }
  return [...result];
}

function workflowGraphFromRequest(request) {
  if (plainObject(request.graph)) return request.graph;
  if (plainObject(request.workflowGraph)) return request.workflowGraph;
  if (typeof request.strategy !== "string" || !request.strategy) return undefined;
  const tasks = Array.isArray(request.tasks) ? request.tasks : [];
  const input = {
    ...copy(request),
    ...(request.strategy === "single" ? { task: request.task || tasks[0] } : {}),
    ...(request.strategy === "swarm" ? { slices: request.slices || tasks } : {}),
    ...(request.strategy === "pipeline" ? { stages: request.stages || tasks } : {}),
  };
  if (request.strategy === "single" && tasks.length > 1 && request.task === undefined) {
    throw new Error("Single strategy accepts exactly one task.");
  }
  return compileStrategyGraph(input);
}

function normalizeAvailability(value) {
  if (value === true) return { available: true };
  if (value === false || value === undefined || value === null) return { available: false };
  if (!plainObject(value) || typeof value.available !== "boolean") {
    throw new TypeError("routeAvailability must return a boolean or { available, reason }.");
  }
  return value;
}

function createAssistedAstraAdapter(defaultCallbacks, activeCallbacks) {
  const callback = (task) => activeCallbacks.get(task?.runId) || defaultCallbacks;
  return {
    async decide(input) {
      const handler = callback(input.task)?.decide;
      if (typeof handler !== "function") {
        throw new Error("Assisted Astra lead callback is unavailable for this run.");
      }
      return handler(copy(input));
    },
    async inspect(input) {
      const handler = callback(input.task)?.inspect;
      if (typeof handler !== "function") {
        return { state: "missing", reason: "assisted Astra callback must be reattached to resume this lead operation" };
      }
      return handler(copy(input));
    },
  };
}

async function instantiateGraphExecutor(moduleLoader, factoryOverride, dependencies) {
  if (typeof factoryOverride === "function") return factoryOverride(dependencies);
  let module;
  try {
    module = await moduleLoader();
  } catch (error) {
    throw new Error("Engineering graph executor is unavailable; production orchestration cannot start.", { cause: error });
  }
  const factory = module.createEngineeringGraphExecutor ?? module.createGraphExecutor;
  if (typeof factory === "function") return factory(dependencies);
  const Constructor = module.EngineeringGraphExecutor ?? module.GraphExecutor;
  if (typeof Constructor === "function") return new Constructor(dependencies);
  throw new Error("Engineering graph executor module exposes no supported production factory.");
}

function policyRouteSlugs(policy) {
  const preset = policy.presets?.[policy.activePreset]?.roles || {};
  const workspace = policy.workspace?.roles || {};
  const candidates = [
    ...Object.values(preset),
    ...Object.values(workspace),
    { candidates: policy.deepSeekRecovery || [] },
  ].flatMap((role) => [...(role?.candidates || []), ...(role?.optionalCandidates || [])]);
  return [...new Set(candidates.map((candidate) => candidate?.model).filter(Boolean))];
}

function roleForNode(node) {
  if (node.task?.role) return node.task.role;
  return {
    work: "general_coder",
    integrate: "integrator",
    review: "reviewer",
    judge: "reviewer",
    synthesize: "synthesizer",
    dedupe: "synthesizer",
    remediate: "debugger",
  }[node.kind];
}

function terminalTask(state) {
  return ["result_recorded", "accepted", "cancelled", "failed", "blocked", "needs_remediation"].includes(state);
}

function latestPassingOutcome(outcomes) {
  return Object.values(outcomes || {}).filter((outcome) => outcome?.status === "passed" && outcome.resultRevision)
    .sort((left, right) => (right.finishedAtMs || 0) - (left.finishedAtMs || 0))[0];
}

function nodeOwnedPaths(node, outcomes) {
  const explicit = node.ownedPaths || node.task?.ownedPaths || node.task?.writableScopes;
  if (Array.isArray(explicit) && explicit.length) return [...new Set(explicit)];
  if (node.readOnly === true || ["review", "judge", "synthesize", "dedupe"].includes(node.kind)) return [];
  if (node.kind === "integrate" || node.kind === "remediate") {
    return [...new Set(Object.values(outcomes || {}).flatMap((outcome) => outcome?.ownedPaths || []))];
  }
  throw new Error(`Graph node ${node.id} has no explicit writable ownership scope.`);
}

function nodePrompt(node, outcomes) {
  const direct = node.task?.prompt || node.task?.objective;
  if (typeof direct === "string" && direct.trim()) return direct;
  const predecessorSummary = Object.values(outcomes || {}).map((outcome) => ({
    nodeId: outcome.nodeId,
    status: outcome.status,
    resultRevision: outcome.resultRevision,
    summary: outcome.summary,
  }));
  return [
    `Execute engineering graph node ${node.id} (${node.kind}).`,
    "Return a committed, clean worktree result. Respect the assigned writable paths.",
    `Node: ${JSON.stringify(node)}`,
    `Prior outcomes: ${JSON.stringify(predecessorSummary)}`,
  ].join("\n\n");
}

function leaseToken(binding) {
  const leases = (binding.leases || []).map((lease) => `${lease.scope}:${lease.fence}`).sort();
  return leases.length ? leases.join("|") : `read-only:${binding.attemptId}`;
}

function safeFailureMessage(error) {
  return String(error?.message || error || "engineering dispatch failed").slice(0, 2_048);
}

function dispatchFailureContext(error) {
  return {
    ...(error?.failureContext && plainObject(error.failureContext) ? error.failureContext : {}),
    ...(error?.status !== undefined ? { status: error.status } : {}),
    ...(error?.dispatched !== undefined ? { dispatched: error.dispatched } : {}),
    ...(error?.dispatchState !== undefined ? { dispatchState: error.dispatchState } : {}),
    ...(error?.outputState !== undefined ? { outputState: error.outputState } : {}),
    ...(error?.outputBytes !== undefined ? { outputBytes: error.outputBytes } : {}),
    ...(error?.toolActionState !== undefined ? { toolActionState: error.toolActionState } : {}),
    ...(error?.ambiguousToolAction !== undefined ? { ambiguousToolAction: error.ambiguousToolAction } : {}),
  };
}

function fallbackAttemptId(attemptId, ordinal) {
  return ordinal === 1 ? attemptId : `${attemptId}-route-${ordinal}`;
}

function createBoundCodexRuntime({
  state,
  executor,
  worktrees,
  policyStateForRun,
  routeAvailability,
  circuits,
  now,
  dispatchDeadlineMs,
}) {
  return {
    async dispatch({ task, binding }) {
      const policyState = policyStateForRun.get(task.runId);
      if (!policyState) {
        const error = new Error(`No active policy snapshot exists for engineering run ${task.runId}.`);
        error.dispatched = false;
        throw error;
      }
      if (!task.assignment || !task.role) {
        const error = new Error(`Engineering task ${task.taskId} has no resolved assignment.`);
        error.dispatched = false;
        throw error;
      }
      const worktree = await worktrees.create({
        runId: task.runId,
        taskId: task.taskId,
        attemptId: binding.attemptId,
        baseRevision: task.baseRevision || "HEAD",
        ownedPaths: task.ownedPaths || task.writableScopes,
        ownershipToken: binding.attemptId,
        fence: Math.max(1, ...(binding.leases || []).map((lease) => Number(lease.fence) || 1)),
      });
      const resolutionSnapshot = immutableSnapshot(task.assignmentSnapshot || {
        selected: task.assignment,
        fallbacks: [],
      });
      const deadlineAt = now() + (task.dispatchDeadlineMs || task.deadlineMs || dispatchDeadlineMs);
      let assignment = resolutionSnapshot.selected;
      let assignmentCircuitAcquired = false;
      let routeOrdinal = 0;

      while (assignment) {
        routeOrdinal += 1;
        if (now() >= deadlineAt) {
          const error = new Error(`Engineering dispatch deadline exceeded before route ${assignment.model}.`);
          error.dispatched = false;
          throw error;
        }
        if (!assignmentCircuitAcquired) {
          const acquired = circuits.acquire({
            route: assignment.model,
            host: assignment.capacityHost,
            taskId: task.taskId,
            at: now(),
          });
          if (!acquired.allowed) {
            const unavailable = new Error(`route circuit is unavailable: ${acquired.reason}`);
            unavailable.status = 503;
            unavailable.dispatched = false;
            const failure = normalizeEngineeringFailure(unavailable, { dispatched: false, status: 503, now: now() });
            const current = await state.getTask(task.taskId);
            await state.putTask({
              ...current,
              assignmentSnapshot: resolutionSnapshot,
              routeRejections: [...(current.routeRejections || []), immutableSnapshot({
                model: assignment.model,
                atMs: now(),
                reason: unavailable.message,
                failure,
              })],
            }, { expectedRevision: current.revision });
            const selected = selectEngineeringFallback({
              snapshot: resolutionSnapshot,
              current: assignment,
              failure,
              circuits,
              taskId: task.taskId,
              at: now(),
            });
            if (selected.status !== "selected") throw unavailable;
            assignment = selected.selected;
            assignmentCircuitAcquired = true;
            continue;
          }
          assignmentCircuitAcquired = true;
        }
        const availability = normalizeAvailability(await routeAvailability(assignment.model));
        if (!availability.available) {
          const unavailable = new Error(availability.reason || `route ${assignment.model} is unavailable`);
          unavailable.status = 503;
          unavailable.dispatched = false;
          const failure = normalizeEngineeringFailure(unavailable, { dispatched: false, status: 503, now: now() });
          let current = await state.getTask(task.taskId);
          current = await state.putTask({
            ...current,
            assignmentSnapshot: resolutionSnapshot,
            routeRejections: [...(current.routeRejections || []), immutableSnapshot({
              model: assignment.model,
              atMs: now(),
              reason: unavailable.message,
              failure,
            })],
          }, { expectedRevision: current.revision });
          circuits.recordFailure({
            route: assignment.model,
            host: assignment.capacityHost,
            taskId: task.taskId,
            failure,
            at: now(),
            forceOpen: true,
          });
          const selected = selectEngineeringFallback({
            snapshot: resolutionSnapshot,
            current: assignment,
            failure,
            circuits,
            taskId: task.taskId,
            at: now(),
          });
          if (selected.status !== "selected") {
            unavailable.dispatched = false;
            throw unavailable;
          }
          assignment = selected.selected;
          assignmentCircuitAcquired = true;
          continue;
        }

        const attemptId = fallbackAttemptId(binding.attemptId, routeOrdinal);
        const executionBinding = createExecutionBinding({
          runId: task.runId,
          taskId: task.taskId,
          attemptId,
          dispatchOperationId: routeOrdinal === 1 ? binding.operationId : `${binding.operationId}-route-${routeOrdinal}`,
          assignment,
          role: task.role,
          preset: policyState.policy.activePreset,
          policyRevision: policyState.revision,
          attempt: binding.attempt,
          worktree: worktree.path,
          branch: `detached-${worktree.baseOid.slice(0, 12)}`,
          leaseToken: leaseToken(binding),
        });
        // Every route switch gets a new immutable execution binding. The
        // append-only attempt evidence is committed before the app-server call,
        // while the original resolution snapshot remains unchanged.
        let current = await state.getTask(task.taskId);
        const attemptRecord = immutableSnapshot({
          ordinal: routeOrdinal,
          state: "dispatching",
          assignment,
          executionBinding,
          startedAtMs: now(),
        });
        let persisted = await state.putTask({
          ...current,
          assignment,
          assignmentSnapshot: resolutionSnapshot,
          executionBinding,
          worktree,
          executionAttempts: [...(current.executionAttempts || []), attemptRecord],
        }, { expectedRevision: current.revision });
        try {
          const receipt = await executor.dispatch({
            task: { ...persisted, executionBinding },
            binding: { ...persisted.activeBinding, executionBinding },
          });
          current = await state.getTask(task.taskId);
          const attempts = [...(current.executionAttempts || [])];
          attempts[attempts.length - 1] = immutableSnapshot({
            ...attempts.at(-1),
            state: "dispatched",
            dispatchedAtMs: now(),
            receipt: {
              state: receipt?.state || "assigned",
              childId: receipt?.childId || null,
              threadId: receipt?.threadId || null,
              turnId: receipt?.turnId || null,
            },
          });
          await state.putTask({ ...current, executionAttempts: attempts }, {
            expectedRevision: current.revision,
          });
          circuits.recordSuccess({
            route: assignment.model,
            host: assignment.capacityHost,
            taskId: task.taskId,
            at: now(),
          });
          return { ...receipt, executionBinding, worktree };
        } catch (error) {
          const failure = normalizeEngineeringFailure(error, {
            ...dispatchFailureContext(error),
            now: now(),
          });
          current = await state.getTask(task.taskId);
          const attempts = [...(current.executionAttempts || [])];
          attempts[attempts.length - 1] = immutableSnapshot({
            ...attempts.at(-1),
            state: "failed",
            failedAtMs: now(),
            failure,
            message: safeFailureMessage(error),
          });
          persisted = await state.putTask({ ...current, executionAttempts: attempts }, {
            expectedRevision: current.revision,
          });
          circuits.recordFailure({
            route: assignment.model,
            host: assignment.capacityHost,
            taskId: task.taskId,
            failure,
            at: now(),
            forceOpen: failure.failureClass === "RATE_LIMIT",
          });
          // Runtime route switching is limited to confirmed capacity failures.
          // Ambiguous dispatches, output/tool side effects, authentication, and
          // protocol/schema failures remain bound to the original attempt.
          if (!failure.capacityFailure || !failure.maySwitchRoute || now() >= deadlineAt) throw error;
          const selected = selectEngineeringFallback({
            snapshot: resolutionSnapshot,
            current: assignment,
            failure,
            circuits,
            taskId: task.taskId,
            at: now(),
          });
          if (selected.status !== "selected") {
            const exhausted = new Error(`Engineering fallback exhausted after ${assignment.model}: ${safeFailureMessage(error)}`, { cause: error });
            exhausted.dispatched = false;
            exhausted.failure = failure;
            throw exhausted;
          }
          assignment = selected.selected;
          assignmentCircuitAcquired = true;
        }
      }
      const exhausted = new Error("Engineering fallback snapshot contained no dispatchable assignment.");
      exhausted.dispatched = false;
      throw exhausted;
    },

    async inspect({ task, binding }) {
      const observation = await executor.inspect({ task, binding });
      if (observation?.state !== "result") return observation;
      const receipt = binding.dispatchReceipt || {};
      const worktree = receipt.worktree || task.worktree;
      if (!worktree?.worktreeId) return { state: "failed", reason: "worker result has no durable worktree identity" };
      const inspected = await worktrees.inspect(worktree.worktreeId);
      if (inspected.dirty) {
        return { state: "failed", reason: "worker ended with an uncommitted dirty worktree" };
      }
      const recorded = await worktrees.recordResult(worktree.worktreeId, {
        ownershipToken: binding.attemptId,
        fence: worktree.fence,
        resultCommit: inspected.headOid,
        reconciled: true,
      });
      return {
        state: "result",
        result: {
          ...observation.result,
          resultRevision: inspected.headOid,
          sourceRevision: inspected.headOid,
          worktreeId: recorded.worktreeId,
          worktreePath: recorded.path,
          ownedPaths: recorded.ownedPaths.map((entry) => entry.path),
        },
      };
    },

    cancel(input) {
      return executor.cancel(input);
    },
  };
}

/**
 * Compose the production engineering runtime. Durable state and artifact roots
 * are mandatory defaults; process-local scheduler/worktree fixtures are never
 * used here.
 */
export function createEngineeringRuntime({
  stateDir = STATE_DIR,
  repoRoot = process.cwd(),
  statePath = engineeringSchedulerStatePath(stateDir),
  worktreeStatePath = path.join(stateDir, "engineering-worktrees.json"),
  artifactRoot = path.join(stateDir, "engineering", "artifacts"),
  worktreeRoot = path.join(stateDir, "engineering", "worktrees"),
  policyReader = readEngineeringPolicyState,
  policyRegistry,
  routeAvailability = defaultRouteAvailability,
  capacity,
  capacityCircuits,
  dispatchDeadlineMs = 30 * 60 * 1_000,
  monotonicNow = Date.now,
  clock,
  idFactory,
  controllerId = "codex-router-engineering-runtime",
  appServerTransport,
  appServerClient,
  appServerExecutor,
  verifier,
  worktreeState,
  worktrees,
  prismClient,
  prismApiKey,
  prismOptions,
  assistedAstra,
  integrator,
  reviewer,
  notifier,
  nodeAdapter,
  graphExecutorFactory,
  graphModuleLoader = () => import("./graph-executor.mjs"),
} = {}) {
  if (typeof policyReader !== "function") throw new TypeError("policyReader must be a function.");
  if (typeof routeAvailability !== "function") throw new TypeError("routeAvailability must be a function.");
  if (!Number.isSafeInteger(dispatchDeadlineMs) || dispatchDeadlineMs <= 0) {
    throw new TypeError("dispatchDeadlineMs must be a positive safe integer.");
  }
  if (typeof monotonicNow !== "function") throw new TypeError("monotonicNow must be a function.");

  const state = createDurableSchedulerState(statePath, { ...(clock ? { clock } : {}) });
  const transport = appServerTransport || (!appServerClient && !appServerExecutor ? new StdioAppServerTransport() : undefined);
  const client = appServerClient || (!appServerExecutor ? new CodexAppServerClient({ transport }) : undefined);
  const executor = appServerExecutor || new CodexAppServerExecutor({ client });
  const verification = verifier || new DeterministicVerificationRunner({
    artifactRoot,
    ...(clock ? { clock: () => new Date(clock()) } : {}),
  });
  const durableWorktreeState = worktreeState || new DurableWorktreeState(worktreeStatePath);
  const worktreeManager = worktrees || new EngineeringWorktrees({
    repoRoot,
    safeRoot: worktreeRoot,
    state: durableWorktreeState,
  });
  const credential = prismApiKey
    ? { value: prismApiKey }
    : (prismClient ? undefined : resolveProviderCredential("kiro-prism", { persistent: true }));
  const decisions = prismClient || (credential?.value
    ? new PrismDecisionsClient({ apiKey: credential.value, ...(prismOptions || {}) })
    : undefined);
  const policyStateForRun = new Map();
  const fallbackCircuits = capacityCircuits || new EngineeringCapacityCircuits({ now: monotonicNow });
  const dispatchRuntime = createBoundCodexRuntime({
    state,
    executor,
    worktrees: worktreeManager,
    policyStateForRun,
    routeAvailability,
    circuits: fallbackCircuits,
    now: monotonicNow,
    dispatchDeadlineMs,
  });
  const scheduler = new EngineeringScheduler({
    state,
    runtime: dispatchRuntime,
    ...(capacity ? { capacity } : {}),
    ...(clock ? { clock } : {}),
    ...(idFactory ? { idFactory } : {}),
  });
  const activeAstraCallbacks = new Map();
  const astraLead = createAssistedAstraAdapter(assistedAstra, activeAstraCallbacks);
  const controller = new EngineeringRunController({
    scheduler,
    state,
    verifier: verification,
    astraLead,
    controllerId,
    ...(integrator ? { integrator } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(notifier ? { notifier } : {}),
    ...(clock ? { clock } : {}),
    ...(idFactory ? { idFactory } : {}),
  });

  async function resolvedAssignment(policyState, role, task = {}, runId, nodeId) {
    const configuredModels = [];
    const offeredBindings = [];
    for (const route of policyRouteSlugs(policyState.policy)) {
      const availability = normalizeAvailability(await routeAvailability(route));
      if (!availability.available) continue;
      const model = MODEL_BY_SLUG.get(route);
      if (!model || model.slug !== route) continue;
      const agent = routedAgentDefinition(model);
      configuredModels.push(route);
      offeredBindings.push({
        agentType: agent.agentName,
        model: route,
        eligible: true,
        healthy: true,
        capacityHost: availability.capacityHost || availability.provider || model.provider,
      });
    }
    const taskOverride = (task.model || task.effort)
      ? { ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) }
      : undefined;
    const resolution = resolveEngineeringAssignment({
      policy: policyState.policy,
      policyRevision: policyState.revision,
      role,
      taskOverride,
      highRisk: task.highRisk === true,
      configuredModels,
      offeredBindings,
    });
    if (resolution.status !== "resolved") {
      throw new Error(`No available engineering route for ${role}: ${(resolution.rejectedCandidates || []).map((item) => `${item.model}: ${item.reason}`).join("; ")}`);
    }
    const eligible = [resolution.selected, ...(resolution.fallbacks || [])];
    if (policyState.policy.executionSelectionMode !== "adaptive" || eligible.length === 1) return resolution;
    const choice = await decisions.decide({
      request_id: `route-${randomUUID()}`,
      state: {
        runId,
        nodeId,
        role,
        objective: String(task.objective || task.prompt || "").slice(0, 8_000),
        candidates: eligible.map(({ model, effectiveEffort, family }) => ({ model, effectiveEffort, family })),
      },
      questions: {
        route: {
          type: "choice",
          question: "Which eligible route is best for this engineering node?",
          options: eligible.map((assignment) => assignment.model),
        },
      },
    }, { attribution: { session: runId, agentId: nodeId, repo: repoRoot } });
    const selected = eligible.find((assignment) => assignment.model === choice.answers.route.selected);
    if (!selected) throw new Error("Jev selected a route outside the eligible assignment snapshot.");
    const selectedIndex = eligible.findIndex((assignment) => assignment.model === selected.model);
    return immutableSnapshot({
      ...resolution,
      selected,
      // An adaptive choice cannot later fall back to a route Jev ranked below
      // it by wrapping around to an earlier candidate.
      fallbacks: eligible.slice(selectedIndex + 1),
      eligibleCandidates: eligible.slice(selectedIndex),
      selectionSource: "jev-adaptive",
    });
  }

  async function waitForTask(runId, taskId, signal, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) {
        await scheduler.cancelTask(taskId, "graph execution cancelled");
        return state.getTask(taskId);
      }
      let task = await state.getTask(taskId);
      if (terminalTask(task?.state)) return task;
      await scheduler.reconcile(runId);
      task = await state.getTask(taskId);
      if (terminalTask(task?.state)) return task;
      if (Date.now() >= deadline) {
        await scheduler.cancelTask(taskId, "graph node execution deadline exceeded");
        throw new Error(`Engineering node task ${taskId} exceeded ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function productionNodeAdapter({ node, outcomes, context, signal }) {
    const policyState = policyStateForRun.get(context.runId);
    if (!policyState) throw new Error(`No active policy snapshot exists for run ${context.runId}.`);
    if (node.kind === "verify") {
      const predecessor = latestPassingOutcome(outcomes);
      const gates = context.request.verificationGates;
      if (!Array.isArray(gates) || gates.length === 0) {
        throw new Error(`Verification node ${node.id} has no deterministic verification gates.`);
      }
      if (!predecessor?.resultRevision || !predecessor.worktreePath) {
        throw new Error(`Verification node ${node.id} has no revision-bound predecessor worktree.`);
      }
      const results = await verification.runPlan(gates.map((gate) => ({
        ...gate,
        cwd: gate.cwd || predecessor.worktreePath,
      })), {
        runId: context.runId,
        taskId: node.id,
        attemptId: "graph-verification",
        expectedIdentity: { sourceRevision: predecessor.resultRevision },
        signal,
      });
      const passed = results.every((result) => result.exitCode === 0 && result.timedOut !== true);
      return {
        status: passed ? "passed" : "failed",
        resultRevision: predecessor.resultRevision,
        worktreePath: predecessor.worktreePath,
        verificationResults: results,
        summary: passed ? "deterministic verification passed" : "deterministic verification failed",
      };
    }
    if (node.kind === "accept") {
      const predecessor = latestPassingOutcome(outcomes);
      if (!predecessor?.resultRevision) throw new Error(`Acceptance node ${node.id} has no revision-bound evidence.`);
      if (context.request.requireLeadAcceptance === false) {
        return { status: "passed", resultRevision: predecessor.resultRevision, source: "policy-not-required" };
      }
      const boundedOutcomes = Object.values(outcomes).map((outcome) => ({
        nodeId: outcome.nodeId,
        kind: outcome.kind,
        status: outcome.status,
        resultRevision: outcome.resultRevision,
        summary: String(outcome.summary || "").slice(0, 1_024),
      }));
      const lead = await astraLead.decide({
        operationId: `lead-${context.runId}-${node.id}`,
        task: { runId: context.runId, taskId: node.id },
        sourceRevision: predecessor.resultRevision,
        evidencePacket: { revision: predecessor.resultRevision, outcomes: boundedOutcomes },
      });
      if (!lead || !["accept", "reject"].includes(lead.decision) || lead.revision !== predecessor.resultRevision) {
        throw new Error("Assisted Astra returned a stale or invalid final decision.");
      }
      return {
        status: lead.decision === "accept" ? "passed" : "failed",
        resultRevision: predecessor.resultRevision,
        leadDecision: lead,
      };
    }

    const role = roleForNode(node);
    if (!role) throw new Error(`Graph node ${node.id} kind ${node.kind} has no production role mapping.`);
    const ownedPaths = nodeOwnedPaths(node, outcomes);
    const assignmentSnapshot = await resolvedAssignment(policyState, role, node.task || {}, context.runId, node.id);
    const assignment = assignmentSnapshot.selected;
    const taskId = `${context.runId}:${node.id}`;
    let task = await state.getTask(taskId);
    if (!task) {
      [task] = await scheduler.registerTasks(context.runId, [{
        ...copy(node.task || {}),
        taskId,
        role,
        assignment,
        assignmentSnapshot,
        objective: nodePrompt(node, outcomes),
        prompt: nodePrompt(node, outcomes),
        ownedPaths,
        writableScopes: node.isolatedWorkspace === true
          ? ownedPaths.map((ownedPath) => `.codex-router-isolated/${node.id}/${ownedPath}`)
          : ownedPaths,
        baseRevision: node.task?.baseRevision || latestPassingOutcome(outcomes)?.resultRevision || context.request.baseRevision || "HEAD",
        attemptLimit: node.task?.attemptLimit || 1,
      }]);
    }
    if (["planned", "ready", "retry_pending"].includes(task.state)) await controller.dispatchReady(context.runId);
    task = await waitForTask(
      context.runId,
      taskId,
      signal,
      context.request.nodeTimeoutMs ?? 30 * 60 * 1_000,
    );
    if (task.state !== "result_recorded") {
      return { status: task.state === "cancelled" ? "cancelled" : "failed", summary: task.lastError || task.state };
    }
    await controller.recordWorkerResult(taskId, task.workerResult, { notify: false, acknowledge: true });
    return {
      status: "passed",
      taskId,
      role,
      model: assignment.model,
      effort: assignment.effectiveEffort,
      resultRevision: task.workerResult.resultRevision,
      worktreeId: task.workerResult.worktreeId,
      worktreePath: task.workerResult.worktreePath,
      ownedPaths: task.workerResult.ownedPaths || ownedPaths,
      summary: task.workerResult.summary || `${node.kind} completed`,
    };
  }

  const paths = Object.freeze({ stateDir, statePath, worktreeStatePath, artifactRoot, worktreeRoot, repoRoot });
  const dependencies = {
    state,
    scheduler,
    controller,
    executor,
    runtimeAdapter: dispatchRuntime,
    verifier: verification,
    worktrees: worktreeManager,
    worktreeState: durableWorktreeState,
    prism: decisions,
    prismClient: decisions,
    routeAvailability,
    nodeAdapter: nodeAdapter || productionNodeAdapter,
    paths,
  };
  let graphPromise;
  const graphExecutor = () => {
    graphPromise ||= Promise.resolve(instantiateGraphExecutor(graphModuleLoader, graphExecutorFactory, dependencies));
    return graphPromise;
  };

  async function assertRoutesAvailable(routes) {
    for (const route of routes) {
      const availability = normalizeAvailability(await routeAvailability(route));
      if (!availability.available) {
        throw new Error(`Engineering route ${route} is unavailable${availability.reason ? `: ${availability.reason}` : ""}.`);
      }
    }
  }

  async function runEngineeringWorkflow(request) {
    if (!plainObject(request)) throw new TypeError("Engineering workflow request must be an object.");
    const runId = requiredText(request.runId, "Engineering workflow runId");
    if (!Number.isSafeInteger(request.policyRevision) || request.policyRevision < 0) {
      throw new TypeError("Engineering workflow policyRevision must be a non-negative safe integer.");
    }
    const policyState = await policyReader({ stateDir, registry: policyRegistry });
    if (!plainObject(policyState) || policyState.degraded === true) {
      throw new Error("Engineering policy is degraded; production orchestration is disabled.");
    }
    if (policyState.enabled !== true || policyState.policy?.enabled !== true) {
      throw new Error("Engineering orchestration is disabled by policy.");
    }
    if (policyState.revision !== request.policyRevision) {
      throw new Error(`Engineering policy revision changed: requested ${request.policyRevision}, current ${policyState.revision}.`);
    }
    if (!decisions) throw new Error("Kiro Prism decisions are unavailable; engineering orchestration fails closed.");
    await assertRoutesAvailable(requiredRoutes(request));

    const callbacks = request.assistedAstra;
    if (callbacks !== undefined && (!plainObject(callbacks) || typeof callbacks.decide !== "function")) {
      throw new TypeError("assistedAstra must expose decide().");
    }
    if (activeAstraCallbacks.has(runId) || policyStateForRun.has(runId)) throw new Error(`Engineering run ${runId} is already active.`);
    if (callbacks) activeAstraCallbacks.set(runId, callbacks);
    policyStateForRun.set(runId, policyState);
    try {
      const executorGraph = await graphExecutor();
      const workflowGraph = workflowGraphFromRequest(request);
      if (typeof executorGraph?.runEngineeringWorkflow === "function") {
        const safeRequest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "assistedAstra"));
        return await executorGraph.runEngineeringWorkflow({
          ...copy(safeRequest),
          policy: copy(policyState.policy),
          policyRevision: policyState.revision,
          runtime: dependencies,
        });
      }
      if (typeof executorGraph?.execute !== "function") {
        throw new Error("Engineering graph executor exposes no supported run method.");
      }
      if (!plainObject(workflowGraph)) {
        throw new TypeError("Engineering workflow request must include graph or workflowGraph.");
      }
      return await executorGraph.execute(copy(workflowGraph), {
        adapter: dependencies.nodeAdapter,
        controller,
        context: {
          runId,
          policy: copy(policyState.policy),
          policyRevision: policyState.revision,
          request: copy(Object.fromEntries(Object.entries(request).filter(([key]) => (
            key !== "assistedAstra" && key !== "graph" && key !== "workflowGraph"
          )))),
          paths,
        },
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.maximumConcurrency !== undefined ? { maximumConcurrency: request.maximumConcurrency } : {}),
      });
    } finally {
      if (callbacks) activeAstraCallbacks.delete(runId);
      policyStateForRun.delete(runId);
    }
  }

  return Object.freeze({
    ...dependencies,
    paths,
    runEngineeringWorkflow,
    status: (runId) => controller.status(requiredText(runId, "Engineering runId")),
    resume: (runId) => controller.resume(requiredText(runId, "Engineering runId")),
  });
}

export function runEngineeringWorkflow(runtime, request) {
  if (!runtime || typeof runtime.runEngineeringWorkflow !== "function") {
    throw new TypeError("A composed engineering runtime is required.");
  }
  return runtime.runEngineeringWorkflow(request);
}
