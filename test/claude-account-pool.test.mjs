import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION,
  claudeAccountPoolConfigured,
  claudeSubscriptionAccountCredentialsPath,
  claudeSubscriptionAccountHome,
  claudeSubscriptionAccountPoolSnapshot,
  claudeSubscriptionAccountStatus,
  createClaudeSubscriptionAccount,
  isClaudeAccountId,
  readClaudeAccountPoolState,
  removeClaudeSubscriptionAccount,
  sanitizeClaudeAccount,
  sanitizeClaudeAccountPool,
  withClaudeAccountPoolLock,
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
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-account-store-"));
  return {
    root,
    filePath: path.join(root, "claude-account-pool.json"),
    homesDir: path.join(root, "claude-accounts"),
  };
}

test("saved Claude accounts use isolated homes and never persist credentials in pool state", () => {
  const options = fixture();
  const account = createClaudeSubscriptionAccount(options);
  const state = readFileSync(options.filePath, "utf8");
  assert.match(account.id, /^clacct_[A-Za-z0-9_-]+$/);
  assert.equal(isClaudeAccountId(account.id), true);
  assert.equal(claudeSubscriptionAccountHome(account.id, options), path.join(options.homesDir, account.id));
  assert.equal(
    claudeSubscriptionAccountCredentialsPath(account.id, options),
    path.join(options.homesDir, account.id, "credentials.json"),
  );
  assert.equal(readClaudeAccountPoolState(options.filePath).accounts[account.id].subscription.status, "pending");
  assert.doesNotMatch(state, /access_token|refresh_token|accessToken|refreshToken/i);
});

test("account labels reuse the first free number after a removed account", () => {
  const options = fixture();
  const first = createClaudeSubscriptionAccount(options);
  const second = createClaudeSubscriptionAccount(options);
  removeClaudeSubscriptionAccount(first.id, options);
  const next = createClaudeSubscriptionAccount(options);
  assert.equal(first.label, "Claude account 1");
  assert.equal(second.label, "Claude account 2");
  assert.equal(next.label, "Claude account 1");
});

test("snapshot exposes email and usable status from an isolated credentials file", () => {
  const options = fixture();
  const account = createClaudeSubscriptionAccount(options);
  const credPath = claudeSubscriptionAccountCredentialsPath(account.id, options);
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 3600_000,
        email: "claude-user@example.com",
        accountUuid: "uuid-1234",
      },
    }),
    { mode: 0o600 },
  );
  const snapshot = claudeSubscriptionAccountPoolSnapshot(options);
  assert.equal(snapshot.accounts[account.id].subscription.email, "claude-user@example.com");
  assert.equal(snapshot.accounts[account.id].subscription.usable, true);
  assert.equal(snapshot.accounts[account.id].subscription.authenticated, true);
  assert.equal(snapshot.accounts[account.id].subscription.expired, false);
  assert.equal(snapshot.accounts[account.id].subscription.hasAccountId, true);
  assert.equal(snapshot.accounts[account.id].subscription.status, "usable");
});

test("snapshot reports expired when token expiry is in the past or within skew", () => {
  const options = fixture();
  const account = createClaudeSubscriptionAccount(options);
  const credPath = claudeSubscriptionAccountCredentialsPath(account.id, options);
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() - 10_000,
        email: "expired@example.com",
      },
    }),
    { mode: 0o600 },
  );
  const status = claudeSubscriptionAccountStatus(account.id, options);
  assert.equal(status.status, "expired");
  assert.equal(status.usable, false);
  assert.equal(status.expired, true);
  assert.equal(status.authenticated, true);
});

test("purpose pins are stored and validated against allowed vocabulary", () => {
  const options = fixture();
  const personal = createClaudeSubscriptionAccount({ ...options, purpose: "personal" });
  assert.equal(personal.purpose, "personal");

  const state = readClaudeAccountPoolState(options.filePath);
  assert.equal(state.accounts[personal.id].purpose, "personal");

  // Invalid purpose in state throws on read
  state.accounts[personal.id].purpose = "invalid-purpose";
  assert.throws(
    () => writeClaudeAccountPoolState(state, options.filePath),
    /invalid purpose/i,
  );
});

