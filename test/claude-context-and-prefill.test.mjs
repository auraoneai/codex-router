import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { applyPromptCacheBreakpoints, endMessagesOnUserTurn } from "../src/anthropic-messages-shape.mjs";
import { claudeRouterEnvironment } from "../src/claude-code-launcher.mjs";
import { claudeCodeModelId, claudeRoutedSlug } from "../src/claude-model-id.mjs";
import { claudeMessagesToResponses, handleClaudeRequest } from "../src/claude-surface.mjs";

const OPUS = "codex_router/anthropic/anthropic-api/claude-opus-5.5";

test("only 1M-window Claude-family models carry Claude Code's [1m] marker", () => {
  assert.equal(
    claudeCodeModelId({ slug: "anthropic-api/claude-opus-5.5", contextWindow: 1_048_576 }),
    `${OPUS}[1m]`,
  );
  assert.equal(
    claudeCodeModelId({ slug: "kiro-prism/claude-sonnet-5", contextWindow: 1_000_000 }),
    "codex_router/anthropic/kiro-prism/claude-sonnet-5[1m]",
  );
  assert.equal(
    claudeCodeModelId({ slug: "anthropic-api/claude-haiku-4.5", contextWindow: 200_000 }),
    "codex_router/anthropic/anthropic-api/claude-haiku-4.5",
  );
  assert.equal(
    claudeCodeModelId({ slug: "cloudflare-workers-ai/glm-5.3", contextWindow: 1_310_720 }),
    "codex_router/anthropic/cloudflare-workers-ai/glm-5.3",
  );
  assert.equal(claudeCodeModelId({ slug: "x/y" }), "codex_router/anthropic/x/y");
  assert.equal(claudeRoutedSlug(`${OPUS}[1m]`), "anthropic-api/claude-opus-5.5");
  assert.equal(claudeRoutedSlug(OPUS), "anthropic-api/claude-opus-5.5");
});

test("discovery and retrieve report each routed model's real limits", async () => {
  const routedModels = () => ({
    models: [
      { slug: "anthropic-api/claude-opus-5.5", displayName: "Claude Opus 5.5", contextWindow: 1_048_576, maxOutputTokens: 128_000 },
      { slug: "cloudflare-workers-ai/glm-5.3", displayName: "GLM", contextWindow: 131_072 },
    ],
  });
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://x").pathname;
    handleClaudeRequest(request, response, route, { responsesUrl: "http://127.0.0.1:1/v1/responses", routedModels });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/anthropic`;
  try {
    const list = await fetch(`${base}/v1/models`).then((r) => r.json());
    assert.deepEqual(list.data.map((m) => [m.id, m.max_input_tokens, m.max_tokens]), [
      [`${OPUS}[1m]`, 1_048_576, 128_000],
      ["codex_router/anthropic/cloudflare-workers-ai/glm-5.3", 131_072, undefined],
    ]);
    for (const id of [OPUS, `${OPUS}[1m]`]) {
      const one = await fetch(`${base}/v1/models/${encodeURIComponent(id)}`).then((r) => r.json());
      assert.equal(one.max_input_tokens, 1_048_576);
    }
    assert.equal((await fetch(`${base}/v1/models/${encodeURIComponent("codex_router/anthropic/nope")}`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a saved routed id is upgraded to the catalog's 1M spelling", () => {
  const env = claudeRouterEnvironment({
    environment: {},
    secret: "s".repeat(64),
    args: [],
    catalog: {
      defaultModel: `${OPUS}[1m]`,
      models: [{ slug: "anthropic-api/claude-opus-5.5", id: `${OPUS}[1m]`, displayName: "Claude Opus 5.5" }],
    },
    settings: { model: OPUS },
  });
  assert.equal(env.ANTHROPIC_MODEL, `${OPUS}[1m]`);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, `${OPUS}[1m]`);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "Claude Opus 5.5");
});

test("a conversation never reaches Anthropic ending on an assistant turn", () => {
  const thinkingOnly = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
    ],
  };
  assert.equal(endMessagesOnUserTurn(thinkingOnly), true);
  assert.deepEqual(thinkingOnly.messages, [{ role: "user", content: "hi" }]);

  const answered = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
    ],
  };
  endMessagesOnUserTurn(answered);
  assert.equal(answered.messages.length, 3);
  assert.equal(answered.messages[1].content[0].text, "partial answer");
  assert.equal(answered.messages.at(-1).role, "user");

  const legal = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(endMessagesOnUserTurn(legal), false);
});

test("prompt cache breakpoints cover tools, system, and the newest turns", () => {
  const payload = {
    system: "You are helpful.",
    tools: [{ name: "a" }, { name: "b" }],
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "three" }] },
    ],
  };
  assert.equal(applyPromptCacheBreakpoints(payload), 4);
  assert.deepEqual(payload.tools[1].cache_control, { type: "ephemeral" });
  assert.equal(payload.tools[0].cache_control, undefined);
  assert.deepEqual(payload.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(payload.messages[2].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(payload.messages[0].content[0].cache_control, { type: "ephemeral" });

  const own = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "x" }] };
  assert.equal(applyPromptCacheBreakpoints(own), 0);
  assert.equal(own.messages[0].content, "x");
});

test("deferred MCP tools reach the model only after tool search loads them", () => {
  const tools = [
    { name: "Read", input_schema: { type: "object" } },
    { name: "ToolSearch", input_schema: { type: "object" } },
    { name: "mcp__azure__storage", defer_loading: true, input_schema: { type: "object" } },
    { name: "mcp__aws__run", defer_loading: true, input_schema: { type: "object" } },
  ];
  const first = claudeMessagesToResponses({ model: OPUS, tools, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(first.tools.map((tool) => tool.name), ["Read", "ToolSearch"]);

  const loaded = claudeMessagesToResponses({
    model: OPUS,
    tools,
    messages: [
      { role: "user", content: "use storage" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "storage" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "mcp__azure__storage" }] }] },
    ],
  });
  assert.deepEqual(loaded.tools.map((tool) => tool.name), ["Read", "ToolSearch", "mcp__azure__storage"]);
  assert.equal(loaded.tools[2].defer_loading, undefined);
  const output = loaded.input.find((item) => item.type === "function_call_output").output;
  assert.match(output, /mcp__azure__storage is now loaded/);
});

test("the launcher turns Claude Code's on-demand tool loading on", () => {
  const env = claudeRouterEnvironment({ environment: { ENABLE_TOOL_SEARCH: "false" }, secret: "s".repeat(64), args: [], catalog: {}, settings: {} });
  assert.equal(env.ENABLE_TOOL_SEARCH, "true");
});

test("Codex defers MCP tools on every route the router can relay tool_search for", async () => {
  const { routedModelToolSearchAvailable } = await import("../src/search-capability.mjs");
  const none = { bindingForModel: () => undefined };
  assert.equal(routedModelToolSearchAvailable({ slug: "a/b" }, { provider: { protocol: "anthropic" }, ...none }), true);
  assert.equal(routedModelToolSearchAvailable({ slug: "a/b" }, { provider: { protocol: "openai-chat" }, ...none }), true);
  assert.equal(routedModelToolSearchAvailable({ slug: "a/b" }, { provider: { protocol: "openai-responses" }, ...none }), false);
  assert.equal(routedModelToolSearchAvailable({ slug: "a/b", supportsToolSearch: true }, { provider: { protocol: "openai-responses" } }), true);
  assert.equal(routedModelToolSearchAvailable({ slug: "a/b", supportsToolSearch: false }, { provider: { protocol: "anthropic" } }), false);
});
