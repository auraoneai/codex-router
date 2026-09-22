import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { createExecutionBinding } from "../src/engineering/execution-binding.mjs";
import {
  createDurableSchedulerState,
  engineeringSchedulerStatePath,
} from "../src/engineering/scheduler-state-adapter.mjs";

const root = path.resolve(import.meta.dirname, "..");
const CALLER_KEY = "test-engineering-router-caller-capability-key";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`router exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("router did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000).unref();
  });
}

test("engineering control is caller-authenticated, bounded, strict, and CAS-updated", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "engineering-router-http-"));
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(port),
      CODEX_ROUTER_INTERNAL_KEY: "test-internal-key",
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_ENGINEERING_CONTROL_MAX_BODY_BYTES: "256",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const authenticated = `${callerBaseUrl(port, CALLER_KEY)}/engineering`;
  try {
    await waitFor(`${callerBaseUrl(port, CALLER_KEY)}/models`, child);

    const publicGet = await fetch(`http://127.0.0.1:${port}/v1/engineering`);
    assert.equal(publicGet.status, 401);
    const publicPatch = await fetch(`http://127.0.0.1:${port}/v1/engineering`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, enabled: true }),
    });
    assert.equal(publicPatch.status, 401);

    const initial = await fetch(authenticated);
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.enabled, false);
    assert.equal(initialBody.revision, 0);
    assert.equal("path" in initialBody, false);
    assert.equal(JSON.stringify(initialBody).includes(stateDir), false);

    const enabled = await fetch(authenticated, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, enabled: true }),
    });
    assert.equal(enabled.status, 200);
    const enabledBody = await enabled.json();
    assert.equal(enabledBody.enabled, true);
    assert.equal(enabledBody.revision, 1);

    const stale = await fetch(authenticated, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, enabled: false }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await fetch(authenticated).then((response) => response.json())).enabled, true);

    for (const body of ["{", "[]", JSON.stringify({ expectedRevision: 1, enabled: false, extra: true })]) {
      const rejected = await fetch(authenticated, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(rejected.status, 400, body);
    }

    const oversized = await fetch(authenticated, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, enabled: false, padding: "x".repeat(512) }),
    });
    assert.equal(oversized.status, 413);

    const publicHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal("engineering" in publicHealth, false);
  } finally {
    await stop(child);
    rmSync(stateDir, { recursive: true, force: true });
  }
  assert.doesNotMatch(stderr, new RegExp(CALLER_KEY));
});

