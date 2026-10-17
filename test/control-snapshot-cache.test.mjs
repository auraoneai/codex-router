import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-snapshot-cache-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  CONTROL_SNAPSHOT_TTLS_MS,
  controlSnapshotPath,
  invalidateControlSnapshots,
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
  for (const name of [
    "provider-usage",
    "account",
    "providers",
    "probe",
    "engineering-usage",
    "tool-result-aging",
  ]) {
    assert.ok(
      Number.isFinite(CONTROL_SNAPSHOT_TTLS_MS[name]) && CONTROL_SNAPSHOT_TTLS_MS[name] > 0,
      name,
    );
  }
});

test("caches engineering-usage and tool-result-aging with default TTLs and invalidates snapshots", () => {
  const events = [{ runId: "run-1", taskId: "task-1", attemptId: "attempt-1" }];
  assert.equal(writeControlSnapshot("engineering-usage", events), true);
  assert.deepEqual(readControlSnapshot("engineering-usage"), events);

  const aging = { enabled: false, configured: false, environmentOverride: false };
  assert.equal(writeControlSnapshot("tool-result-aging", aging), true);
  assert.deepEqual(readControlSnapshot("tool-result-aging"), aging);

  assert.equal(writeControlSnapshot("probe-codex", { target: "codex" }), true);
  invalidateControlSnapshots(["engineering-usage", "tool-result-aging", "probe"]);
  assert.equal(readControlSnapshot("engineering-usage"), undefined);
  assert.equal(readControlSnapshot("tool-result-aging"), undefined);
  assert.equal(readControlSnapshot("probe-codex", CONTROL_SNAPSHOT_TTLS_MS.probe), undefined);
});

test("engineeringUsageEventsForControl uses recentEngineeringUsageEvents and caches engineering-usage", () => {
  const source = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const helper = source.match(/async function engineeringUsageEventsForControl[\s\S]*?\n}/)?.[0];
  assert.ok(helper, "engineeringUsageEventsForControl should exist in src/control.mjs");
  assert.match(helper, /readControlSnapshot\("engineering-usage"\)/);
  assert.match(helper, /recentEngineeringUsageEvents\(\{\s*limit:\s*1_000\s*\}\)/);
  assert.match(helper, /writeControlSnapshot\("engineering-usage",\s*events\)/);
  assert.doesNotMatch(helper, /recentUsageEvents/);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "control-aging-cache-"));
  try {
    const env = {
      ...process.env,
      CODEX_HOME: tempDir,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: tempDir,
    };
    delete env.CODEX_ROUTER_TOOL_RESULT_AGING;
    const status = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "tool-result-aging", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.equal(status.enabled, false);
    assert.equal(existsSync(path.join(tempDir, "control-snapshot-tool-result-aging.json")), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
