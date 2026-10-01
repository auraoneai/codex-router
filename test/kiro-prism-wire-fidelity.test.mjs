import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl, claudeBaseUrl } from "../src/caller-auth.mjs";
import { handleClaudeRequest } from "../src/claude-surface.mjs";
import { openPort } from "./port-pool.mjs";

// Wire fidelity for Kiro Prism routes (RSN-1, CLI-6, CLI-7): signed reasoning
// and thinking must reach Prism byte-identical, and Codex's tool_search control
// must reach Prism natively because Prism relays it itself.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const PRISM_SIGNATURE = `prism-kiro-sig:${"A".repeat(120)}`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(body.length) });
  response.end(body);
}

function spawnChild(script, env) {
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

// One router in front of a recording gateway. Every request gets an empty
// assistant answer; the tests only inspect what the router sent.
async function routerWithGateway(run) {
  const gatewayBodies = [];
  const gateway = http.createServer(async (request, response) => {
    gatewayBodies.push(JSON.parse(await readBody(request)));
    json(response, 200, { output: [{ type: "message", role: "assistant", content: "ok" }] });
  });
  const gatewayPort = await listen(gateway);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "kiro-prism-fidelity-"));
  const routerPort = await openPort();
  const router = spawnChild("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const base = callerBaseUrl(routerPort, CALLER_KEY);
  try {
    await waitFor(`${base}/models`, router);
    const send = async (payload) => {
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream: false, ...payload }),
      });
      assert.equal(response.status, 200, `${await response.text()}\n${router.testErrors()}`);
      return gatewayBodies.at(-1);
    };
    await run(send);
  } finally {
    await stopChild(router);
    await closeServer(gateway);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const signedReasoning = (id, text) => ({
  type: "reasoning",
  id,
  summary: [{ type: "summary_text", text }],
  encrypted_content: `${PRISM_SIGNATURE}${id}`,
});

function toolLoopInput() {
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: "check the log" }] },
    signedReasoning("rs_1", "The log lives under /var/log."),
    { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "nothing unusual" },
    signedReasoning("rs_2", "Nothing in the tail looks wrong, so I can say so."),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "All clear." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
  ];
}

const textOf = (item) => (Array.isArray(item?.content) ? item.content : [])
  .map((part) => (typeof part?.text === "string" ? part.text : ""))
  .join("\n");

test("RSN-1: Kiro Prism receives signed reasoning byte-identical and never as duplicated prose", async () => {
  await routerWithGateway(async (send) => {
    const input = toolLoopInput();
    const forwarded = (await send({ model: "kiro-prism/claude-opus-5.5", input })).input;

    // A signed reasoning item before a function_call is forwarded unchanged,
    // ciphertext and all, and still sits immediately before its call.
    const callIndex = forwarded.findIndex((item) => item?.type === "function_call");
    assert.equal(JSON.stringify(forwarded[callIndex - 1]), JSON.stringify(input[1]));
    assert.ok(forwarded[callIndex - 1].encrypted_content.startsWith("prism-kiro-sig:"));

    // The reasoning before the assistant answer is forwarded unchanged, and the
    // answer is not given a copy of it.
    const answer = forwarded.find((item) => item?.role === "assistant" && /All clear\./.test(textOf(item)));
    assert.equal(JSON.stringify(answer), JSON.stringify(input[5]));
    assert.equal(JSON.stringify(forwarded[forwarded.indexOf(answer) - 1]), JSON.stringify(input[4]));

    // No reasoning text leaked into any visible message.
    for (const item of forwarded) {
      if (item?.type === "reasoning") continue;
      assert.doesNotMatch(textOf(item), /The log lives under|Nothing in the tail looks wrong/);
    }
    assert.equal(forwarded.filter((item) => item?.type === "reasoning").length, 2);
  });
});

