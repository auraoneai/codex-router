import { spawn } from "node:child_process";
import readline from "node:readline";

import { requireCodexBinary, spawnableCommand } from "../codex-binary.mjs";
import {
  bindExecutionIdentity,
  codexExecutionOverrides,
  validateExecutionBinding,
} from "./execution-binding.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const ENGINEERING_BINDING_HEADER = "x-codex-router-engineering-binding";
const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/cancelled"]);

export class AppServerProtocolError extends Error {
  constructor(message, { code, data, dispatched, responseReceived = false } = {}) {
    super(message);
    this.name = "AppServerProtocolError";
    this.code = code;
    this.data = data;
    this.dispatched = dispatched;
    this.responseReceived = responseReceived;
  }
}

export class AppServerTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`Codex app-server ${method} timed out after ${timeoutMs}ms.`);
    this.name = "AppServerTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.dispatched = true;
  }
}

export class StdioAppServerTransport {
  constructor({ binary, args = ["app-server", "--stdio"], cwd, env = process.env } = {}) {
    this.binary = binary || requireCodexBinary();
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.child = undefined;
    this.stderr = "";
  }

  start(onMessage, onFailure) {
    if (this.child) return;
    const target = spawnableCommand(this.binary, this.args);
    this.child = spawn(target.command, target.args, {
      ...target.options,
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        onMessage(JSON.parse(line));
      } catch {
        onFailure(new AppServerProtocolError("Codex app-server emitted malformed JSON."));
      }
    });
    this.child.once("error", onFailure);
    this.child.once("exit", (code, signal) => onFailure(new AppServerProtocolError(
      `Codex app-server exited before close (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
      { data: this.stderr ? { stderrCaptured: true, stderrBytes: Buffer.byteLength(this.stderr) } : undefined },
    )));
  }

  send(message) {
    if (!this.child?.stdin?.writable) {
      throw new AppServerProtocolError("Codex app-server transport is not writable.", { dispatched: false });
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill();
  }
}

export class CodexAppServerClient {
  constructor({ transport, timeoutMs = DEFAULT_TIMEOUT_MS, clientInfo } = {}) {
    if (!transport || typeof transport.start !== "function" || typeof transport.send !== "function") {
      throw new TypeError("A Codex app-server transport is required.");
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.clientInfo = clientInfo || {
      name: "codex_router_engineering",
      title: "Codex Router engineering scheduler",
      version: "1.0.0",
    };
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Set();
    this.started = false;
    this.initialized = false;
    this.initializing = undefined;
  }

  #fail(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #receive = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#fail(new AppServerProtocolError("Codex app-server emitted a non-object message."));
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new AppServerProtocolError(
          `Codex app-server ${entry.method} failed: ${String(message.error.message || "unknown error")}`,
          { code: message.error.code, data: message.error.data, dispatched: true, responseReceived: true },
        ));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.notifications) listener(message);
    }
  };

  async initialize() {
    if (this.initialized) return this.capabilities;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (!this.started) {
        this.started = true;
        this.transport.start(this.#receive, (error) => this.#fail(error));
      }
      const result = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.transport.send({ method: "initialized", params: {} });
      this.capabilities = result;
      this.initialized = true;
      return result;
    })();
    try {
      return await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof method !== "string" || !method) throw new TypeError("JSON-RPC method is required.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error && error.dispatched === undefined) error.dispatched = false;
        reject(error);
      }
    });
  }

  onNotification(listener) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  async close() {
    this.#fail(new AppServerProtocolError("Codex app-server client closed."));
    await this.transport.close?.();
  }
}

function requiredId(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required.`);
  return value;
}

function allowedOptions(options, allowed, name) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${name} options must be an object.`);
  }
  const unsupported = Object.keys(options).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`${name} options do not permit ${unsupported}.`);
  return options;
}

function threadSource(binding) {
  return `codex-router-engineering:${requiredId(binding.dispatchOperationId, "dispatchOperationId")}`;
}

function validatedThreadOptions(options) {
  return allowedOptions(
    options || {},
    ["baseInstructions", "developerInstructions", "personality", "serviceTier", "serviceName"],
    "thread/start",
  );
}

function dispatchFailure(error) {
  if (error?.dispatched === false) return { outcome: "not_dispatched", code: "transport_not_dispatched" };
  if (error instanceof AppServerProtocolError && error.responseReceived) {
    return { outcome: "rejected", code: "jsonrpc_rejected" };
  }
  if (error instanceof AppServerTimeoutError) return { outcome: "unknown", code: "timeout" };
  return { outcome: "unknown", code: "transport_or_protocol_unknown" };
}

export class CodexAppServerExecutor {
  constructor({ client, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!client) throw new TypeError("CodexAppServerExecutor requires a client.");
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  async discover() {
    return this.client.initialize();
  }

  async startThread(binding, options = {}) {
    validateExecutionBinding(binding);
    const safeOptions = validatedThreadOptions(options);
    const correlation = threadSource(binding);
    await this.discover();
    const routedProvider = binding.codexProvider === "codex-router";
    return this.client.request("thread/start", {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      ...safeOptions,
      cwd: binding.worktree,
      model: binding.model,
      modelProvider: binding.codexProvider,
      threadSource: correlation,
      ...(routedProvider
        ? {
            config: {
              model_providers: {
                [binding.codexProvider]: {
                  http_headers: {
                    [ENGINEERING_BINDING_HEADER]: binding.bindingId,
                  },
                },
              },
            },
          }
        : {}),
    });
  }

  async resumeThread(threadId, options = {}) {
    await this.discover();
    return this.client.request("thread/resume", { ...options, threadId: requiredId(threadId, "threadId") });
  }

  async readThread(threadId, options = {}) {
    await this.discover();
    return this.client.request("thread/read", { ...options, threadId: requiredId(threadId, "threadId") });
  }

  async listThreads(options = {}) {
    await this.discover();
    return this.client.request("thread/list", options);
  }

  async forkThread(threadId, options = {}) {
    await this.discover();
    return this.client.request("thread/fork", { ...options, threadId: requiredId(threadId, "threadId") });
  }

  async startTurn(binding, input, options = {}) {
    await this.discover();
    const threadId = requiredId(binding.threadId || binding.agentId, "threadId");
    const normalizedInput = typeof input === "string" ? [{ type: "text", text: input }] : input;
    if (!Array.isArray(normalizedInput) || normalizedInput.length === 0) {
      throw new TypeError("turn input must be a non-empty array or string.");
    }
    const overrides = codexExecutionOverrides(binding);
    const safeOptions = allowedOptions(
      options,
      ["outputSchema", "summary", "serviceTier", "serviceTierForTurn", "clientUserMessageId", "turnTrigger", "toolOutput", "threadId"],
      "turn/start",
    );
    return this.client.request("turn/start", {
      ...safeOptions,
      threadId,
      input: normalizedInput,
      model: overrides.model,
      cwd: overrides.cwd,
      ...(overrides.effort ? { effort: overrides.effort } : {}),
    });
  }

  async interruptTurn(threadId, turnId) {
    await this.discover();
    return this.client.request("turn/interrupt", {
      threadId: requiredId(threadId, "threadId"),
      turnId: requiredId(turnId, "turnId"),
    });
  }

  waitForTurn(threadId, turnId, { timeoutMs = this.timeoutMs } = {}) {
    requiredId(threadId, "threadId");
    requiredId(turnId, "turnId");
    return new Promise((resolve, reject) => {
      const unsubscribe = this.client.onNotification((message) => {
        if (!TERMINAL_TURN_METHODS.has(message.method)) return;
        const params = message.params || {};
        const observedThread = params.threadId || params.thread?.id;
        const observedTurn = params.turnId || params.turn?.id;
        if (observedThread !== threadId || observedTurn !== turnId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new AppServerTimeoutError("turn completion", timeoutMs));
      }, timeoutMs);
    });
  }

  async dispatch({ task, binding }) {
    const executionBinding = task.executionBinding || binding.executionBinding;
    if (!executionBinding) {
      const error = new Error("Dispatch requires an immutable executionBinding.");
      error.dispatched = false;
      throw error;
    }
    // Validate all caller-controlled thread options before app-server discovery or
    // dispatch. A local policy rejection must never be reported as an ambiguous
    // remote write.
    validateExecutionBinding(executionBinding);
    validatedThreadOptions(task.threadOptions);
    const correlation = threadSource(executionBinding);
    try {
      await this.discover();
    } catch (error) {
      error.dispatched = false;
      throw error;
    }
    let started;
    try {
      started = await this.startThread(executionBinding, task.threadOptions);
    } catch (error) {
      const failure = dispatchFailure(error);
      if (failure.outcome === "not_dispatched") throw error;
      return {
        state: "assigned",
        childId: null,
        threadId: null,
        turnId: null,
        threadStartOutcome: failure.outcome,
        threadStartErrorCode: failure.code,
        threadSource: correlation,
        dispatchOperationId: executionBinding.dispatchOperationId,
        executionBinding,
      };
    }
    const threadId = requiredId(started?.thread?.id, "thread result id");
    const withThread = bindExecutionIdentity(executionBinding, { agentId: threadId, threadId });
    let turn;
    try {
      turn = await this.startTurn(withThread, task.prompt || task.objective, { threadId });
    } catch (error) {
      const failure = dispatchFailure(error);
      return {
        state: "assigned",
        childId: threadId,
        threadId,
        turnId: null,
        turnStartOutcome: failure.outcome === "not_dispatched" ? "rejected" : failure.outcome,
        turnStartErrorCode: failure.code,
        executionBinding: withThread,
      };
    }
    const turnId = requiredId(turn?.turn?.id, "turn result id");
    return {
      state: "running",
      childId: threadId,
      threadId,
      turnId,
      executionBinding: bindExecutionIdentity(withThread, { agentId: threadId, threadId, turnId }),
    };
  }

  async inspect({ binding }) {
    const receipt = binding.dispatchReceipt || {};
    const threadId = receipt.threadId || binding.childId;
    if (!threadId) {
      if (receipt.threadStartOutcome === "rejected") {
        return { state: "stopped", reason: receipt.threadStartErrorCode || "thread_start_rejected" };
      }
      if (receipt.threadStartOutcome === "unknown" && receipt.threadSource) {
        try {
          const result = await this.listThreads({ limit: 100, sortDirection: "desc" });
          const candidates = (result?.data || result?.threads || []).filter((thread) => (
            thread?.threadSource === receipt.threadSource &&
            thread?.cwd === receipt.executionBinding?.worktree &&
            thread?.model === receipt.executionBinding?.model &&
            thread?.modelProvider === receipt.executionBinding?.codexProvider
          ));
          if (candidates.length === 1) {
            return {
              state: "stopped",
              reason: "thread_start_recovered_without_turn",
              childId: candidates[0].id,
              threadId: candidates[0].id,
            };
          }
        } catch {
          // A failed reconciliation preserves the unknown outcome. Retrying the
          // original non-idempotent thread/start would risk a duplicate writer.
        }
      }
      return { state: "unknown" };
    }
    if (receipt.turnStartOutcome === "rejected" && !receipt.turnId) {
      return { state: "stopped", reason: receipt.turnStartErrorCode || "turn_start_rejected" };
    }
    const result = await this.readThread(threadId, { includeTurns: true });
    const turns = result?.thread?.turns || [];
    const turn = receipt.turnId ? turns.find((item) => item.id === receipt.turnId) : turns.at(-1);
    if (!turn) return { state: "unknown" };
    if (["inProgress", "running"].includes(turn.status)) return { state: "running" };
    if (["completed", "succeeded"].includes(turn.status)) {
      return {
        state: "result",
        result: {
          attemptId: binding.attemptId,
          operationId: binding.operationId,
          fences: Object.fromEntries((binding.leases || []).map((lease) => [lease.scope, lease.fence])),
          turn,
        },
      };
    }
    if (["failed", "cancelled", "interrupted"].includes(turn.status)) {
      return { state: turn.status === "failed" ? "failed" : "stopped", reason: turn.error?.message };
    }
    return { state: "unknown" };
  }

  async cancel({ binding }) {
    const receipt = binding.dispatchReceipt || {};
    if (!receipt.threadId || !receipt.turnId) return { state: "unknown" };
    await this.interruptTurn(receipt.threadId, receipt.turnId);
    return { state: "cancelled" };
  }
}
