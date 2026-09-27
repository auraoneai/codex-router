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
  claudeRejectionResetAt,
  coolClaudeAccountFamily,
  leftoverHealth,
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

test("an expired access token with a refresh token stays in rotation; a refused login does not", () => {
  const options = fixture();
  const now = Date.now();
  const expired = createTestAccount(options, { label: "Expired", expiresAt: now - 60_000, refreshToken: "rt-expired" });
  const refused = createTestAccount(options, { label: "Refused", expiresAt: now - 60_000, refreshToken: "rt-refused" });
  const noRefresh = createTestAccount(options, { label: "NoRefresh", expiresAt: now - 60_000, refreshToken: "" });
  const state = readClaudeAccountPoolState(options.filePath);
  state.accounts[refused.id].health = { state: "reauth-required" };
  writeClaudeAccountPoolState(state, options.filePath);

  const candidates = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, now });
  assert.deepEqual(candidates.map((c) => c.id), [expired.id]);
  assert.equal(candidates[0].needsRefresh, true);
  assert.ok(candidates[0].tokenFingerprint, "candidates carry the fingerprint the attempt loop checks");

  const report = claudePoolExhaustionReport({ poolPath: options.filePath, homesDir: options.homesDir, now });
  assert.equal(report, null, "a refreshable account is not an exhausted pool");
  void noRefresh;
});

test("a drained window whose reset has passed no longer keeps the account out", () => {
  const options = fixture();
  const now = Date.now();
  const recovered = createTestAccount(options, { label: "Recovered", refreshToken: "rt-recovered" });
  const spent = createTestAccount(options, { label: "Spent", refreshToken: "rt-spent" });
  const usageById = new Map([
    [recovered.id, { id: recovered.id, fiveHour: { remainingPercent: 0, resetsAtMs: now - 60_000 } }],
    [spent.id, { id: spent.id, fiveHour: { remainingPercent: 0, resetsAtMs: now + 3600_000 } }],
  ]);
  assert.equal(leftoverHealth(usageById.get(recovered.id), undefined, recovered.id, { now }), "unknown");
  const ids = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, usageById, now })
    .map((c) => c.id);
  assert.deepEqual(ids, [recovered.id]);
});

test("the exhaustion report never names a reset time in the past", () => {
  const options = fixture();
  const now = Date.now();
  const a = createTestAccount(options, { label: "A", refreshToken: "rt-a" });
  const b = createTestAccount(options, { label: "B", refreshToken: "rt-b" });
  const usageById = new Map([
    // Five-hour window spent, weekly also spent and resetting later: the
    // account is back only when both have reset.
    [a.id, {
      id: a.id,
      fiveHour: { remainingPercent: 0, resetsAtMs: now + 60_000 },
      weekly: { remainingPercent: 0, resetsAtMs: now + 7200_000 },
    }],
    [b.id, { id: b.id, fiveHour: { remainingPercent: 0, resetsAtMs: now + 3600_000 } }],
  ]);
  const report = claudePoolExhaustionReport({ poolPath: options.filePath, homesDir: options.homesDir, usageById, now });
  assert.equal(report.exhausted, true);
  assert.ok(report.nextResetAt > now);
  assert.equal(report.nextResetAt, now + 3600_000);
});

test("a spent Fable family bucket benches the account for Fable only", () => {
  const options = fixture();
  const now = Date.now();
  const a = createTestAccount(options, { label: "A", refreshToken: "rt-fa" });
  const b = createTestAccount(options, { label: "B", refreshToken: "rt-fb" });
  const usageById = new Map([
    [a.id, {
      id: a.id,
      fiveHour: { remainingPercent: 70, resetsAtMs: now + 3600_000 },
      fable: { remainingPercent: 0, resetsAtMs: now + 86_400_000 },
    }],
  ]);
  const fable = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, usageById, family: "fable", now });
  assert.deepEqual(fable.map((c) => c.id), [b.id]);
  const other = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, usageById, now });
  assert.ok(other.some((c) => c.id === a.id), "non-Fable models keep the account");

  coolClaudeAccountFamily(b.id, "fable", now + 60_000);
  const fableCooled = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, family: "fable", now });
  assert.equal(fableCooled[0].id, a.id, "a family cooldown moves Fable turns off the account");
});

test("a cached auth-invalid row stops applying once the account holds a different token", () => {
  const options = fixture();
  const account = createTestAccount(options, { label: "Relogged", accessToken: "fresh-login-token", refreshToken: "rt-relog" });
  const usageById = new Map([
    [account.id, { id: account.id, authInvalid: true, authTokenFingerprint: "0000000000000000" }],
  ]);
  const ids = claudeRotationCandidates({ poolPath: options.filePath, homesDir: options.homesDir, usageById })
    .map((c) => c.id);
  assert.deepEqual(ids, [account.id]);
});

test("a shared rejection benches the account until the latest rejected window resets", () => {
  const now = Date.now();
  const reading = {
    status: "rejected",
    windowStatuses: { fiveHour: "allowed", weekly: "rejected" },
    fiveHour: { remainingPercent: 40, resetsAtMs: now + 3600_000 },
    weekly: { remainingPercent: 0, resetsAtMs: now + 3 * 86_400_000 },
  };
  assert.equal(claudeRejectionResetAt(reading, now), now + 3 * 86_400_000,
    "a weekly rejection is not lifted at the five-hour reset");
  assert.equal(claudeRejectionResetAt({ status: "rejected" }, now), undefined);
});
