import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeCheckpoint,
  prepareCompaction,
  validCompactionModelOutput,
} from "../src/compaction-checkpoint.mjs";

function contractObject(overrides = {}) {
  return JSON.stringify({
    objective: "ship the fix",
    requirement_refs: [],
    attempt_refs: [],
    observation_refs: [],
    unknowns: [],
    blockers: [],
    next_step: "run the tests",
    unverified: [],
    ...overrides,
  });
}

test("a contract-satisfying model response is reported valid", () => {
  assert.equal(validCompactionModelOutput(contractObject()), true);
});

// A provider may wrap an otherwise valid object in a Markdown fence; that is
// still a successful generation.
test("a fenced JSON object is still valid", () => {
  assert.equal(
    validCompactionModelOutput("```json\n" + contractObject() + "\n```"),
    true,
  );
});

test("unusable model output is reported invalid", () => {
  for (const raw of ["", "   ", "I cannot summarize this.", "{}", "[]", "null"]) {
    assert.equal(
      validCompactionModelOutput(raw),
      false,
      `${JSON.stringify(raw)} must not count as a successful generation`,
    );
  }
});

test("an object missing a required contract field is invalid", () => {
  const partial = JSON.parse(contractObject());
  delete partial.next_step;
  assert.equal(validCompactionModelOutput(JSON.stringify(partial)), false);
});

test("a wrongly typed contract field is invalid", () => {
  assert.equal(validCompactionModelOutput(contractObject({ unknowns: "none" })), false);
});

// The point of the predicate: finalizeCheckpoint never fails, so a recovery
// fallback and a real generation are indistinguishable from the checkpoint alone.
// This reports on the raw text, before that substitution.
test("the deterministic fallback is well formed yet reports as no model output", () => {
  const prepared = prepareCompaction([
    { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
  ]);
  const checkpoint = finalizeCheckpoint("provider returned prose", prepared);
  assert.ok(checkpoint, "a checkpoint is still produced for the client");
  assert.equal(validCompactionModelOutput("provider returned prose"), false);
});
