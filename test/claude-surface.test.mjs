import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  claudeMessagesToResponses,
  handleClaudeRequest,
} from "../src/claude-surface.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

function routedModels() {
  return {
    engine: "test",
    models: [
      { slug: "openai/gpt-test", displayName: "GPT Test", priority: 10 },
      { slug: "deepseek/test", displayName: "DeepSeek Test", priority: 5 },
    ],
  };
}

async function fixture(handler, customRoutedModels = routedModels) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const surface = http.createServer((request, response) => {
    const route = new URL(request.url, `http://${request.headers.host}`).pathname;
    handleClaudeRequest(request, response, route, {
      responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
      routedModels: customRoutedModels,
    });
  });
  const surfacePort = await listen(surface);
  return {
    baseUrl: `http://127.0.0.1:${surfacePort}/anthropic`,
    close: () => Promise.all([close(surface), close(upstream)]),
  };
}

test("Claude Code discovers the complete routed catalog under Anthropic-shaped ids", async () => {
  const app = await fixture((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  try {
    const hello = await fetch(`${app.baseUrl}/api/hello`, { method: "HEAD" });
    assert.equal(hello.status, 200);
    const catalog = await fetch(`${app.baseUrl}/v1/models?limit=1000`).then((response) => response.json());
    assert.deepEqual(catalog.data.map((model) => model.id), [
      "codex_router/anthropic/openai/gpt-test",
      "codex_router/anthropic/deepseek/test",
    ]);
    assert.equal(catalog.has_more, false);
  } finally {
    await app.close();
  }
});

test("Anthropic Messages requests re-enter the canonical Responses path with tools intact", async () => {
  let received;
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_2", name: "write_file", arguments: '{"path":"b"}' }],
      usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
    }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 512,
        system: [{ type: "text", text: "Be precise." }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
        ],
        tools: [{ name: "write_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(received.model, "openai/gpt-test");
    assert.equal(received.instructions, "Be precise.");
    assert.deepEqual(received.input.slice(0, 2), [
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
    assert.equal(received.tools[0].name, "write_file");
    assert.equal(body.type, "message");
    assert.equal(body.stop_reason, "tool_use");
    assert.equal(body.content[0].name, "write_file");
  } finally {
    await app.close();
  }
});

test("Claude Code cannot request an unselected model", async () => {
  let calls = 0;
  const app = await fixture((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: [] }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex_router/anthropic/not/selected", max_tokens: 1, messages: [] }),
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("streaming emits Anthropic message events and terminates cleanly", async () => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "resp_stream" } },
      { type: "response.output_text.delta", item_id: "msg", delta: "hello" },
      { type: "response.output_text.done", item_id: "msg", text: "hello" },
      { type: "response.completed", response: { output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const stream = await response.text();
    assert.match(stream, /event: message_start/);
    assert.match(stream, /event: content_block_delta/);
    assert.match(stream, /"text":"hello"/);
    assert.match(stream, /event: message_delta/);
    assert.match(stream, /event: message_stop/);
    assert.equal((stream.match(/event: message_stop/g) || []).length, 1);
  } finally {
    await app.close();
  }
});

test("tool and image blocks map to the canonical request shape", () => {
  const converted = claudeMessagesToResponses({
    model: "codex_router/anthropic/deepseek/test",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ],
    }],
  });
  assert.equal(converted.model, "deepseek/test");
  assert.equal(converted.input[0].content[1].image_url, "data:image/png;base64,AA==");
});

test("429 pool exhaustion upstream error translates cleanly to Claude Code rate_limit_error with earliest reset message preserved", async () => {
  const exhaustionMessage = "All 3 Claude accounts in the pool are currently unavailable (3 quota-exhausted, 0 auth invalid, 0 cooling). Earliest quota reset: 2026-09-24T23:59:00.000Z.";
  const app = await fixture((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        type: "claude_account_pool_exhausted",
        message: exhaustionMessage,
        param: null,
        code: "pool_exhausted",
      },
    }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.message, exhaustionMessage);
  } finally {
    await app.close();
  }
});

