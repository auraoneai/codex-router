import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  AppServerProtocolError,
  AppServerTimeoutError,
  CodexAppServerClient,
  CodexAppServerExecutor,
} from "../src/engineering/codex-executor.mjs";
import { bindExecutionIdentity, createExecutionBinding } from "../src/engineering/execution-binding.mjs";

class FakeTransport {
  constructor(handler) {
    this.handler = handler;
    this.sent = [];
  }
  start(onMessage, onFailure) {
    this.onMessage = onMessage;
    this.onFailure = onFailure;
  }
  send(message) {
    this.sent.push(structuredClone(message));
    this.handler?.(message, this);
  }
  reply(id, result) { queueMicrotask(() => this.onMessage({ id, result })); }
  notify(method, params) { this.onMessage({ method, params }); }
  close() {}
}

function testBinding() {
  return createExecutionBinding({
    runId: "run-1", taskId: "task-1", attemptId: "attempt-1",
    dispatchOperationId: "dispatch-1", role: "complex_coder", preset: "balanced",
    policyRevision: 1, attempt: 1, worktree: "/tmp/worktree", branch: "task-1",
    leaseToken: "lease-1",
    assignment: {
      agentType: "router_kiro_prism_claude_sonnet_5",
      model: "kiro-prism/claude-sonnet-5", provider: "kiro-prism", family: "claude",
      requestedEffort: "high", effectiveEffort: "high", effortSource: "role",
    },
  });
}

test("app-server executor initializes once and binds start/turn lifecycle parameters", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, { serverInfo: { version: "test" } });
    if (message.method === "thread/start") fake.reply(message.id, { thread: { id: "thread-1" } });
    if (message.method === "turn/start") fake.reply(message.id, { turn: { id: "turn-1", status: "inProgress" } });
    if (message.method === "thread/read") fake.reply(message.id, { thread: { id: "thread-1", turns: [] } });
    if (message.method === "thread/list") fake.reply(message.id, { data: [] });
    if (message.method === "thread/resume" || message.method === "thread/fork") {
      fake.reply(message.id, { thread: { id: message.params.threadId } });
    }
    if (message.method === "turn/interrupt") fake.reply(message.id, {});
  });
  const client = new CodexAppServerClient({ transport, timeoutMs: 200 });
  const executor = new CodexAppServerExecutor({ client, timeoutMs: 200 });
  const binding = testBinding();
  const receipt = await executor.dispatch({
    task: { objective: "Implement the bounded change.", executionBinding: binding },
    binding: {},
  });
  assert.equal(receipt.threadId, "thread-1");
  assert.equal(receipt.turnId, "turn-1");
  const starts = transport.sent.filter((message) => message.method === "thread/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.model, "kiro-prism/claude-sonnet-5");
  assert.equal(starts[0].params.modelProvider, "codex-router");
  assert.equal(starts[0].params.threadSource, "codex-router-engineering:dispatch-1");
  assert.equal(
    starts[0].params.config.model_providers["codex-router"].http_headers["x-codex-router-engineering-binding"],
    binding.bindingId,
  );
  assert.equal(starts[0].params.cwd, path.resolve("/tmp/worktree"));
  assert.equal(starts[0].params.effort, undefined);
  const turn = transport.sent.find((message) => message.method === "turn/start");
  assert.equal(turn.params.effort, "high");
  assert.equal(turn.params.cwd, path.resolve("/tmp/worktree"));
  assert.equal(turn.params.threadId, "thread-1");
  assert.equal(transport.sent.filter((message) => message.method === "initialize").length, 1);

  await Promise.all([executor.discover(), executor.discover()]);
  assert.equal(transport.sent.filter((message) => message.method === "initialize").length, 1);

  await executor.resumeThread("thread-1", { excludeTurns: true });
  await executor.readThread("thread-1", { includeTurns: false });
  await executor.listThreads({ limit: 10 });
  await executor.forkThread("thread-1", { ephemeral: true });
  await executor.interruptTurn("thread-1", "turn-1");
  assert.deepEqual(
    transport.sent.filter((message) => message.id).slice(-5).map((message) => message.method),
    ["thread/resume", "thread/read", "thread/list", "thread/fork", "turn/interrupt"],
  );
});

test("turn completion waits for the exact thread and turn", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
  });
  const client = new CodexAppServerClient({ transport, timeoutMs: 200 });
  const executor = new CodexAppServerExecutor({ client, timeoutMs: 200 });
  await executor.discover();
  const pending = executor.waitForTurn("thread-1", "turn-1");
  transport.notify("turn/completed", { threadId: "thread-other", turn: { id: "turn-1" } });
  transport.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
  assert.equal((await pending).method, "turn/completed");
});

