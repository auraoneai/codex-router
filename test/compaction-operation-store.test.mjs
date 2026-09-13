import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CompactionOperationStore,
  compactionOperationId,
  compactionSourceBoundary,
} from "../src/compaction-operation-store.mjs";

function store(filePath, now = () => 1_000) {
  return new CompactionOperationStore({ filePath, now });
}

test("operation identity is stable and sensitive to owner, root, boundary, model", () => {
  const base = {
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: compactionSourceBoundary([{ type: "message", content: "one" }]),
    model: "kiro-prism/gpt-5.6-sol",
  };
  assert.equal(compactionOperationId(base), compactionOperationId({ ...base }));
  for (const changed of [
    { owner: "owner-b" },
    { rootSession: "root-b" },
    { sourceBoundary: "different" },
    { model: "other" },
  ]) {
    assert.notEqual(compactionOperationId(base), compactionOperationId({ ...base, ...changed }));
  }
});

test("begin is durable single-flight and completed results survive restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-router-compaction-"));
  const filePath = path.join(directory, "operations.json");
  const first = store(filePath);
  const input = {
    id: "cmpop_one",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { orientation: { objective: "continue" } },
  };
  assert.equal(first.begin(input).created, true);
  assert.equal(first.begin(input).created, false);
  first.complete(input.id, input.owner, { orientation: { objective: "done" } });

  const restarted = store(filePath);
  const recovered = restarted.get(input.id, input.owner);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.attemptCount, 1);
  assert.equal(recovered.checkpoint.orientation.objective, "done");
});

test("owner mismatch fails closed and stale running work becomes retriable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-router-compaction-"));
  const filePath = path.join(directory, "operations.json");
  let now = 1_000;
  const first = store(filePath, () => now);
  first.begin({
    id: "cmpop_private",
    owner: "owner-a",
    rootSession: "root-a",
    sourceBoundary: "boundary-a",
    model: "sol",
    fallbackCheckpoint: { safe: true },
  });
  assert.throws(
    () => first.get("cmpop_private", "owner-b"),
    (error) => error.code === "compaction_operation_conflict",
  );
  now = 2_000;
  const restarted = store(filePath, () => now);
  const recovered = restarted.get("cmpop_private", "owner-a");
  assert.equal(recovered.state, "failed_retriable");
  assert.equal(recovered.failureCode, "compaction_transport_timeout");
});
