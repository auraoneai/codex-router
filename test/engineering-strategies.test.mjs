import assert from "node:assert/strict";
import test from "node:test";

import {
  compileArena,
  compileInterrogate,
  compilePipeline,
  compileSingle,
  compileSwarm,
  evaluateAcceptance,
  mergeFindings,
  readyNodes,
  selectArenaWinner,
  validateFamilyDiversity,
  validateWorkflowGraph,
} from "../src/engineering/strategies.mjs";

test("single, swarm, and pipeline compile deterministic dependency graphs", () => {
  const single = compileSingle({ task: { id: "one", ownedPaths: ["src/a"] } });
  assert.equal(validateWorkflowGraph(single), true);
  assert.equal(readyNodes(single).length, 1);

  const swarm = compileSwarm({
    slices: [
      { id: "a", ownedPaths: ["src/a"] },
      { id: "b", ownedPaths: ["src/b"] },
    ],
    integrationOwner: "integrator",
  });
  assert.equal(readyNodes(swarm).length, 2);
  assert.throws(() => compileSwarm({
    slices: [
      { id: "a", ownedPaths: ["src"] },
      { id: "b", ownedPaths: ["src/b"] },
    ],
    integrationOwner: "integrator",
  }), (problem) => problem.code === "OWNERSHIP_OVERLAP");

  const pipeline = compilePipeline({
    stages: [
      { id: "inspect", dependencies: [] },
      { id: "change", dependencies: ["inspect"] },
    ],
  });
  assert.equal(readyNodes(pipeline).length, 1);
  assert.throws(() => compilePipeline({ stages: [
    { id: "a", dependencies: ["b"] },
    { id: "b", dependencies: ["a"] },
  ] }), (problem) => problem.code === "CYCLIC_DEPENDENCY");
});

test("arena permits overlapping candidate paths only because every candidate is isolated", () => {
  const arena = compileArena({
    brief: { baseRevision: "abc123", rubric: ["correctness"] },
    candidates: [
      { id: "candidate-a", model: "model-a", ownedPaths: ["src/same.mjs"] },
      { id: "candidate-b", model: "model-b", ownedPaths: ["src/same.mjs"] },
    ],
    judge: { id: "judge", model: "judge-model" },
  });
  const candidates = arena.nodes.filter((entry) => entry.kind === "work");
  assert.equal(candidates.length, 2);
  assert.equal(candidates.every((entry) => entry.isolatedWorkspace), true);
  const judge = arena.nodes.find((entry) => entry.kind === "judge");
  assert.deepEqual(readyNodes(arena, {
    [candidates[0].id]: { status: "passed" },
    [candidates[1].id]: { status: "failed" },
  }), [judge.id]);
  assert.throws(() => compileArena({
    brief: { baseRevision: "abc123", rubric: ["correctness"] },
    candidates: [
      { id: "same", model: "model-a", ownedPaths: ["src/a"] },
      { id: "same", model: "model-b", ownedPaths: ["src/b"] },
    ],
    judge: { id: "judge" },
  }), /unique/u);
  assert.throws(() => compileArena({
    brief: { baseRevision: "abc123", rubric: ["correctness"] },
    candidates: [
      { id: "candidate-a", ownedPaths: ["src/a"] },
      { id: "candidate-b", ownedPaths: ["src/b"] },
    ],
    judge: { id: "candidate-a" },
  }), /independent judge/u);
});

test("interrogate supports both no-findings and remediation branches", () => {
  const workflow = compileInterrogate({
    revision: "revision-a",
    reviewers: [
      { id: "sol", lineage: [{ family: "gpt", served: true }] },
      { id: "opus", lineage: [{ family: "claude", served: true }] },
    ],
  });
  const reviews = workflow.nodes.filter((entry) => entry.kind === "review" && entry.reviewer);
  const dedupe = workflow.nodes.find((entry) => entry.kind === "dedupe");
  const remediate = workflow.nodes.find((entry) => entry.kind === "remediate");
  const verify = workflow.nodes.find((entry) => entry.kind === "verify");
  const reviewed = Object.fromEntries(reviews.map((entry) => [entry.id, { status: "passed" }]));
  assert.deepEqual(readyNodes(workflow, reviewed), [dedupe.id]);
  assert.ok(readyNodes(workflow, { ...reviewed, [dedupe.id]: { status: "passed", hasFindings: false } }).includes(verify.id));
  assert.deepEqual(
    readyNodes(workflow, { ...reviewed, [dedupe.id]: { status: "passed", hasFindings: true } }),
    [remediate.id],
  );
});

test("family diversity uses the actual serving family rather than failed lineage attempts", () => {
  const diversity = validateFamilyDiversity({
    reviewerLineages: [
      [{ family: "modal", status: "failed" }, { family: "glm", status: "served" }],
      [{ family: "modal", status: "served" }],
    ],
    minDistinctFamilies: 2,
  });
  assert.deepEqual(diversity.distinctFamilies, ["glm", "modal"]);
  assert.equal(diversity.ok, true);
  assert.equal(validateFamilyDiversity({
    reviewerLineages: [
      [{ family: "deepseek", status: "failed" }, { family: "glm", status: "served" }],
      [{ family: "glm", status: "served" }],
    ],
    minDistinctFamilies: 2,
  }).ok, false);
});

test("acceptance and arena selection cannot override failed gates or reproducible findings", () => {
  const merged = mergeFindings([
    { reviewerId: "a", findings: [{ invariant: "safe", location: "x", reproducer: "cmd", reproducible: true }] },
    { reviewerId: "b", findings: [{ invariant: "safe", location: "x", reproducer: "cmd" }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].blocking, true);
  const rejected = evaluateAcceptance({
    targetRevision: "rev",
    gates: [{ id: "unit", status: "passed", revision: "rev" }],
    findings: merged,
  });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reasons.join(" "), /unresolved/u);
  assert.equal(evaluateAcceptance({ targetRevision: "rev", gates: [] }).accepted, false);

  assert.deepEqual(selectArenaWinner({
    candidates: [
      { id: "unsafe", deterministicGates: [] },
      { id: "safe", deterministicGates: [{ status: "passed" }] },
    ],
    judge: { winnerId: "unsafe" },
  }), { status: "needs_adjudication", eligible: ["safe"] });
});
