import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { storeArtifact } from "../src/engineering/artifacts.mjs";
import { CodexAppServerExecutor } from "../src/engineering/codex-executor.mjs";
import { PrismDecisionsClient } from "../src/engineering/prism-decisions.mjs";
import {
  createEngineeringRuntime,
  runEngineeringWorkflow,
} from "../src/engineering/runtime.mjs";
import { compileSingle } from "../src/engineering/strategies.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-production-runtime-"));
  const repoRoot = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  mkdirSync(repoRoot);
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: repoRoot });
  execFileSync("git", ["-c", "user.name=Router", "-c", "user.email=router@example.invalid", "commit", "-q", "-m", "seed"], { cwd: repoRoot });
  return { root, repoRoot, stateDir };
}

function policyState({ enabled = true, revision = 7, degraded = false } = {}) {
  return {
    status: degraded ? "degraded" : "ok",
    degraded,
    enabled,
    revision,
    policy: {
      schemaVersion: 1,
      enabled,
      activePreset: "test",
    },
  };
}

function options(environment, overrides = {}) {
  return {
    stateDir: environment.stateDir,
    repoRoot: environment.repoRoot,
    policyReader: () => policyState(),
    routeAvailability: () => ({ available: true }),
    prismApiKey: "unit-test-prism-key",
    appServerClient: {},
    nodeAdapter: async ({ node }) => ({ status: "passed", nodeKind: node.kind }),
    ...overrides,
  };
}

