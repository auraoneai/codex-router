import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-snapshot-cache-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  CONTROL_SNAPSHOT_TTLS_MS,
  controlSnapshotPath,
  readControlSnapshot,
  writeControlSnapshot,
} = await import("../src/control-snapshot-cache.mjs");

test("misses when no snapshot exists", () => {
  assert.equal(readControlSnapshot("provider-usage", 60_000), undefined);
});

test("round-trips a written snapshot", () => {
  assert.equal(writeControlSnapshot("provider-usage", { a: 1 }), true);
  assert.deepEqual(readControlSnapshot("provider-usage", 60_000), { a: 1 });
});

test("serves a fresh snapshot and rejects a stale one", () => {
  assert.equal(writeControlSnapshot("account", { b: 2 }), true);
  assert.deepEqual(readControlSnapshot("account", 60_000), { b: 2 });
  const ancient = new Date(Date.now() - 3600_000);
  utimesSync(controlSnapshotPath("account"), ancient, ancient);
  assert.equal(readControlSnapshot("account", 60_000), undefined);
});

test("rejects malformed, non-object, and oversized entries", () => {
  writeFileSync(controlSnapshotPath("providers"), "not json{{{");
  assert.equal(readControlSnapshot("providers", 60_000), undefined);
  writeFileSync(controlSnapshotPath("providers"), JSON.stringify([1, 2]));
  assert.equal(readControlSnapshot("providers", 60_000), undefined);
  writeFileSync(controlSnapshotPath("providers"), `{"pad":"${"x".repeat(8 * 1024 * 1024 + 1)}"}`);
  assert.equal(readControlSnapshot("providers", 60_000), undefined);
});

test("rejects symlinked entries", () => {
  const target = path.join(stateDir, "real.json");
  writeFileSync(target, JSON.stringify({ c: 3 }));
  const link = controlSnapshotPath("probe-codex");
  try {
    symlinkSync(target, link);
  } catch {
    return;
  }
  assert.equal(readControlSnapshot("probe-codex", 60_000), undefined);
});

test("invalid names fail closed without throwing", () => {
  assert.throws(() => controlSnapshotPath("../escape"));
  assert.equal(readControlSnapshot("../escape", 60_000), undefined);
  assert.equal(writeControlSnapshot("../escape", { d: 4 }), false);
  assert.equal(writeControlSnapshot("account", [1]), false);
  assert.equal(writeControlSnapshot("account", null), false);
  assert.equal(readControlSnapshot("account", 0), undefined);
  assert.equal(readControlSnapshot("account", Number.NaN), undefined);
});

test("ships a TTL for every cached command", () => {
  for (const name of ["provider-usage", "account", "providers", "probe"]) {
    assert.ok(
      Number.isFinite(CONTROL_SNAPSHOT_TTLS_MS[name]) && CONTROL_SNAPSHOT_TTLS_MS[name] > 0,
      name,
    );
  }
});