test("RSN-1: Chat-completions routes still carry reasoning onto the assistant turn", async () => {
  await routerWithGateway(async (send) => {
    const forwarded = (await send({ model: "deepseek/deepseek-v4-pro", input: toolLoopInput() })).input;
    const callIndex = forwarded.findIndex((item) => item?.type === "function_call");
    const beforeCall = forwarded[callIndex - 1];
    assert.equal(beforeCall.type, "message");
    assert.equal(beforeCall.role, "assistant");
    assert.match(textOf(beforeCall), /The log lives under \/var\/log\./);
    const answer = forwarded.find((item) => item?.role === "assistant" && /All clear\./.test(textOf(item)));
    assert.match(textOf(answer), /Nothing in the tail looks wrong/);
    assert.equal(forwarded.some((item) => item?.type === "reasoning"), false);
  });
});

const TOOL_SEARCH = {
  type: "tool_search",
  execution: "client",
  description: "Search deferred tools.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

test("CLI-7: every Kiro Prism model declares native tool_search support", () => {
  const { models } = JSON.parse(readFileSync(path.join(root, "config/kiro-prism/models.json"), "utf8"));
  assert.ok(models.length > 0);
  for (const model of models) assert.equal(model.supportsToolSearch, true, model.slug);
});

test("CLI-7: Kiro Prism receives tool_search natively; an undeclared Responses route is still relayed", async () => {
  await routerWithGateway(async (send) => {
    const tools = [TOOL_SEARCH, { type: "function", name: "exec_command", parameters: { type: "object" } }];
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "find the github tool" }] },
      { type: "tool_search_call", call_id: "search_1", execution: "client", arguments: { query: "github" } },
      {
        type: "tool_search_output",
        call_id: "search_1",
        execution: "client",
        status: "completed",
        tools: [{ type: "function", name: "fetch_issue", parameters: { type: "object" } }],
      },
    ];
    const prism = await send({ model: "kiro-prism/claude-opus-5.5", input, tools });
    assert.deepEqual(prism.tools.find((tool) => tool?.type === "tool_search"), TOOL_SEARCH);
    assert.ok(prism.input.some((item) => item?.type === "tool_search_call"));
    assert.ok(prism.input.some((item) => item?.type === "tool_search_output"));

    const relayed = await send({ model: "meta/muse-spark-1.2", input, tools });
    assert.equal(relayed.tools.some((tool) => tool?.type === "tool_search"), false);
    assert.equal(relayed.input.some((item) => item?.type === "tool_search_call"), false);
  });
});

// --- CLI-6: Claude Code -> Prism /v1/messages passthrough -------------------

const signedThinkingBody = (model) => ({
  model,
  max_tokens: 1024,
  stream: true,
  thinking: { type: "adaptive" },
  messages: [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should run ls.", signature: PRISM_SIGNATURE },
        { type: "redacted_thinking", data: "opaque-redacted-bytes" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }],
    },
  ],
});

const MESSAGES_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5.5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"prism-kiro-sig:NEXT"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

