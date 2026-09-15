import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function waitFor(url, child, key) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${child.testErrors()}`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`forwarder did not become ready: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function controlledUpstream() {
  const state = {
    held: new Map(),
    maxActiveSockets: 0,
    requests: [],
    sockets: new Set(),
  };
  const socketIds = new WeakMap();
  let nextSocketId = 0;
  let activeSockets = 0;
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const input = typeof body.input === "string"
      ? body.input
      : body.messages?.at(-1)?.content || "";
    state.requests.push({
      authorization: request.headers.authorization,
      body,
      socketId: socketIds.get(request.socket),
      url: request.url,
    });
    if (input === "failover" && request.headers.authorization === "Bearer prism-default-key") {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    if (input.startsWith("hold-")) {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: input })}\n\n`,
      );
      state.held.set(input, response);
      return;
    }
    if (input === "queued") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "queued", status: "completed", output: [] } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "resp_pool", status: "completed", output: [] }));
  });
  server.on("connection", (socket) => {
    socketIds.set(socket, ++nextSocketId);
    state.sockets.add(socket);
    activeSockets += 1;
    state.maxActiveSockets = Math.max(state.maxActiveSockets, activeSockets);
    socket.once("close", () => {
      state.sockets.delete(socket);
      activeSockets -= 1;
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return Object.assign(state, { port: address.port, server });
}

test("Router reuses one bounded outbound pool across Prism API shapes, failover, and cancellation", async (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "router-prism-pool-"));
  const priorState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorStore = process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE;
  const priorAccounts = process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR;
  const priorPolicy = process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_POLICY;
  process.env.MODEL_ROUTER_STATE_DIR = state;
  process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(state, "provider-credentials.json");
  process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR = path.join(state, "accounts");
  process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_POLICY = path.join(state, "account-policy.json");

  const { apiProvider, writeProviderCredential } = await import("../src/provider-credentials.mjs");
  const { addProviderAccount } = await import("../src/provider-accounts.mjs");
  const prism = apiProvider("kiro-prism");
  writeProviderCredential(prism, "prism-default-key");
  addProviderAccount(prism, { value: "prism-backup-key", label: "backup" });
  writeProviderCredential(apiProvider("free-prism"), "free-prism-key");

  const prismUpstream = await controlledUpstream();
  const freePrismUpstream = await controlledUpstream();

  const port = await openPort();
  const internalKey = "router-prism-pool-test-internal-key";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_API_PORT: String(port),
      KIRO_PRISM_BASE_URL: `http://127.0.0.1:${prismUpstream.port}/v1`,
      FREEPRISM_BASE_URL: `http://127.0.0.1:${freePrismUpstream.port}/v1`,
      MODEL_ROUTER_UPSTREAM_CONNECTIONS: "2",
      NODE_USE_ENV_PROXY: "0",
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.testErrors = () => errors;

  t.after(async () => {
    for (const response of [...prismUpstream.held.values(), ...freePrismUpstream.held.values()]) {
      response.destroy();
    }
    await stopChild(child);
    for (const upstream of [prismUpstream, freePrismUpstream]) {
      for (const socket of upstream.sockets) socket.destroy();
      await new Promise((resolve) => upstream.server.close(resolve));
    }
    rmSync(state, { recursive: true, force: true });
    if (priorState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorState;
    if (priorStore === undefined) delete process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE;
    else process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = priorStore;
    if (priorAccounts === undefined) delete process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR;
    else process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR = priorAccounts;
    if (priorPolicy === undefined) delete process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_POLICY;
    else process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_POLICY = priorPolicy;
  });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const call = (route, body, options = {}) => fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalKey}`,
      "Content-Type": "application/json",
      "X-Codex-Router-Conversation": options.conversation || "pool-proof",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child, internalKey);

  let response = await call("/responses", { model: "kiro-prism-gpt-5-6-sol", input: "json" });
  assert.equal(response.status, 200, errors);
  await response.arrayBuffer();
  response = await call("/responses", { model: "kiro-prism-gpt-5-6-sol", input: "json-again" });
  assert.equal(response.status, 200, errors);
  await response.arrayBuffer();
  assert.ok(prismUpstream.requests.length >= 2);
  assert.equal(
    prismUpstream.requests[0].socketId,
    prismUpstream.requests[1].socketId,
    "Kiro Prism did not reuse its origin pool",
  );

  response = await call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "chat" }],
  });
  assert.equal(response.status, 200, errors);
  await response.arrayBuffer();
  response = await call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "chat again" }],
  });
  assert.equal(response.status, 200, errors);
  await response.arrayBuffer();
  assert.ok(freePrismUpstream.requests.length >= 2);
  assert.equal(
    freePrismUpstream.requests[0].socketId,
    freePrismUpstream.requests[1].socketId,
    "Free Prism did not reuse its origin pool",
  );

  response = await call("/responses", {
    model: "kiro-prism-gpt-5-6-sol",
    input: "failover",
  }, { conversation: "failover-proof" });
  assert.equal(response.status, 200, errors);
  await response.arrayBuffer();
  assert.deepEqual(
    prismUpstream.requests.slice(2, 4).map(({ authorization }) => authorization),
    ["Bearer prism-default-key", "Bearer prism-backup-key"],
  );
  assert.ok(prismUpstream.maxActiveSockets <= 2, "account failover escaped its origin pool bound");

  const firstAbort = new AbortController();
  const first = await call("/responses", {
    model: "kiro-prism-gpt-5-6-sol",
    input: "hold-one",
    stream: true,
  }, { conversation: "stream-one", signal: firstAbort.signal });
  assert.equal(first.status, 200);
  const firstReader = first.body.getReader();
  await firstReader.read();
  const second = await call("/responses", {
    model: "kiro-prism-gpt-5-6-sol",
    input: "hold-two",
    stream: true,
  }, { conversation: "stream-two" });
  assert.equal(second.status, 200);
  const secondReader = second.body.getReader();
  await secondReader.read();

  const queued = call("/responses", {
    model: "kiro-prism-gpt-5-6-sol",
    input: "queued",
    stream: true,
  }, { conversation: "stream-three" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    prismUpstream.requests.some(({ body }) => body.input === "queued"),
    false,
    "third stream bypassed pool bound",
  );
  assert.equal(prismUpstream.maxActiveSockets, 2);

  response = await call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "independent origin" }],
  });
  assert.equal(response.status, 200, "Kiro Prism saturation blocked the Free Prism origin");
  await response.arrayBuffer();

  firstAbort.abort();
  await assert.rejects(() => firstReader.read(), /abort|terminated|operation/iu);
  const third = await queued;
  assert.equal(third.status, 200, errors);
  await third.arrayBuffer();
  assert.equal(prismUpstream.requests.some(({ body }) => body.input === "queued"), true);
  assert.ok(
    prismUpstream.maxActiveSockets <= 2,
    `opened ${prismUpstream.maxActiveSockets} simultaneous Kiro Prism sockets`,
  );
  assert.ok(freePrismUpstream.maxActiveSockets <= 2);

  const freeFirstAbort = new AbortController();
  const freeFirst = await call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "hold-free-one" }],
    stream: true,
  }, { conversation: "free-stream-one", signal: freeFirstAbort.signal });
  assert.equal(freeFirst.status, 200);
  const freeFirstReader = freeFirst.body.getReader();
  await freeFirstReader.read();
  const freeSecond = await call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "hold-free-two" }],
    stream: true,
  }, { conversation: "free-stream-two" });
  assert.equal(freeSecond.status, 200);
  const freeSecondReader = freeSecond.body.getReader();
  await freeSecondReader.read();
  const freeQueued = call("/chat/completions", {
    model: "free-prism-minimax-m3",
    messages: [{ role: "user", content: "queued" }],
    stream: true,
  }, { conversation: "free-stream-three" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    freePrismUpstream.requests.some(({ body }) => body.messages?.at(-1)?.content === "queued"),
    false,
    "third Free Prism stream bypassed its pool bound",
  );
  assert.equal(freePrismUpstream.maxActiveSockets, 2);

  response = await call("/responses", {
    model: "kiro-prism-gpt-5-6-sol",
    input: "independent origin",
  }, { conversation: "kiro-independent" });
  assert.equal(response.status, 200, "Free Prism saturation blocked the Kiro Prism origin");
  await response.arrayBuffer();

  freeFirstAbort.abort();
  await assert.rejects(() => freeFirstReader.read(), /abort|terminated|operation/iu);
  const freeThird = await freeQueued;
  assert.equal(freeThird.status, 200, errors);
  await freeThird.arrayBuffer();
  assert.equal(
    freePrismUpstream.requests.some(({ body }) => body.messages?.at(-1)?.content === "queued"),
    true,
  );
  assert.ok(
    freePrismUpstream.maxActiveSockets <= 2,
    `opened ${freePrismUpstream.maxActiveSockets} simultaneous Free Prism sockets`,
  );

  prismUpstream.held.get("hold-two")?.end(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "held", status: "completed", output: [] } })}\n\ndata: [DONE]\n\n`,
  );
  await secondReader.cancel();
  freePrismUpstream.held.get("hold-free-two")?.end("data: [DONE]\n\n");
  await freeSecondReader.cancel();
});