test("an opaque current binding isolates effort, stays local, and correlates usage", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "engineering-router-binding-"));
  const worktree = path.join(stateDir, "worktree");
  const routerPort = await freePort();
  const gatewayPort = await freePort();
  const observed = [];
  let activeGatewayRequests = 0;
  let maxGatewayRequests = 0;
  const gateway = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    activeGatewayRequests += 1;
    maxGatewayRequests = Math.max(maxGatewayRequests, activeGatewayRequests);
    await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 10_000 : 40));
    activeGatewayRequests -= 1;
    const payload = Buffer.from(JSON.stringify({
      id: "resp_engineering_binding",
      object: "response",
      status: "completed",
      output: [{
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }));
    response.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
    response.end(payload);
  });
  await new Promise((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));

  writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "test-key\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "multi-agent-settings.json"), `${JSON.stringify({
    version: 2,
    mode: "all",
    enabled: [],
    disabled: [],
    efforts: { "opencode-go/glm-5.3": "max" },
  })}\n`, { mode: 0o600 });
  const executionBinding = createExecutionBinding({
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    dispatchOperationId: "dispatch-1",
    assignment: {
      agentType: "router_opencode_go_glm_5_3",
      model: "opencode-go/glm-5.3",
      provider: "opencode-go",
      family: "glm",
      requestedEffort: "high",
      effectiveEffort: "high",
      effortSource: "role",
    },
    role: "implementation",
    preset: "balanced",
    policyRevision: 1,
    attempt: 1,
    worktree,
    branch: "engineering/task-1",
    leaseToken: "lease-1",
  });
  const secondBinding = createExecutionBinding({
    runId: "run-1",
    taskId: "task-2",
    attemptId: "attempt-2",
    dispatchOperationId: "dispatch-2",
    assignment: {
      agentType: "router_opencode_go_glm_5_3",
      model: "opencode-go/glm-5.3",
      provider: "opencode-go",
      family: "glm",
      requestedEffort: "max",
      effectiveEffort: "max",
      effortSource: "attempt",
    },
    role: "reviewer",
    preset: "balanced",
    policyRevision: 1,
    attempt: 1,
    worktree: path.join(stateDir, "worktree-2"),
    branch: "engineering/task-2",
    leaseToken: "lease-2",
  });
  const durable = createDurableSchedulerState(engineeringSchedulerStatePath(stateDir));
  let task = await durable.putTask({
    taskId: "task-1",
    runId: "run-1",
    objective: "exercise scoped effort",
    sourceRevision: "source-abc",
    baseRevision: "source-abc",
    policyEnabledAtAssignment: true,
    executionBinding,
  });
  task = await durable.putTask({ taskId: "task-1", state: "ready" }, { expectedRevision: task.revision });
  await durable.claimAssignment({
    taskId: "task-1",
    expectedRevision: task.revision,
    binding: {
      attempt: 1,
      attemptId: "attempt-1",
      operationId: "dispatch-1",
      executionBinding,
    },
    scopes: [],
  });
  let secondTask = await durable.putTask({
    taskId: "task-2",
    runId: "run-1",
    objective: "exercise concurrent scoped effort",
    sourceRevision: "source-abc",
    baseRevision: "source-abc",
    policyEnabledAtAssignment: true,
    executionBinding: secondBinding,
  });
  secondTask = await durable.putTask(
    { taskId: "task-2", state: "ready" },
    { expectedRevision: secondTask.revision },
  );
  await durable.claimAssignment({
    taskId: "task-2",
    expectedRevision: secondTask.revision,
    binding: {
      attempt: 1,
      attemptId: "attempt-2",
      operationId: "dispatch-2",
      executionBinding: secondBinding,
    },
    scopes: [],
  });

  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_INTERNAL_KEY: "test-internal-key",
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const responsesUrl = `${callerBaseUrl(routerPort, CALLER_KEY)}/responses`;
  const turn = (headers, input = "go") => fetch(responsesUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openai-subagent": "child", ...headers },
    body: JSON.stringify({
      model: "opencode-go/glm-5.3",
      input,
      stream: false,
      reasoning: { effort: "low", summary: "auto" },
    }),
  });
  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, child);
    const [bound, second] = await Promise.all([
      turn({ "x-codex-router-engineering-binding": executionBinding.bindingId }, "bound-high"),
      turn({ "x-codex-router-engineering-binding": secondBinding.bindingId }, "bound-max"),
    ]);
    assert.equal(bound.status, 200, await bound.text());
    assert.equal(second.status, 200, await second.text());
    const legacy = await turn({});
    assert.equal(legacy.status, 200, await legacy.text());
    assert.equal(observed.length, 3);
    const byInput = Object.fromEntries(observed.map((entry) => [entry.body.input, entry]));
    assert.equal(byInput["bound-high"].body.reasoning?.effort, "high");
    assert.equal(byInput["bound-high"].body.reasoning_effort, "high");
    assert.equal(byInput["bound-max"].body.reasoning?.effort, "max");
    assert.equal(byInput.go.body.reasoning?.effort, "max");
    assert.equal(maxGatewayRequests, 2, "the two task-scoped requests did not overlap");
    assert.ok(observed.every((entry) => entry.headers["x-codex-router-engineering-binding"] === undefined));

    const usagePath = path.join(stateDir, "usage-events.jsonl");
    for (let attempt = 0; attempt < 50 && !existsSync(usagePath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const usage = readFileSync(usagePath, "utf8").trim().split("\n").map(JSON.parse);
    const correlated = usage.find((event) => event.engineering?.bindingId === executionBinding.bindingId);
    assert.equal(correlated.engineering.runId, "run-1");
    assert.equal(correlated.engineering.taskId, "task-1");
    assert.deepEqual(correlated.engineering.usage.inputTokens, { kind: "measured", value: 5 });
    assert.deepEqual(correlated.engineering.usage.outputTokens, { kind: "measured", value: 2 });
    assert.ok(usage.some((event) => event.engineering?.bindingId === secondBinding.bindingId));
    const status = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/engineering`)
      .then((response) => response.json());
    assert.equal(status.usage.requests, 2);
    assert.equal(status.usage.fields.inputTokens.measured, 10);
    assert.equal(status.usage.fields.costMicros.unknown, 2);

    const unknown = await turn({ "x-codex-router-engineering-binding": "binding-unknown000" });
    assert.equal(unknown.status, 409);
    assert.equal(observed.length, 3, "an unresolved binding reached the provider");
  } finally {
    await stop(child);
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
  assert.doesNotMatch(stderr, /test-key|x-codex-router-engineering-binding/u);
});
