import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpenAIRequest } from "../src/openai-adapters.mjs";

// Codex stores a namespaced tool result as { id, name, namespace, output }: its
// own client shape, where the correlation lives in `id` rather than in the
// `call_id` the Responses API names. Those items replay verbatim through
// compaction, so requiring `call_id` rejected the entire history of any
// conversation that had used an MCP or namespace tool.
test("a namespaced tool result correlates through its client id", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: [
      {
        type: "function_call",
        call_id: "call_ns_1",
        name: "mcp__node_repl__js",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        id: "call_ns_1",
        name: "mcp__node_repl__js",
        namespace: "mcp",
        output: "42",
      },
    ],
  });

  const result = output.input.at(-1);
  assert.equal(result.call_id, "call_ns_1");
  assert.equal(result.output, "42");
  // Codex-internal bookkeeping a strict provider would reject as unknown.
  assert.equal("namespace" in result, false);
  // Not carried twice: `id` equalled the correlation, so it is not duplicated.
  assert.equal("id" in result, false);
});

test("a call stored under id rather than call_id still correlates its result", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: [
      { type: "function_call", call_id: "fc_a", id: "item_a", name: "read", arguments: "{}" },
      { type: "function_call_output", id: "item_a", output: "contents" },
    ],
  });
  assert.equal(output.input.at(-1).call_id, "item_a");
});

test("the client metadata passthrough never reaches a provider", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: [
      { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c1",
        output: "ok",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    ],
  });
  assert.equal("internal_chat_message_metadata_passthrough" in output.input.at(-1), false);
  assert.equal(output.input.at(-1).call_id, "c1");
});

// The correlation must be one this request already established. Adopting an
// arbitrary `id` would hand the provider a result belonging to no call.
test("an id matching no call in the request is still refused", () => {
  assert.throws(
    () => normalizeOpenAIRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "known", name: "t", arguments: "{}" },
        { type: "function_call_output", id: "unrelated", output: "orphan" },
      ],
    }),
    (error) => error.status === 400 && error.code === "invalid_responses_request",
  );
});

test("an output with no correlation at all is still refused", () => {
  assert.throws(
    () => normalizeOpenAIRequest({
      model: "m",
      input: [{ type: "function_call_output", output: "no id" }],
    }),
    (error) => error.status === 400,
  );
});

// An explicit call_id always wins: it is the field the API names, and a
// differing `id` is a distinct item identity that must not overwrite it.
test("an explicit call_id outranks a differing item id", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: [
      { type: "function_call", call_id: "the_call", name: "t", arguments: "{}" },
      { type: "function_call_output", call_id: "the_call", id: "fcout_99", output: "ok" },
    ],
  });
  assert.equal(output.input.at(-1).call_id, "the_call");
  assert.equal(output.input.at(-1).id, "fcout_99");
});

test("a missing output is refused even when the correlation is usable", () => {
  assert.throws(
    () => normalizeOpenAIRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "c", name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: "c" },
      ],
    }),
    (error) => error.status === 400,
  );
});

// Rejections name the offending item and the shape of its keys, without values.
test("a rejected input item is named, by index and key shape, without values", () => {
  assert.throws(
    () => normalizeOpenAIRequest({
      model: "m",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call_output", output: "secret tool output" },
      ],
    }),
    (error) => {
      assert.match(error.message, /Item 1 has keys \[/);
      assert.match(error.message, /output=string/);
      assert.equal(error.message.includes("secret tool output"), false);
      assert.equal(error.safeMessage, true);
      return true;
    },
  );
});

test("a custom_tool_call also establishes a usable correlation", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: [
      { type: "custom_tool_call", call_id: "ct_1", name: "apply_patch", input: "x" },
      { type: "function_call_output", id: "ct_1", output: "applied" },
    ],
  });
  assert.equal(output.input.at(-1).call_id, "ct_1");
});
