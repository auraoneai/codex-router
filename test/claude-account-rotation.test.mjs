import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeAccountSession,
  claudePoolExhaustionReport,
  claudeRotationCandidates,
  coolClaudeAccount,
  isClaudeAccountAuthInvalid,
  markClaudeAccountAuthInvalid,
  orderClaudeAccountCandidates,
  rememberClaudeAccount,
  rememberedClaudeAccount,
  resetClaudeRotationStateForTests,
  tierWeight,
} from "../src/claude-account-rotation.mjs";
import {
  claudeSubscriptionAccountCredentialsPath,
  createClaudeSubscriptionAccount,
  readClaudeAccountPoolState,
  writeClaudeAccountPoolState,
} from "../src/claude-account-pool.mjs";
import { protectPrivateFile } from "../src/file-security.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-rotation-test-"));
  return {
    root,
    filePath: path.join(root, "claude-account-pool.json"),
    homesDir: path.join(root, "claude-accounts"),
  };
}

function createTestAccount(options, {
  label = "Test Account",
  purpose,
  plan = "pro",
  accessToken = "test-token",
  refreshToken = "test-refresh",
  expiresAt = Date.now() + 3600_000,
} = {}) {
  const account = createClaudeSubscriptionAccount({ ...options, label, purpose });
  const credPath = claudeSubscriptionAccountCredentialsPath(account.id, options);
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt,
        email: `${account.id}@example.com`,
      },
    }),
    { mode: 0o600 },
  );
  const state = readClaudeAccountPoolState(options.filePath);
  state.accounts[account.id].subscription = { status: "usable", plan };
  writeClaudeAccountPoolState(state, options.filePath);
  return account;
}

test.beforeEach(() => {
  resetClaudeRotationStateForTests();
});

test("tierWeight orders capacity from smallest to largest", () => {
  assert.equal(tierWeight("pro"), 1);
  assert.equal(tierWeight("unknown"), 3);
  assert.equal(tierWeight("max5"), 5);
  assert.equal(tierWeight("max20"), 20);
  assert.equal(tierWeight("team"), 50);
  assert.ok(tierWeight("pro") < tierWeight("max5"));
  assert.ok(tierWeight("max5") < tierWeight("max20"));
});

test("orderClaudeAccountCandidates spends smaller Pro capacity before Max5 and Max20", () => {
  const candidates = [{ id: "acct-max20" }, { id: "acct-pro" }, { id: "acct-max5" }];
  const usageById = new Map([
    ["acct-pro", { id: "acct-pro", plan: "pro", fiveHour: { remainingPercent: 80 } }],
    ["acct-max5", { id: "acct-max5", plan: "max5", fiveHour: { remainingPercent: 80 } }],
    ["acct-max20", { id: "acct-max20", plan: "max20", fiveHour: { remainingPercent: 80 } }],
  ]);

  const ordered = orderClaudeAccountCandidates(candidates, { usageById });
  assert.deepEqual(ordered.map((c) => c.id), ["acct-pro", "acct-max5", "acct-max20"]);
});

test("affinity stickiness keeps in-flight conversation on the same account", () => {
  const candidates = [{ id: "acct-1" }, { id: "acct-2" }];
  const usageById = new Map([
    ["acct-1", { id: "acct-1", plan: "pro", fiveHour: { remainingPercent: 50 } }],
    ["acct-2", { id: "acct-2", plan: "pro", fiveHour: { remainingPercent: 80 } }],
  ]);

  // Without affinity, 80% remaining is healthy vs 50%
  rememberClaudeAccount("conv-123", "acct-1");
  assert.equal(rememberedClaudeAccount("conv-123"), "acct-1");

  const ordered = orderClaudeAccountCandidates(candidates, {
    sticky: rememberedClaudeAccount("conv-123"),
    usageById,
  });
  assert.equal(ordered[0].id, "acct-1");
});