test("strict assertAllowedKeys rejects extra fields on pool root and accounts", () => {
  const options = fixture();
  const account = createClaudeSubscriptionAccount(options);
  const state = readClaudeAccountPoolState(options.filePath);

  // Extra field on root
  state.unknownRootField = 123;
  assert.throws(() => writeClaudeAccountPoolState(state, options.filePath), /contains unsupported field unknownRootField/i);
  delete state.unknownRootField;

  // Extra field on account
  state.accounts[account.id].extraAccountField = "hack";
  assert.throws(() => writeClaudeAccountPoolState(state, options.filePath), /contains unsupported field extraAccountField/i);
  delete state.accounts[account.id].extraAccountField;

  // Extra field on health
  state.accounts[account.id].health.unknownHealthProp = true;
  assert.throws(() => writeClaudeAccountPoolState(state, options.filePath), /contains unsupported field unknownHealthProp/i);
});

test("sanitize redacts health.lastError and never leaks token material", () => {
  const options = fixture();
  const account = createClaudeSubscriptionAccount(options);
  const state = readClaudeAccountPoolState(options.filePath);
  state.accounts[account.id].health.lastError = "secret token eyJhbGciOi... leaked";
  writeClaudeAccountPoolState(state, options.filePath);

  const snapshot = claudeSubscriptionAccountPoolSnapshot(options);
  assert.equal(snapshot.accounts[account.id].health.lastError, "[redacted]");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret token/i);
});

test("lock contention serializes concurrent mutations", async () => {
  const options = fixture();
  const order = [];
  const p1 = withClaudeAccountPoolLock(async () => {
    order.push("p1-start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push("p1-end");
  }, options);
  const p2 = withClaudeAccountPoolLock(async () => {
    order.push("p2-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("p2-end");
  }, options);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["p1-start", "p1-end", "p2-start", "p2-end"]);
});

test("account removal refuses symlinked roots and targets without deleting external data", () => {
  for (const targetKind of ["root", "account"]) {
    const options = fixture();
    const account = createClaudeSubscriptionAccount(options);
    const originalPool = readFileSync(options.filePath, "utf8");
    const external = mkdtempSync(path.join(os.tmpdir(), `claude-account-external-${targetKind}-`));
    const sentinel = path.join(external, "keep.txt");
    writeFileSync(sentinel, "external-data", { mode: 0o600 });
    if (targetKind === "root") {
      renameSync(options.homesDir, `${options.homesDir}.owned`);
      symlinkSync(external, options.homesDir, process.platform === "win32" ? "junction" : "dir");
    } else {
      const home = claudeSubscriptionAccountHome(account.id, options);
      renameSync(home, `${home}.owned`);
      symlinkSync(external, home, process.platform === "win32" ? "junction" : "dir");
    }
    assert.throws(
      () => removeClaudeSubscriptionAccount(account.id, options),
      /symbolic-link|private directory|owned directory/i,
    );
    assert.equal(readFileSync(sentinel, "utf8"), "external-data");
    assert.equal(readFileSync(options.filePath, "utf8"), originalPool);
    assert.equal(readClaudeAccountPoolState(options.filePath).accounts[account.id].id, account.id);
    assert.equal(existsSync(sentinel), true);
  }
});

test("an existing malformed account list fails closed and is never replaced as first-run state", () => {
  const options = fixture();
  const damaged = '{"version":1,"policy":';
  writeFileSync(options.filePath, damaged, { mode: 0o600 });
  assert.throws(() => readClaudeAccountPoolState(options.filePath), /could not be read as JSON/i);
  assert.throws(() => createClaudeSubscriptionAccount(options), /could not be read as JSON/i);
  assert.equal(readFileSync(options.filePath, "utf8"), damaged);
});

test("an unreadable account-list path fails closed instead of becoming an empty pool", () => {
  const options = fixture();
  mkdirSync(options.filePath);
  assert.throws(() => readClaudeAccountPoolState(options.filePath), /not a regular file/i);
  assert.throws(() => createClaudeSubscriptionAccount(options), /not a regular file/i);
});

test("claudeAccountPoolConfigured answers true only when enabled and has active unpaused accounts", () => {
  const options = fixture();
  assert.equal(claudeAccountPoolConfigured(options), false);
  const account = createClaudeSubscriptionAccount(options);
  assert.equal(claudeAccountPoolConfigured(options), true);

  const state = readClaudeAccountPoolState(options.filePath);
  state.accounts[account.id].paused = true;
  writeClaudeAccountPoolState(state, options.filePath);
  assert.equal(claudeAccountPoolConfigured(options), false);

  state.accounts[account.id].paused = false;
  state.policy.enabled = false;
  writeClaudeAccountPoolState(state, options.filePath);
  assert.equal(claudeAccountPoolConfigured(options), false);
});
