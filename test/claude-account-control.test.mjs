import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { protectPrivateFile } from "../src/file-security.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-account-control-"));

const fakeSecurity = path.join(stateDir, "fake-security");
writeFileSync(fakeSecurity, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const fakeCreds = path.join(stateDir, "nonexistent-creds.json");

const env = {
  ...process.env,
  MODEL_ROUTER_STATE_DIR: stateDir,
  MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: path.join(stateDir, "claude-account-pool.json"),
  MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: path.join(stateDir, "claude-accounts"),
  MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: path.join(stateDir, "claude-account-usage.json"),
  CLAUDE_SECURITY_BIN: fakeSecurity,
  CLAUDE_CREDENTIALS_FILE: fakeCreds,
};

const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, "src/control.mjs"), ...args], {
  env,
  encoding: "utf8",
}));

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("claude-account-pool commands: status, add, select, enable, disable, usage, remove", () => {
  // Empty status first
  const status1 = run("claude-account-pool", "status");
  assert.equal(status1.version, 1);
  assert.equal(status1.policy.mode, "switch");
  assert.deepEqual(status1.accounts, {});

  // Add when logged out fails with clear guidance
  assert.throws(
    () => run("claude-account-pool", "add", "MyClaude"),
    (err) => {
      assert.match(String(err?.stderr || err?.message), /No valid Claude Code credentials found\. Please log into Claude Code with 'claude' first\./);
      return true;
    },
  );

  // Simulate credentials by writing a fixture credentials.json
  const fakeCredsFile = path.join(stateDir, ".claude-creds.json");
  writeFileSync(
    fakeCredsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "ctrl-access-token",
        refreshToken: "ctrl-refresh-token",
        expiresAt: Date.now() + 3600_000,
        email: "claude-ctrl@example.com",
      },
    }),
    { mode: 0o600 },
  );

  // Directly create an account into the pool for testing control surface actions
  const poolFile = path.join(stateDir, "claude-account-pool.json");
  const id1 = "clacct_0000000000000001";
  const home1 = path.join(stateDir, "claude-accounts", id1);
  mkdirSync(home1, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home1, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "ctrl-access-token-1",
        refreshToken: "ctrl-refresh-token-1",
        expiresAt: Date.now() + 3600_000,
        email: "user1@example.com",
      },
    }),
    { mode: 0o600 },
  );

  const initialPool = {
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: {
      [id1]: {
        id: id1,
        state: "active",
        paused: false,
        priority: 50,
        label: "User 1",
        createdAt: new Date().toISOString(),
        identity: { accountId: "uuid-1", email: "user1@example.com" },
        subscription: { status: "usable" },
        health: { state: "healthy" },
        turns: 0,
        requests: 0,
      },
    },
  };
  writeFileSync(poolFile, JSON.stringify(initialPool), { mode: 0o600 });

  // Status now shows the account
  const status2 = run("claude-account-pool", "status");
  assert.equal(Object.keys(status2.accounts).length, 1);
  assert.equal(status2.accounts[id1].label, "User 1");
  assert.equal(status2.accounts[id1].state, "active");

  // Select account
  const selectRes = run("claude-account-pool", "select", id1);
  assert.equal(selectRes.policy.selectedAccountId, id1);

  // Disable account
  const disableRes = run("claude-account-pool", "disable", id1);
  assert.equal(disableRes.account.paused, true);

  // Enable account
  const enableRes = run("claude-account-pool", "enable", id1);
  assert.equal(enableRes.account.paused, false);

  // Usage cached
  const usageRes = run("claude-account-pool", "usage", "cached");
  assert.ok(usageRes.fetchedAt);
  assert.ok(Array.isArray(usageRes.accounts));

  // Usage live (one-shot probe)
  const usageLive = run("claude-account-pool", "usage");
  assert.ok(usageLive.fetchedAt);
  assert.ok(Array.isArray(usageLive.accounts));

  // Remove account
  const removeRes = run("claude-account-pool", "remove", id1);
  assert.equal(removeRes.account.id, id1);
  assert.equal(removeRes.account.state, "revoked");

  // Status after removal is empty
  const status3 = run("claude-account-pool", "status");
  assert.deepEqual(status3.accounts, {});
});

test("claude-account-pool invalid command throws exact usage string", () => {
  assert.throws(
    () => run("claude-account-pool", "invalid-subcommand"),
    (err) => {
      assert.match(
        String(err?.stderr || err?.message),
        /Usage: control claude-account-pool status\|add \[label\]\|remove <acct_id>\|select <acct_id>\|enable <acct_id>\|disable <acct_id>\|usage \[cached\]/,
      );
      return true;
    },
  );
});

test("no-discovery Claude account reads never import account modules or create pool state", () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "claude-account-no-discovery-"));
  const poolPath = path.join(isolated, "private", "claude-account-pool.json");
  const disabledEnv = {
    ...process.env,
    CODEX_ROUTER_NO_DISCOVERY: "1",
    MODEL_ROUTER_STATE_DIR: path.join(isolated, "private"),
    MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
    MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: path.join(isolated, "private", "homes"),
  };

  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(root, "src/control.mjs"), "claude-account-pool", "status"],
      { env: disabledEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
    (error) => /credential discovery is disabled/i.test(String(error?.stderr || error?.message)),
  );

  assert.equal(existsSync(poolPath), false);
  rmSync(isolated, { recursive: true, force: true });
});
