import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "pool-usage-report-"));
const codexHome = mkdtempSync(path.join(os.tmpdir(), "pool-usage-report-home-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const {
  buildChatGPTUsageReport,
  buildClaudeUsageReport,
  readUsageSnapshotFile,
} = await import("../src/pool-usage-report.mjs");

test("reads a usage snapshot file and defaults a missing one", () => {
  const cachePath = path.join(stateDir, "usage.json");
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: "then", accounts: [{ id: "a" }] }));
  assert.deepEqual(readUsageSnapshotFile(cachePath), {
    fetchedAt: "then",
    accounts: [{ id: "a" }],
  });
  assert.deepEqual(readUsageSnapshotFile(path.join(stateDir, "missing.json")), { accounts: [] });
});

test("builds the ChatGPT report with the control row shape", async () => {
  const now = Date.now();
  const snapshot = {
    fetchedAt: "2026-10-01T00:00:00.000Z",
    accounts: [
      {
        id: "acct_demo1",
        label: "demo",
        preferred: true,
        planType: "plus",
        primary: { remainingPercent: 50 },
        secondary: { remainingPercent: 80, resetsAt: Math.floor(now / 1000) + 3600 },
      },
    ],
  };
  const report = await buildChatGPTUsageReport(snapshot, { poolState: { accounts: {} }, now });
  assert.equal(report.fetchedAt, "2026-10-01T00:00:00.000Z");
  assert.ok(Array.isArray(report.rotation));
  assert.equal(report.accounts.length, 1);
  const [row] = report.accounts;
  assert.deepEqual(Object.keys(row), [
    "id",
    "label",
    "preferred",
    "planType",
    "health",
    "cooling",
    "cooldownUntil",
    "primaryRemainingPercent",
    "secondaryRemainingPercent",
    "resetCredits",
    "credits",
    "creditFallback",
    "spendingCredits",
    "resetAttemptPending",
    "resetsAt",
  ]);
  assert.equal(row.id, "acct_demo1");
  assert.equal(row.primaryRemainingPercent, 50);
  assert.equal(row.secondaryRemainingPercent, 80);
  assert.equal(row.cooling, false);
  assert.equal(row.cooldownUntil, null);
});

test("builds the Claude report over an empty pool", async () => {
  const usagePath = path.join(stateDir, "claude-usage.json");
  writeFileSync(usagePath, JSON.stringify({ fetchedAt: "then", accounts: [] }));
  const report = await buildClaudeUsageReport({
    filePath: path.join(stateDir, "missing-pool.json"),
    homesDir: path.join(stateDir, "homes"),
    usagePath,
    snapshot: { fetchedAt: "then", accounts: [] },
  });
  assert.equal(report.fetchedAt, "then");
  assert.deepEqual(report.rotation, []);
  assert.deepEqual(report.accounts, []);
});

test("usage builders refuse to run with discovery disabled", async () => {
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    await assert.rejects(buildChatGPTUsageReport({ accounts: [] }, {}), /credential discovery/);
    await assert.rejects(buildClaudeUsageReport({ snapshot: { accounts: [] } }), /credential discovery/);
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
  }
});