test("production runtime composes durable state, artifacts, Prism, app-server, controller, and graph execution", async () => {
  const environment = fixture();
  try {
    const runtime = createEngineeringRuntime(options(environment));
    assert.equal(runtime.state.constructor.name, "DurableSchedulerState");
    assert.equal(runtime.worktreeState.constructor.name, "DurableWorktreeState");
    assert.equal(runtime.executor instanceof CodexAppServerExecutor, true);
    assert.equal(runtime.prism instanceof PrismDecisionsClient, true);
    assert.equal(runtime.scheduler.runtime, runtime.runtimeAdapter);
    assert.equal(runtime.controller.state, runtime.state);
    assert.equal(runtime.verifier.artifactRoot, runtime.paths.artifactRoot);
    assert.equal(runtime.state.target, runtime.paths.statePath);
    assert.equal(runtime.worktreeState.target, runtime.paths.worktreeStatePath);

    const reference = storeArtifact(runtime.paths.artifactRoot, "run/runtime-proof.json", "{}\n");
    assert.equal(reference.path, "run/runtime-proof.json");
    if (process.platform !== "win32") {
      assert.equal(statSync(runtime.paths.artifactRoot).mode & 0o077, 0);
    }

    const graph = compileSingle({ task: { id: "work", ownedPaths: ["src/runtime.mjs"] } });
    const result = await runEngineeringWorkflow(runtime, {
      runId: "run-production",
      policyRevision: 7,
      requiredRoutes: ["test/available-route"],
      strategy: "single",
      tasks: [{ id: "work", ownedPaths: ["src/runtime.mjs"] }],
      maximumConcurrency: 2,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.executionOrder.length, graph.nodes.length);
    assert.equal(result.outcomes[graph.acceptanceNodeId].status, "passed");

    // The production factory owns filesystem-backed adapters. Merely composing
    // it must never substitute either process-local fixture implementation.
    assert.notEqual(runtime.state.constructor.name, "Object");
    assert.notEqual(runtime.worktreeState.constructor.name, "Object");
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("disabled or degraded policy fails before graph loading or production dispatch", async () => {
  const environment = fixture();
  try {
    let graphLoads = 0;
    const runtime = createEngineeringRuntime(options(environment, {
      policyReader: () => policyState({ enabled: false, revision: 0 }),
      graphModuleLoader: async () => {
        graphLoads += 1;
        throw new Error("must not load");
      },
    }));
    await assert.rejects(() => runtime.runEngineeringWorkflow({
      runId: "disabled-run",
      policyRevision: 0,
      graph: compileSingle({ task: { id: "work" } }),
    }), /disabled by policy/u);
    assert.equal(graphLoads, 0);
    assert.equal(existsSync(runtime.paths.statePath), false);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("stale policy revisions and unavailable routes fail closed", async () => {
  const environment = fixture();
  try {
    let graphFactoryCalls = 0;
    const runtime = createEngineeringRuntime(options(environment, {
      routeAvailability: (route) => ({ available: route !== "provider/unhealthy", reason: "live route probe failed" }),
      graphExecutorFactory: () => {
        graphFactoryCalls += 1;
        return { execute: async () => ({ accepted: true }) };
      },
    }));
    const graph = compileSingle({ task: { id: "work" } });
    await assert.rejects(() => runtime.runEngineeringWorkflow({
      runId: "stale-run", policyRevision: 6, graph,
    }), /revision changed/u);
    await assert.rejects(() => runtime.runEngineeringWorkflow({
      runId: "unavailable-run", policyRevision: 7, requiredRoutes: ["provider/unhealthy"], graph,
    }), /route provider\/unhealthy is unavailable: live route probe failed/u);
    assert.equal(graphFactoryCalls, 0);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("assisted Astra callbacks are attached only to the active run", async () => {
  const environment = fixture();
  try {
    let dependencies;
    const runtime = createEngineeringRuntime(options(environment, {
      graphExecutorFactory: (input) => {
        dependencies = input;
        return {
          async runEngineeringWorkflow(request) {
            const lead = await input.controller.astraLead.decide({
              operationId: "lead-op",
              task: { runId: request.runId },
              sourceRevision: "revision-1",
              evidencePacket: { revision: "revision-1" },
            });
            return { accepted: lead.decision === "accept", lead };
          },
        };
      },
    }));
    const observed = [];
    const result = await runtime.runEngineeringWorkflow({
      runId: "assisted-run",
      policyRevision: 7,
      assistedAstra: {
        decide(input) {
          observed.push(input.evidencePacket.revision);
          return { decision: "accept", revision: input.sourceRevision };
        },
      },
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(observed, ["revision-1"]);
    await assert.rejects(() => dependencies.controller.astraLead.decide({
      task: { runId: "assisted-run" }, sourceRevision: "revision-1",
    }), /callback is unavailable/u);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("default production node adapter durably binds a route and worktree before app-server dispatch", async () => {
  const environment = fixture();
  try {
    const defaults = JSON.parse(readFileSync(new URL("../config/engineering-policy.defaults.json", import.meta.url), "utf8"));
    defaults.enabled = true;
    defaults.executionSelectionMode = "pinned";
    let runtime;
    let dispatchedBinding;
    let committed = false;
    const appServerExecutor = {
      async dispatch({ task, binding }) {
        const persisted = await runtime.state.getTask(task.taskId);
        assert.equal(persisted.executionBinding.bindingId, task.executionBinding.bindingId);
        assert.equal(binding.executionBinding.bindingId, task.executionBinding.bindingId);
        dispatchedBinding = task.executionBinding;
        return { state: "running", childId: "thread-1", threadId: "thread-1", turnId: "turn-1" };
      },
      async inspect({ binding }) {
        const worktree = binding.dispatchReceipt.worktree;
        if (!committed) {
          writeFileSync(path.join(worktree.path, "result.txt"), "production result\n");
          execFileSync("git", ["add", "result.txt"], { cwd: worktree.path });
          execFileSync("git", ["-c", "user.name=Router", "-c", "user.email=router@example.invalid", "commit", "-q", "-m", "result"], { cwd: worktree.path });
          committed = true;
        }
        return {
          state: "result",
          result: {
            attemptId: binding.attemptId,
            operationId: binding.operationId,
            fences: Object.fromEntries(binding.leases.map((lease) => [lease.scope, lease.fence])),
            summary: "implemented production result",
          },
        };
      },
      async cancel() { return { state: "cancelled" }; },
    };
    runtime = createEngineeringRuntime(options(environment, {
      policyReader: () => ({
        status: "ok", degraded: false, enabled: true, revision: 7, policy: defaults,
      }),
      routeAvailability: (route) => ({
        available: route === "gemini-api/models/gemini-3.8-flash",
        provider: "gemini-api",
        reason: "not selected for this fixture",
      }),
      appServerExecutor,
      nodeAdapter: undefined,
    }));
    const graph = compileSingle({
      task: {
        id: "work",
        role: "general_coder",
        objective: "Write result.txt",
        ownedPaths: ["result.txt"],
      },
      verification: false,
      review: false,
    });
    const result = await runtime.runEngineeringWorkflow({
      runId: "real-adapter-run",
      policyRevision: 7,
      graph,
      requireLeadAcceptance: false,
      nodeTimeoutMs: 5_000,
    });
    assert.equal(result.accepted, true);
    assert.equal(dispatchedBinding.model, "gemini-api/models/gemini-3.8-flash");
    assert.equal(dispatchedBinding.effectiveEffort, "high");
    assert.equal(path.isAbsolute(dispatchedBinding.worktree), true);
    const [task] = await runtime.state.listTasks("real-adapter-run");
    assert.equal(task.workerResult.resultRevision.length >= 40, true);
    assert.equal(task.executionBinding.bindingId, dispatchedBinding.bindingId);
    if (process.platform !== "win32") {
      assert.equal(statSync(runtime.paths.statePath).mode & 0o077, 0);
      assert.equal(statSync(runtime.paths.worktreeStatePath).mode & 0o077, 0);
    }
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("DeepSeek 429 falls through the immutable snapshot, skips unavailable GLM, and dispatches Sol without Kimi", async () => {
  const environment = fixture();
  try {
    const defaults = JSON.parse(readFileSync(new URL("../config/engineering-policy.defaults.json", import.meta.url), "utf8"));
    defaults.enabled = true;
    defaults.executionSelectionMode = "pinned";
    const deepseek = "kiro-prism/deepseek-v4.1-flash";
    const glm = "cloudflare-workers-ai/glm-5.3";
    const sol = "gpt-6-sol";
    const sonnet = "kiro-prism/claude-sonnet-5";
    const dispatches = [];
    let committed = false;
    const appServerExecutor = {
      async dispatch({ task }) {
        dispatches.push(task.executionBinding.model);
        if (task.executionBinding.model === deepseek) {
          const error = new Error("Modal capacity exhausted: too many requests");
          error.status = 429;
          error.dispatched = true;
          error.outputState = "none";
          error.toolActionState = "none";
          throw error;
        }
        return { state: "running", childId: "thread-sol", threadId: "thread-sol", turnId: "turn-sol" };
      },
      async inspect({ binding }) {
        const worktree = binding.dispatchReceipt.worktree;
        if (!committed) {
          writeFileSync(path.join(worktree.path, "fallback.txt"), "sol result\n");
          execFileSync("git", ["add", "fallback.txt"], { cwd: worktree.path });
          execFileSync("git", ["-c", "user.name=Router", "-c", "user.email=router@example.invalid", "commit", "-q", "-m", "fallback result"], { cwd: worktree.path });
          committed = true;
        }
        return {
          state: "result",
          result: {
            attemptId: binding.attemptId,
            operationId: binding.operationId,
            fences: Object.fromEntries(binding.leases.map((lease) => [lease.scope, lease.fence])),
            summary: "fallback completed",
          },
        };
      },
      async cancel() { return { state: "cancelled" }; },
    };
    const runtime = createEngineeringRuntime(options(environment, {
      policyReader: () => ({ status: "ok", degraded: false, enabled: true, revision: 7, policy: defaults }),
      routeAvailability: (route) => ({
        available: [deepseek, sol, sonnet].includes(route),
        provider: route.split("/")[0],
        capacityHost: route === deepseek ? "modal" : route.split("/")[0],
        reason: route === glm ? "Cloudflare circuit is open" : "not selected for this fixture",
      }),
      appServerExecutor,
      nodeAdapter: undefined,
    }));
    const graph = compileSingle({
      task: {
        id: "debug",
        role: "debugger",
        objective: "Diagnose and fix the failure",
        ownedPaths: ["fallback.txt"],
      },
      verification: false,
      review: false,
    });
    const result = await runtime.runEngineeringWorkflow({
      runId: "deepseek-fallback-run",
      policyRevision: 7,
      graph,
      requireLeadAcceptance: false,
      nodeTimeoutMs: 5_000,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(dispatches, [deepseek, sol]);
    assert.equal(dispatches.includes(glm), false);
    assert.equal(dispatches.some((model) => model.includes("kimi")), false);
    const [task] = await runtime.state.listTasks("deepseek-fallback-run");
    assert.equal(Object.isFrozen(task.assignmentSnapshot), false, "durable reads are copies of the immutable source snapshot");
    assert.deepEqual(task.assignmentSnapshot.fallbacks.map((entry) => entry.model), [sol, sonnet]);
    assert.equal(task.executionAttempts.length, 2);
    assert.equal(task.executionAttempts[0].state, "failed");
    assert.equal(task.executionAttempts[0].failure.failureClass, "RATE_LIMIT");
    assert.equal(task.executionAttempts[1].state, "dispatched");
    assert.notEqual(
      task.executionAttempts[0].executionBinding.bindingId,
      task.executionAttempts[1].executionBinding.bindingId,
    );
    assert.equal(task.executionBinding.model, sol);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("ambiguous dispatch never advances to a fallback route", async () => {
  const environment = fixture();
  try {
    const defaults = JSON.parse(readFileSync(new URL("../config/engineering-policy.defaults.json", import.meta.url), "utf8"));
    defaults.enabled = true;
    defaults.executionSelectionMode = "pinned";
    const deepseek = "kiro-prism/deepseek-v4.1-flash";
    const dispatches = [];
    const appServerExecutor = {
      async dispatch({ task }) {
        dispatches.push(task.executionBinding.model);
        throw new Error("connection ended before dispatch acknowledgement");
      },
      async inspect() { return { state: "unknown" }; },
      async cancel() { return { state: "unknown" }; },
    };
    const runtime = createEngineeringRuntime(options(environment, {
      policyReader: () => ({ status: "ok", degraded: false, enabled: true, revision: 7, policy: defaults }),
      routeAvailability: (route) => ({
        available: route.includes("deepseek") || route.includes("glm-5.3") || route.includes("gpt-6-sol") || route.includes("claude-sonnet-5"),
        provider: route.split("/")[0],
        capacityHost: route === deepseek ? "modal" : route.split("/")[0],
      }),
      appServerExecutor,
      nodeAdapter: undefined,
    }));
    const graph = compileSingle({
      task: { id: "debug", role: "debugger", objective: "Diagnose", ownedPaths: ["fallback.txt"] },
      verification: false,
      review: false,
    });
    const result = await runtime.runEngineeringWorkflow({
      runId: "ambiguous-no-fallback",
      policyRevision: 7,
      graph,
      requireLeadAcceptance: false,
      nodeTimeoutMs: 1,
    });
    assert.equal(result.accepted, false);
    assert.deepEqual(dispatches, [deepseek]);
    const [task] = await runtime.state.listTasks("ambiguous-no-fallback");
    assert.equal(task.dispatchOutcome, "unknown");
    assert.equal(task.executionAttempts.length, 1);
    assert.equal(task.executionAttempts[0].failure.requiresReconciliation, true);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});
