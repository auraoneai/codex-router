import assert from "node:assert/strict";
import test from "node:test";

import { EngineeringGraphExecutor, executeStrategyGraph } from "../src/engineering/graph-executor.mjs";
import { compileStrategyGraph } from "../src/engineering/strategies.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function passingAdapter({ delay = 0, result = () => ({ status: "passed" }) } = {}) {
  return async ({ node, outcomes }) => {
    if (delay) await wait(delay);
    return result(node, outcomes);
  };
}

test("single executes work and deterministic gates in dependency order", async () => {
  const graph = compileStrategyGraph({
    strategy: "single",
    task: { id: "implement", ownedPaths: ["src/a.mjs"] },
    verification: true,
    review: true,
  });
  const calls = [];
  const result = await executeStrategyGraph({
    graph,
    dispatch: async ({ node }) => {
      calls.push(node.kind);
      return { status: "passed", artifact: node.id };
    },
  });
  assert.deepEqual(calls, ["work", "verify", "review", "accept"]);
  assert.equal(result.accepted, true);
  assert.equal(result.status, "passed");
  assert.equal(result.outcomes[result.acceptanceNodeId].status, "passed");
  assert.ok(result.outcomes[result.executionOrder[0]].startedAt.endsWith("Z"));
});

test("swarm starts ready workers concurrently and records proven overlap", async () => {
  const graph = compileStrategyGraph({
    strategy: "swarm",
    slices: [
      { id: "api", ownedPaths: ["src/api"] },
      { id: "ui", ownedPaths: ["src/ui"] },
      { id: "docs", ownedPaths: ["docs"] },
    ],
    integrationOwner: "astra",
  });
  let active = 0;
  let peak = 0;
  const result = await new EngineeringGraphExecutor({
    controller: {
      async dispatch({ node }) {
        if (node.kind === "work") {
          active += 1;
          peak = Math.max(peak, active);
          await wait(20);
          active -= 1;
        }
        return { status: "passed" };
      },
    },
  }).execute(graph);
  const workers = graph.nodes.filter((node) => node.kind === "work").map((node) => result.outcomes[node.id]);
  assert.equal(peak, 3);
  assert.equal(workers.every((left) => workers.some((right) =>
    left.nodeId !== right.nodeId && left.startedAtMs < right.finishedAtMs && right.startedAtMs < left.finishedAtMs)), true);
  assert.equal(result.accepted, true);
});

test("a failed success dependency blocks integration and every downstream gate", async () => {
  const graph = compileStrategyGraph({
    strategy: "swarm",
    slices: [
      { id: "good", ownedPaths: ["src/good"] },
      { id: "bad", ownedPaths: ["src/bad"] },
    ],
    integrationOwner: "astra",
  });
  const called = [];
  const result = await executeStrategyGraph({
    graph,
    adapter: passingAdapter({ result(node) {
      called.push(node.kind);
      return node.task?.id === "bad" ? { status: "failed", reason: "tests failed" } : { status: "passed" };
    } }),
  });
  assert.deepEqual(called, ["work", "work"]);
  assert.equal(result.accepted, false);
  assert.equal(result.failedNodeIds.length, 1);
  assert.equal(result.blockedNodeIds.length, graph.nodes.length - 2);
  const integration = graph.nodes.find((node) => node.kind === "integrate");
  assert.equal(result.outcomes[integration.id].code, "DEPENDENCY_CONDITION_UNSATISFIED");
});

test("pipeline runs independent roots together and waits for every declared dependency", async () => {
  const graph = compileStrategyGraph({
    strategy: "pipeline",
    stages: [
      { id: "inspect-a", dependencies: [] },
      { id: "inspect-b", dependencies: [] },
      { id: "implement", dependencies: ["inspect-a", "inspect-b"] },
    ],
  });
  const finished = new Set();
  let rootsActive = 0;
  let rootsPeak = 0;
  const result = await executeStrategyGraph({
    graph,
    maximumConcurrency: 2,
    dispatch: async ({ node }) => {
      if (node.task?.id?.startsWith("inspect")) {
        rootsActive += 1;
        rootsPeak = Math.max(rootsPeak, rootsActive);
        await wait(10);
        rootsActive -= 1;
        finished.add(node.task.id);
      }
      if (node.task?.id === "implement") assert.deepEqual([...finished].sort(), ["inspect-a", "inspect-b"]);
      return { status: "passed" };
    },
  });
  assert.equal(rootsPeak, 2);
  assert.equal(result.accepted, true);
});

test("arena uses all-settled candidates but requires an explicitly selected judge result", async () => {
  const graph = compileStrategyGraph({
    strategy: "arena",
    brief: { baseRevision: "rev-1", rubric: ["correctness"] },
    candidates: [
      { id: "one", model: "model-one", ownedPaths: ["src/same.mjs"] },
      { id: "two", model: "model-two", ownedPaths: ["src/same.mjs"] },
    ],
    judge: { id: "independent-judge" },
  });
  const result = await executeStrategyGraph({
    graph,
    dispatch: async ({ node }) => {
      if (node.candidateId === "one") return { status: "failed" };
      if (node.kind === "judge") return { status: "passed", selected: true, winnerId: "two" };
      return { status: "passed" };
    },
  });
  assert.equal(result.failedNodeIds.length, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.outcomes[graph.nodes.find((node) => node.kind === "integrate").id].status, "passed");
});

test("interrogate closes the unused branch and accepts the no-findings path", async () => {
  const graph = compileStrategyGraph({
    strategy: "interrogate",
    revision: "rev-fixed",
    reviewers: [
      { id: "review-a", lineage: [{ family: "gpt", served: true }] },
      { id: "review-b", lineage: [{ family: "claude", served: true }] },
    ],
  });
  const calledKinds = [];
  const result = await executeStrategyGraph({
    graph,
    dispatch: async ({ node }) => {
      calledKinds.push(node.kind);
      if (node.kind === "dedupe") return { status: "passed", hasFindings: false };
      return { status: "passed" };
    },
  });
  assert.equal(calledKinds.includes("remediate"), false);
  const remediation = graph.nodes.find((node) => node.kind === "remediate");
  assert.equal(result.outcomes[remediation.id].status, "blocked");
  assert.equal(result.accepted, true);
});

test("adapter exceptions fail closed and redact credential-shaped error details", async () => {
  const graph = compileStrategyGraph({ strategy: "single", task: { id: "one" } });
  const result = await executeStrategyGraph({
    graph,
    dispatch: async ({ node }) => {
      if (node.kind === "work") throw new Error("token=should-never-persist");
      return { status: "passed" };
    },
  });
  const failure = Object.values(result.outcomes).find((outcome) => outcome.status === "failed");
  assert.match(failure.message, /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(result), /should-never-persist/u);
  assert.equal(result.accepted, false);
});
