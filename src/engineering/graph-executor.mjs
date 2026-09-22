import { validateWorkflowGraph } from "./strategies.mjs";

const TERMINAL_STATUSES = new Set(["passed", "failed", "blocked", "cancelled"]);
const PASS_STATUSES = new Set(["passed", "success", "succeeded", "accepted", "complete", "completed"]);
const FAILURE_STATUSES = new Set(["failed", "failure", "rejected", "error"]);
const MAX_ERROR_BYTES = 2 * 1024;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeError(value) {
  let message = String(value?.message || value || "unknown graph execution error")
    .replace(/((?:api[-_]?key|password|secret|token|credential)\s*[=:]\s*)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:proxy-)?authorization\s*:\s*(?:bearer\s+)?)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[-_]?key|token|secret|credential)=)[^&#\s]+/giu, "$1[REDACTED]");
  while (Buffer.byteLength(message) > MAX_ERROR_BYTES) message = message.slice(0, -1);
  return message;
}

function timestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function edgeState(edge, outcomes) {
  const outcome = outcomes[edge.from];
  if (!outcome || !TERMINAL_STATUSES.has(outcome.status)) return "pending";
  switch (edge.condition) {
    case "success": return outcome.status === "passed" ? "satisfied" : "impossible";
    case "selected": return outcome.status === "passed" && outcome.selected === true ? "satisfied" : "impossible";
    case "findings": return outcome.status === "passed" && outcome.hasFindings === true ? "satisfied" : "impossible";
    case "no-findings": return outcome.status === "passed" && outcome.hasFindings === false ? "satisfied" : "impossible";
    case "settled": return "satisfied";
    default: return "impossible";
  }
}

function dependencyState(node, edges, outcomes) {
  if (edges.length === 0) return "ready";
  const states = edges.map((edge) => edgeState(edge, outcomes));
  if (node.join === "any") {
    if (states.includes("satisfied")) return "ready";
    if (states.every((state) => state === "impossible")) return "blocked";
    return "waiting";
  }
  if (states.includes("impossible")) return "blocked";
  if (states.every((state) => state === "satisfied")) return "ready";
  return "waiting";
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (PASS_STATUSES.has(status)) return "passed";
  if (FAILURE_STATUSES.has(status)) return "failed";
  if (status === "blocked" || status === "cancelled") return status;
  throw new TypeError(`Graph node adapter returned unsupported terminal status ${JSON.stringify(value)}.`);
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("Graph node adapter must return an explicit terminal outcome object.");
  }
  const status = normalizeStatus(result.status ?? result.state ?? result.outcome);
  const normalized = { ...copy(result), status };
  delete normalized.state;
  return normalized;
}

function resolveDispatch({ adapter, controller, dispatch }) {
  if (typeof dispatch === "function") return dispatch;
  if (typeof adapter === "function") return adapter;
  if (typeof controller === "function") return controller;
  const owner = adapter || controller;
  for (const method of ["executeNode", "runNode", "dispatchNode", "dispatch"]) {
    if (typeof owner?.[method] === "function") return owner[method].bind(owner);
  }
  throw new TypeError("Graph executor requires a dispatch function or adapter/controller node method.");
}

function validateMaximumConcurrency(value) {
  if (value === undefined || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumConcurrency must be a positive integer or Infinity.");
  }
  return value;
}

/**
 * Execute a compiled engineering strategy graph to a terminal result.
 *
 * The adapter is deliberately node-oriented: dispatch({ node, graph, outcomes,
 * context, signal }) must settle only after that node has a final outcome. This
 * keeps transport-specific dispatch/reconciliation in the adapter while this
 * executor owns dependency ordering, branch closure, and concurrency.
 */