test("request timeout and JSON-RPC errors preserve ambiguous dispatch semantics", async () => {
  const silent = new FakeTransport();
  silent.start = function start(onMessage, onFailure) { this.onMessage = onMessage; this.onFailure = onFailure; };
  const client = new CodexAppServerClient({ transport: silent, timeoutMs: 5 });
  await assert.rejects(client.initialize(), AppServerTimeoutError);

  const rejected = new FakeTransport((message, fake) => {
    queueMicrotask(() => fake.onMessage({ id: message.id, error: { code: -32602, message: "bad params" } }));
  });
  const rejectedClient = new CodexAppServerClient({ transport: rejected, timeoutMs: 100 });
  await assert.rejects(
    rejectedClient.initialize(),
    (error) => error instanceof AppServerProtocolError && error.code === -32602 && error.dispatched === true,
  );
});

test("dispatch preserves a created thread when turn start is rejected or ambiguous", async () => {
  const rejectedTransport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
    if (message.method === "thread/start") fake.reply(message.id, { thread: { id: "thread-kept" } });
    if (message.method === "turn/start") {
      queueMicrotask(() => fake.onMessage({ id: message.id, error: { code: -32602, message: "bad turn" } }));
    }
    if (message.method === "thread/read") fake.reply(message.id, { thread: { id: "thread-kept", turns: [] } });
  });
  const rejectedExecutor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport: rejectedTransport, timeoutMs: 100 }), timeoutMs: 100,
  });
  const rejected = await rejectedExecutor.dispatch({
    task: { objective: "work", executionBinding: testBinding() }, binding: {},
  });
  assert.equal(rejected.threadId, "thread-kept");
  assert.equal(rejected.turnStartOutcome, "rejected");
  assert.deepEqual(
    await rejectedExecutor.inspect({ binding: { childId: "thread-kept", dispatchReceipt: rejected } }),
    { state: "stopped", reason: "jsonrpc_rejected" },
  );

  const timeoutTransport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
    if (message.method === "thread/start") fake.reply(message.id, { thread: { id: "thread-unknown" } });
  });
  const timeoutExecutor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport: timeoutTransport, timeoutMs: 5 }), timeoutMs: 5,
  });
  const ambiguous = await timeoutExecutor.dispatch({
    task: { objective: "work", executionBinding: testBinding() }, binding: {},
  });
  assert.equal(ambiguous.threadId, "thread-unknown");
  assert.equal(ambiguous.turnStartOutcome, "unknown");

  const threadTimeoutExecutor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport: new FakeTransport((message, fake) => {
      if (message.method === "initialize") fake.reply(message.id, {});
    }), timeoutMs: 5 }), timeoutMs: 5,
  });
  const threadAmbiguous = await threadTimeoutExecutor.dispatch({
    task: { objective: "work", executionBinding: testBinding() }, binding: {},
  });
  assert.equal(threadAmbiguous.threadId, null);
  assert.equal(threadAmbiguous.threadStartOutcome, "unknown");
  assert.equal(threadAmbiguous.dispatchOperationId, "dispatch-1");
});

test("turn start preserves the immutable bound effort after thread identity is attached", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
    if (message.method === "turn/start") fake.reply(message.id, { turn: { id: "turn-2" } });
  });
  const executor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport, timeoutMs: 100 }), timeoutMs: 100,
  });
  const binding = bindExecutionIdentity(testBinding(), { agentId: "thread-2", threadId: "thread-2" });
  await assert.rejects(executor.startTurn(binding, "Continue.", { model: "attacker-model" }), /do not permit model/);
  await assert.rejects(executor.startThread(binding, { sandbox: "danger-full-access" }), /do not permit sandbox/);
  await executor.startTurn(binding, "Continue.");
  const request = transport.sent.find((message) => message.method === "turn/start");
  assert.equal(request.params.model, binding.model);
  assert.equal(request.params.effort, binding.effectiveEffort);
  assert.equal(request.params.cwd, binding.worktree);
  assert.equal(request.params.threadId, binding.threadId);
});

test("dispatch rejects forbidden thread options before any thread write", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
  });
  const executor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport, timeoutMs: 100 }), timeoutMs: 100,
  });
  await assert.rejects(executor.dispatch({
    task: {
      objective: "work",
      executionBinding: testBinding(),
      threadOptions: { sandbox: "danger-full-access" },
    },
    binding: {},
  }), /do not permit sandbox/);
  assert.equal(transport.sent.some((message) => message.method === "thread\/start"), false);
});

test("ambiguous thread start reconciles by the app-server-visible thread source", async () => {
  const source = "codex-router-engineering:dispatch-1";
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.reply(message.id, {});
    if (message.method === "thread/list") fake.reply(message.id, { data: [{
      id: "thread-recovered",
      threadSource: source,
      cwd: executionBinding.worktree,
      model: "kiro-prism/claude-sonnet-5",
      modelProvider: "codex-router",
    }] });
  });
  const executor = new CodexAppServerExecutor({
    client: new CodexAppServerClient({ transport, timeoutMs: 100 }), timeoutMs: 100,
  });
  const executionBinding = testBinding();
  const result = await executor.inspect({ binding: { dispatchReceipt: {
    threadId: null,
    threadStartOutcome: "unknown",
    threadSource: source,
    executionBinding,
  } } });
  assert.deepEqual(result, {
    state: "stopped",
    reason: "thread_start_recovered_without_turn",
    childId: "thread-recovered",
    threadId: "thread-recovered",
  });
});