test("drain detection filters out exhausted accounts and cooldown passes over temporary 429", () => {
  const options = fixture();
  const acc1 = createTestAccount(options, { accessToken: "tok-1", refreshToken: "ref-1", plan: "pro" });
  const acc2 = createTestAccount(options, { accessToken: "tok-2", refreshToken: "ref-2", plan: "pro" });

  const usageById = new Map([
    [acc1.id, { id: acc1.id, fiveHour: { remainingPercent: 0 } }], // Drained
    [acc2.id, { id: acc2.id, fiveHour: { remainingPercent: 50 } }], // Healthy
  ]);

  const candidates1 = claudeRotationCandidates({
    poolPath: options.filePath,
    homesDir: options.homesDir,
    usageById,
  });
  assert.equal(candidates1.length, 1);
  assert.equal(candidates1[0].id, acc2.id);

  // Now cool down acc2
  const now = Date.now();
  coolClaudeAccount(acc2.id, now + 60_000);

  // When all ready are filtered, it falls back to eligible so no turn is stranded
  const candidates2 = claudeRotationCandidates({
    poolPath: options.filePath,
    homesDir: options.homesDir,
    usageById,
    now,
  });
  assert.equal(candidates2.length, 1);
  assert.equal(candidates2[0].id, acc2.id);
});

test("markClaudeAccountAuthInvalid drops account until token changes", () => {
  const accountId = "clacct_authinv1";
  const tokenFingerprint = "fp-initial";

  markClaudeAccountAuthInvalid(accountId, { tokenFingerprint, reason: "401 unauthorized" });
  assert.equal(isClaudeAccountAuthInvalid(accountId, { tokenFingerprint }), true);

  // Still invalid with same token
  assert.equal(isClaudeAccountAuthInvalid(accountId, { tokenFingerprint }), true);

  // A rotated new token clears the invalid state
  assert.equal(isClaudeAccountAuthInvalid(accountId, { tokenFingerprint: "fp-new" }), false);
  assert.equal(isClaudeAccountAuthInvalid(accountId), false);
});

test("fingerprint de-dup ignores duplicate registration of the same OAuth lineage", () => {
  const options = fixture();
  // Two accounts with same refreshToken
  const acc1 = createTestAccount(options, { accessToken: "tok-1", refreshToken: "shared-refresh" });
  const acc2 = createTestAccount(options, { accessToken: "tok-2", refreshToken: "shared-refresh" });

  const candidates = claudeRotationCandidates({
    poolPath: options.filePath,
    homesDir: options.homesDir,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, acc1.id);
});

test("purpose pins order accounts according to pinOrder", () => {
  const candidates = [{ id: "acct-foundation" }, { id: "acct-personal" }, { id: "acct-auraone" }];
  const purposeById = new Map([
    ["acct-foundation", "foundation"],
    ["acct-personal", "personal"],
    ["acct-auraone", "auraone"],
  ]);

  const ordered = orderClaudeAccountCandidates(candidates, { purposeById });
  assert.deepEqual(ordered.map((c) => c.id), ["acct-personal", "acct-auraone", "acct-foundation"]);
});

test("claudePoolExhaustionReport reports all-drained status with earliest reset", () => {
  const options = fixture();
  const acc1 = createTestAccount(options, { accessToken: "tok-1", refreshToken: "ref-1" });
  const acc2 = createTestAccount(options, { accessToken: "tok-2", refreshToken: "ref-2" });

  const resetTime1 = Date.now() + 100_000;
  const resetTime2 = Date.now() + 50_000;

  const usageById = new Map([
    [acc1.id, { id: acc1.id, fiveHour: { remainingPercent: 0, resetsAtMs: resetTime1 } }],
    [acc2.id, { id: acc2.id, fiveHour: { remainingPercent: 0, resetsAtMs: resetTime2 } }],
  ]);

  const report = claudePoolExhaustionReport({
    poolPath: options.filePath,
    homesDir: options.homesDir,
    usageById,
  });

  assert.ok(report);
  assert.equal(report.exhausted, true);
  assert.equal(report.total, 2);
  assert.equal(report.drained, 2);
  assert.equal(report.nextResetAt, resetTime2);
  assert.match(report.message, /All 2 Claude accounts in the pool are currently unavailable/);
});