export async function executeStrategyGraph({
  graph,
  adapter,
  controller,
  dispatch,
  context,
  signal,
  maximumConcurrency,
  now = Date.now,
} = {}) {
  validateWorkflowGraph(graph);
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const concurrency = validateMaximumConcurrency(maximumConcurrency);
  const runNode = resolveDispatch({ adapter, controller, dispatch });
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) incoming.get(edge.to).push(edge);

  const runStartedMs = Number(now());
  if (!Number.isFinite(runStartedMs)) throw new TypeError("now() must return epoch milliseconds.");
  const outcomes = {};
  const pending = new Set(graph.nodes.map((node) => node.id));
  const running = new Map();
  const executionOrder = [];

  const finishWithoutDispatch = (nodeId, status, code, message) => {
    const at = Number(now());
    outcomes[nodeId] = {
      nodeId,
      kind: nodeById.get(nodeId).kind,
      status,
      code,
      message,
      startedAt: timestamp(at),
      startedAtMs: at,
      finishedAt: timestamp(at),
      finishedAtMs: at,
      durationMs: 0,
    };
    pending.delete(nodeId);
  };

  const start = (nodeId) => {
    const node = nodeById.get(nodeId);
    const startedAtMs = Number(now());
    pending.delete(nodeId);
    executionOrder.push(nodeId);
    const promise = (async () => {
      try {
        const result = normalizeResult(await runNode({
          node: copy(node),
          graph: copy(graph),
          outcomes: copy(outcomes),
          context: copy(context),
          signal,
        }));
        const finishedAtMs = Number(now());
        outcomes[nodeId] = {
          ...result,
          nodeId,
          kind: node.kind,
          startedAt: timestamp(startedAtMs),
          startedAtMs,
          finishedAt: timestamp(finishedAtMs),
          finishedAtMs,
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
        };
      } catch (problem) {
        const finishedAtMs = Number(now());
        outcomes[nodeId] = {
          nodeId,
          kind: node.kind,
          status: signal?.aborted ? "cancelled" : "failed",
          code: signal?.aborted ? "GRAPH_EXECUTION_CANCELLED" : (problem?.code || "NODE_EXECUTION_FAILED"),
          message: safeError(signal?.aborted ? signal.reason || problem : problem),
          startedAt: timestamp(startedAtMs),
          startedAtMs,
          finishedAt: timestamp(finishedAtMs),
          finishedAtMs,
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
        };
      } finally {
        running.delete(nodeId);
      }
    })();
    running.set(nodeId, promise);
  };

  while (pending.size > 0 || running.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const nodeId of [...pending]) {
        if (dependencyState(nodeById.get(nodeId), incoming.get(nodeId), outcomes) !== "blocked") continue;
        const failedDependencies = incoming.get(nodeId)
          .filter((edge) => edgeState(edge, outcomes) === "impossible")
          .map((edge) => ({ nodeId: edge.from, condition: edge.condition, status: outcomes[edge.from]?.status }));
        finishWithoutDispatch(
          nodeId,
          "blocked",
          "DEPENDENCY_CONDITION_UNSATISFIED",
          `Node ${nodeId} cannot run because its dependency conditions cannot be satisfied.`,
        );
        outcomes[nodeId].dependencies = failedDependencies;
        changed = true;
      }
    }

    if (signal?.aborted) {
      for (const nodeId of [...pending]) {
        finishWithoutDispatch(nodeId, "cancelled", "GRAPH_EXECUTION_CANCELLED", safeError(signal.reason || "Execution cancelled."));
      }
    } else {
      const available = concurrency === Infinity ? pending.size : Math.max(0, concurrency - running.size);
      if (available > 0) {
        const ready = [...pending]
          .filter((nodeId) => dependencyState(nodeById.get(nodeId), incoming.get(nodeId), outcomes) === "ready")
          .sort()
          .slice(0, available);
        for (const nodeId of ready) start(nodeId);
      }
    }

    if (running.size > 0) {
      await Promise.race([...running.values()]);
      continue;
    }
    if (pending.size > 0) {
      // validateWorkflowGraph has already excluded cycles. Reaching this state
      // therefore means no branch can produce the condition a remaining node
      // requires; fail closed instead of returning a partial graph as success.
      for (const nodeId of [...pending]) {
        finishWithoutDispatch(
          nodeId,
          "blocked",
          "GRAPH_EXECUTION_STALLED",
          `Node ${nodeId} has no executable dependency path.`,
        );
      }
    }
  }

  const runFinishedMs = Number(now());
  const acceptance = outcomes[graph.acceptanceNodeId];
  const accepted = acceptance?.status === "passed";
  const orderedOutcomes = Object.fromEntries(graph.nodes.map((node) => [node.id, outcomes[node.id]]));
  return {
    version: 1,
    strategy: graph.strategy,
    status: accepted ? "passed" : (signal?.aborted ? "cancelled" : "failed"),
    accepted,
    acceptanceNodeId: graph.acceptanceNodeId,
    startedAt: timestamp(runStartedMs),
    startedAtMs: runStartedMs,
    finishedAt: timestamp(runFinishedMs),
    finishedAtMs: runFinishedMs,
    durationMs: Math.max(0, runFinishedMs - runStartedMs),
    executionOrder,
    failedNodeIds: graph.nodes.filter((node) => outcomes[node.id].status === "failed").map((node) => node.id),
    blockedNodeIds: graph.nodes.filter((node) => outcomes[node.id].status === "blocked").map((node) => node.id),
    outcomes: orderedOutcomes,
  };
}

export class EngineeringGraphExecutor {
  constructor(options = {}) {
    this.options = { ...options };
  }

  execute(graph, options = {}) {
    return executeStrategyGraph({ ...this.options, ...options, graph });
  }
}