test("CLI-6: the Claude surface forwards a passthrough route's body and stream unchanged", async () => {
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    seen.push({ url: request.url, headers: request.headers, body: await readBody(request) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(MESSAGES_SSE);
  });
  const upstreamPort = await listen(upstream);
  const passthroughCalls = [];
  const surface = http.createServer((request, response) => {
    const route = new URL(request.url, `http://${request.headers.host}`).pathname;
    handleClaudeRequest(request, response, route, {
      responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
      routedModels: () => ({ models: [
        { slug: "kiro-prism/claude-opus-5.5", displayName: "Opus" },
        { slug: "openai/gpt-test", displayName: "GPT" },
      ] }),
      messagesPassthrough: (slug, context) => {
        passthroughCalls.push({ slug, context });
        return slug.startsWith("kiro-prism/")
          ? { url: `http://127.0.0.1:${upstreamPort}/v1/messages`, model: "kiro-prism-claude-opus-5-5", headers: { "x-hop": "1" } }
          : undefined;
      },
    });
  });
  const surfacePort = await listen(surface);
  try {
    const body = signedThinkingBody("codex_router/anthropic/kiro-prism/claude-opus-5.5");
    const response = await fetch(`http://127.0.0.1:${surfacePort}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), MESSAGES_SSE, "the upstream stream is relayed byte-for-byte");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/messages");
    assert.equal(seen[0].headers["x-hop"], "1");
    assert.equal(seen[0].headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
    const forwarded = JSON.parse(seen[0].body);
    assert.equal(forwarded.model, "kiro-prism-claude-opus-5-5");
    assert.deepEqual(forwarded.messages, body.messages, "thinking blocks and signatures round-trip unchanged");
    assert.deepEqual(forwarded.thinking, body.thinking);
    assert.deepEqual(passthroughCalls[0], {
      slug: "kiro-prism/claude-opus-5.5",
      context: { sessionId: "11111111-2222-3333-4444-555555555555" },
    });

    // A model with no passthrough keeps the canonical Responses conversion.
    await fetch(`http://127.0.0.1:${surfacePort}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, model: "codex_router/anthropic/openai/gpt-test", stream: false }),
    }).then((r) => r.text());
    assert.equal(seen.at(-1).url, "/v1/responses");
  } finally {
    await closeServer(surface);
    await closeServer(upstream);
  }
});

test("CLI-6: router and forwarder deliver a Claude Code kiro-prism turn to Prism /v1/messages intact", async () => {
  const prismRequests = [];
  const prism = http.createServer(async (request, response) => {
    prismRequests.push({ url: request.url, headers: request.headers, body: await readBody(request) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(MESSAGES_SSE);
  });
  const prismPort = await listen(prism);
  const gatewayHits = [];
  const gateway = http.createServer((request, response) => {
    gatewayHits.push(request.url);
    response.writeHead(503);
    response.end("Claude Code kiro-prism turns must not reach LiteLLM");
  });
  const gatewayPort = await listen(gateway);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "kiro-prism-messages-"));
  writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["kiro-prism"] }));
  writeFileSync(path.join(stateDir, "kiro-prism-api-key.secret"), "TEST_PRISM_KEY\n", { mode: 0o600 });
  const routerPort = await openPort();
  const forwarderPort = await openPort();
  const env = {
    HOME: stateDir,
    CODEX_HOME: path.join(stateDir, "codex"),
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_DISABLE_DISCOVERY: "1",
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    KIRO_PRISM_BASE_URL: `http://127.0.0.1:${prismPort}/v1`,
    PRISM_API_KEY: "TEST_PRISM_KEY",
    KIRO_PRISM_API_KEY: "TEST_PRISM_KEY",
  };
  const children = ["api-forwarder.mjs", "router.mjs"].map((script) => spawnChild(script, env));
  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, children[0], { Authorization: `Bearer ${INTERNAL_KEY}` })
      .catch(async (error) => {
        // The forwarder's health turns 503 while a provider is unconfigured;
        // listening is enough here.
        if (!/Timed out/.test(String(error))) throw error;
      });
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, children[1]);
    const body = signedThinkingBody("codex_router/anthropic/kiro-prism/claude-opus-5.5");
    const response = await fetch(`${claudeBaseUrl(routerPort, CALLER_KEY)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${text}\n${children.map((c) => c.testErrors()).join("\n")}`);
    assert.equal(text, MESSAGES_SSE);
    assert.deepEqual(gatewayHits, []);
    assert.equal(prismRequests.length, 1);
    assert.equal(prismRequests[0].url, "/v1/messages");
    assert.equal(prismRequests[0].headers.authorization, "Bearer TEST_PRISM_KEY");
    assert.equal(prismRequests[0].headers["anthropic-version"], "2023-06-01");
    const forwarded = JSON.parse(prismRequests[0].body);
    assert.equal(forwarded.model, "claude-opus-5.5");
    assert.deepEqual(forwarded.messages, body.messages);
  } finally {
    await Promise.all(children.map(stopChild));
    await closeServer(prism);
    await closeServer(gateway);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
