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

test("a failed Claude probe reports whether the reading it kept is still fresh", async () => {
  const now = Date.parse("2026-10-10T14:00:00.000Z");
  const recentId = "clacct_000000000000rcnt";
  const oldId = "clacct_0000000000000old";
  const fineId = "clacct_000000000000fine";
  const poolPath = path.join(stateDir, "claude-pool-stale.json");
  const usagePath = path.join(stateDir, "claude-usage-stale.json");
  const account = (id) => ({
    id,
    state: "active",
    paused: false,
    priority: 50,
    label: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    identity: { accountId: `uuid-${id}`, email: `${id}@example.com` },
    subscription: { status: "usable" },
    health: { state: "healthy" },
    turns: 0,
    requests: 0,
  });
  writeFileSync(poolPath, JSON.stringify({
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: Object.fromEntries(
      [recentId, oldId, fineId].map((id) => [id, account(id)]),
    ),
  }), { mode: 0o600 });
  const fiveHour = { usedPercent: 40, remainingPercent: 60, resetsAtMs: now + 3_600_000 };
  const snapshot = {
    fetchedAt: new Date(now).toISOString(),
    accounts: [
      {
        id: recentId,
        fiveHour,
        fetchedAt: new Date(now - 60_000).toISOString(),
        error: "Rate limited. Please try again later.",
        rateLimited: true,
      },
      {
        id: oldId,
        fiveHour,
        fetchedAt: new Date(now - 60 * 60_000).toISOString(),
        error: "HTTP 500",
      },
      { id: fineId, fiveHour, fetchedAt: new Date(now).toISOString() },
    ],
  };
  writeFileSync(usagePath, JSON.stringify(snapshot), { mode: 0o600 });
  const report = await buildClaudeUsageReport({
    filePath: poolPath,
    homesDir: path.join(stateDir, "claude-homes-stale"),
    usagePath,
    snapshot,
    now,
  });
  const byId = new Map(report.accounts.map((row) => [row.id, row]));

  assert.equal(byId.get(recentId).readingStale, false);
  assert.equal(byId.get(recentId).rateLimited, true);
  assert.equal(byId.get(recentId).readingAt, Math.floor((now - 60_000) / 1000));
  assert.equal(byId.get(oldId).readingStale, true);
  assert.equal(byId.get(oldId).rateLimited, undefined);
  // A row whose probe succeeded carries none of the failure detail.
  assert.equal(byId.get(fineId).readingStale, undefined);
  assert.equal(byId.get(fineId).error, undefined);
});
