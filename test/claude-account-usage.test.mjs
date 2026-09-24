import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cachedClaudeAccountUsageById,
  clearClaudeAccountUsageCacheForTests,
  FAMILY_STALE_MS,
  recordClaudeAccountUsage,
  USAGE_CACHE_MAX_AGE_MS,
} from "../src/claude-account-usage.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-usage-test-"));
  return {
    root,
    usagePath: path.join(root, "claude-account-usage.json"),
  };
}

test.beforeEach(() => {
  clearClaudeAccountUsageCacheForTests();
});

test("recordClaudeAccountUsage writes atomically and is readable by cachedClaudeAccountUsageById", () => {
  const options = fixture();
  const now = Date.now();
  const reading = {
    fiveHour: { usedPercent: 20, remainingPercent: 80, resetsAtMs: now + 3600_000 },
    weekly: { usedPercent: 40, remainingPercent: 60, resetsAtMs: now + 86400_000 },
    status: "allowed",
  };

  recordClaudeAccountUsage("clacct_1", reading, { now, usagePath: options.usagePath });

  assert.equal(existsSync(options.usagePath), true);
  const doc = JSON.parse(readFileSync(options.usagePath, "utf8"));
  assert.equal(doc.accounts.length, 1);
  assert.equal(doc.accounts[0].id, "clacct_1");
  assert.equal(doc.accounts[0].fiveHour.remainingPercent, 80);

  const cached = cachedClaudeAccountUsageById({ now, usagePath: options.usagePath, force: true });
  assert.equal(cached.get("clacct_1")?.fiveHour?.remainingPercent, 80);
});

test("cachedClaudeAccountUsageById retains drained and auth-invalid accounts when disk cache is stale", () => {
  const options = fixture();
  const now = Date.now();
  const oldTime = now - USAGE_CACHE_MAX_AGE_MS - 1000; // Stale

  const readingDrained = {
    fiveHour: { usedPercent: 100, remainingPercent: 0, resetsAtMs: now + 3600_000 },
    status: "rejected",
  };
  const readingHealthy = {
    fiveHour: { usedPercent: 20, remainingPercent: 80, resetsAtMs: now + 3600_000 },
    status: "allowed",
  };

  recordClaudeAccountUsage("clacct_drained", readingDrained, { now: oldTime, usagePath: options.usagePath });
  recordClaudeAccountUsage("clacct_healthy", readingHealthy, { now: oldTime, usagePath: options.usagePath });

  clearClaudeAccountUsageCacheForTests();

  const cached = cachedClaudeAccountUsageById({ now, usagePath: options.usagePath, force: true });
  assert.ok(cached.has("clacct_drained"), "drained account must be retained even when stale");
  assert.equal(cached.has("clacct_healthy"), false, "healthy account is dropped when stale");
});

test("family (Fable) readings older than 30 minutes are dropped", () => {
  const options = fixture();
  const now = Date.now();
  const reading = {
    fiveHour: { usedPercent: 20, remainingPercent: 80 },
    fable: { usedPercent: 90, remainingPercent: 10, seenAtMs: now - FAMILY_STALE_MS - 5000 },
  };

  recordClaudeAccountUsage("clacct_fable", reading, { now, usagePath: options.usagePath });
  clearClaudeAccountUsageCacheForTests();

  const cached = cachedClaudeAccountUsageById({ now, usagePath: options.usagePath, force: true });
  const acc = cached.get("clacct_fable");
  assert.ok(acc);
  assert.ok(acc.fiveHour);
  assert.equal(acc.fable, undefined, "stale fable reading must be dropped");
});
