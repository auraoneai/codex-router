import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpenAIRequest } from "../src/openai-adapters.mjs";

// The router sets both spellings on the same subagent turn on purpose: LiteLLM's
// Responses bridge derives its own flat value from the nested object whenever the
// client sent one, so a flat-only override never survives. The forwarder strips
// the flat field ahead of this boundary only for DeepSeek Responses routes, so
// every other Responses provider reaches here with both present.
test("both effort spellings agreeing collapse to the nested field", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
    reasoning_effort: "high",
  });
  assert.deepEqual(output.reasoning, { effort: "high" });
  assert.equal("reasoning_effort" in output, false);
});

// The nested field is the one the caller set, so it wins. A sibling like
// `summary` must survive the merge.
test("a nested reasoning object without an effort adopts the flat one", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: "hi",
    reasoning: { summary: "auto" },
    reasoning_effort: "medium",
  });
  assert.deepEqual(output.reasoning, { summary: "auto", effort: "medium" });
  assert.equal("reasoning_effort" in output, false);
});

test("a flat effort alone still becomes the nested field", () => {
  const output = normalizeOpenAIRequest({ model: "m", input: "hi", reasoning_effort: "low" });
  assert.deepEqual(output.reasoning, { effort: "low" });
  assert.equal("reasoning_effort" in output, false);
});

// A real disagreement is refused, because silently choosing one would change the
// reasoning depth the operator asked for. The message names both values.
test("disagreeing effort values are refused and both are named", () => {
  assert.throws(
    () => normalizeOpenAIRequest({
      model: "m",
      input: "hi",
      reasoning: { effort: "low" },
      reasoning_effort: "high",
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_responses_request");
      assert.match(error.message, /reasoning\.effort \(low\)/);
      assert.match(error.message, /reasoning_effort \(high\)/);
      assert.equal(error.safeMessage, true);
      return true;
    },
  );
});

test("a nested effort alone is untouched", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: "hi",
    reasoning: { effort: "xhigh" },
  });
  assert.deepEqual(output.reasoning, { effort: "xhigh" });
});

// A non-object `reasoning` has no nested effort to read; the flat value is the
// only usable one and must not be silently dropped.
test("a non-object reasoning value does not swallow the flat effort", () => {
  const output = normalizeOpenAIRequest({
    model: "m",
    input: "hi",
    reasoning: null,
    reasoning_effort: "high",
  });
  assert.deepEqual(output.reasoning, { effort: "high" });
  assert.equal("reasoning_effort" in output, false);
});