test("503 pool exhaustion upstream error translates cleanly to Claude Code rate_limit_error with earliest reset message preserved", async () => {
  const exhaustionMessage = "All 2 Claude accounts in the pool are currently unavailable (2 quota-exhausted, 0 auth invalid, 0 cooling). Earliest quota reset: 2026-09-25T02:00:00.000Z.";
  const app = await fixture((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        type: "claude_account_pool_exhausted",
        message: exhaustionMessage,
        code: "pool_exhausted",
      },
    }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.message, exhaustionMessage);
  } finally {
    await app.close();
  }
});

test("streaming pool exhaustion error event is translated to Claude Code rate_limit_error", async () => {
  const exhaustionMessage = "All 2 Claude accounts in the pool are currently unavailable (2 quota-exhausted, 0 auth invalid, 0 cooling). Earliest quota reset: 2026-09-25T01:00:00.000Z.";
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "error",
      error: {
        type: "claude_account_pool_exhausted",
        message: exhaustionMessage,
      },
    })}\n\n`);
    response.end();
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const stream = await response.text();
    assert.match(stream, /event: error/);
    assert.match(stream, /"type":"rate_limit_error"/);
    assert.match(stream, /Earliest quota reset: 2026-09-25T01:00:00\.000Z\./);
  } finally {
    await app.close();
  }
});

test("model listing and count_tokens keep working when pool-served", async () => {
  function poolServedModels() {
    return {
      engine: "test",
      models: [
        { slug: "anthropic-api/claude-opus-4.8", displayName: "Claude Opus 4.8", priority: 10 },
        { slug: "anthropic-api/claude-sonnet-4.6", displayName: "Claude Sonnet 4.6", priority: 20 },
      ],
    };
  }
  const app = await fixture((_request, response) => {
    response.writeHead(500);
    response.end();
  }, poolServedModels);
  try {
    // Model listing
    const catalog = await fetch(`${app.baseUrl}/v1/models`).then((r) => r.json());
    assert.deepEqual(catalog.data.map((m) => m.id), [
      "codex_router/anthropic/anthropic-api/claude-opus-4.8",
      "codex_router/anthropic/anthropic-api/claude-sonnet-4.6",
    ]);

    // count_tokens does not touch credentials or make upstream network calls
    const countRes = await fetch(`${app.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/anthropic-api/claude-opus-4.8",
        messages: [{ role: "user", content: "Hello world, count my tokens." }],
      }),
    });
    assert.equal(countRes.status, 200);
    const countBody = await countRes.json();
    assert.equal(typeof countBody.input_tokens, "number");
    assert.ok(countBody.input_tokens > 0);
  } finally {
    await app.close();
  }
});

test("every Kiro rung survives the Claude bridge and thinking is never switched off", async () => {
  const { claudeMessagesToResponses } = await import("../src/claude-surface.mjs");
  const base = { model: "kiro-prism/claude-opus-5.5", messages: [{ role: "user", content: "hi" }] };
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const out = claudeMessagesToResponses({ ...base, output_config: { effort } });
    assert.equal(out.reasoning.effort, effort);
  }
  // disabled thinking and a "none" effort are unspecified: no effort is sent.
  const none = claudeMessagesToResponses({ ...base, output_config: { effort: "none" } });
  assert.equal(none.reasoning, undefined);
  const disabled = claudeMessagesToResponses({ ...base, thinking: { type: "disabled" } });
  assert.equal(disabled.reasoning, undefined);
  const disabledWithEffort = claudeMessagesToResponses({ ...base, thinking: { type: "disabled" }, output_config: { effort: "high" } });
  assert.deepEqual(disabledWithEffort.reasoning, { effort: "high", summary: "auto" });
  // bare adaptive thinking leaves effort to Prism's default.
  const adaptive = claudeMessagesToResponses({ ...base, thinking: { type: "adaptive" } });
  assert.deepEqual(adaptive.reasoning, { summary: "auto" });
  const adaptiveOmitted = claudeMessagesToResponses({ ...base, thinking: { type: "adaptive", display: "omitted" } });
  assert.equal(adaptiveOmitted.reasoning, undefined);
  const omitted = claudeMessagesToResponses({ ...base, thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "max" } });
  assert.deepEqual(omitted.reasoning, { effort: "max" });
  for (const out of [none, disabled, disabledWithEffort, adaptive, adaptiveOmitted, omitted]) {
    assert.notEqual(out.reasoning?.effort, "none");
  }
});
