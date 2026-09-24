import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  credentialFingerprint,
  importClaudeAccount,
  readClaudeCodeCredentials,
  resolveClaudeIdentity,
} from "../src/claude-oauth-credentials.mjs";
import {
  claudeSubscriptionAccountCredentialsPath,
  readClaudeAccountPoolState,
} from "../src/claude-account-pool.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-creds-test-"));
  return {
    root,
    filePath: path.join(root, "claude-account-pool.json"),
    homesDir: path.join(root, "claude-accounts"),
    credentialsFile: path.join(root, ".credentials.json"),
  };
}

test("credentialFingerprint prefers refreshToken over accessToken", () => {
  const withBoth = {
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
  };
  const withAccessOnly = {
    accessToken: "access-token-value",
  };
  const fpBoth = credentialFingerprint(withBoth);
  const fpAccess = credentialFingerprint(withAccessOnly);
  assert.ok(fpBoth);
  assert.ok(fpAccess);
  assert.notEqual(fpBoth, fpAccess);

  // Lineage test: different accessToken with same refreshToken produces the same fingerprint
  const withRotatedAccess = {
    accessToken: "new-access-token-value",
    refreshToken: "refresh-token-value",
  };
  assert.equal(credentialFingerprint(withRotatedAccess), fpBoth);
});

test("readClaudeCodeCredentials follows macOS keychain-then-file precedence", () => {
  const options = fixture();
  const calls = [];
  const execFileSyncImpl = (bin, args) => {
    calls.push(args);
    // Return a valid credential on the second call (service-only)
    if (args.includes("-a")) {
      throw new Error("Item not found");
    }
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: "keychain-token",
        refreshToken: "keychain-refresh",
      },
    });
  };

  const creds = readClaudeCodeCredentials({
    platform: "darwin",
    env: { USER: "testuser" },
    execFileSyncImpl,
    credentialsFile: options.credentialsFile,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["find-generic-password", "-s", "Claude Code-credentials", "-a", "testuser", "-w"]);
  assert.deepEqual(calls[1], ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  assert.equal(creds?.claudeAiOauth?.accessToken, "keychain-token");
});

test("readClaudeCodeCredentials skips token-less stray keychain item and falls back to file", () => {
  const options = fixture();
  // Write valid file fallback
  writeFileSync(
    options.credentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-token",
        refreshToken: "file-refresh",
      },
    }),
  );

  const execFileSyncImpl = (bin, args) => {
    // Return a stray item carrying only mcpOAuth
    return JSON.stringify({
      mcpOAuth: {
        someService: { token: "mcp-token" },
      },
    });
  };

  const creds = readClaudeCodeCredentials({
    platform: "darwin",
    env: { USER: "testuser" },
    execFileSyncImpl,
    credentialsFile: options.credentialsFile,
  });

  assert.equal(creds?.claudeAiOauth?.accessToken, "file-token");
});

test("readClaudeCodeCredentials on Linux reads credentials file directly", () => {
  const options = fixture();
  writeFileSync(
    options.credentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "linux-token",
        refreshToken: "linux-refresh",
      },
    }),
  );

  let securityCalled = false;
  const execFileSyncImpl = () => {
    securityCalled = true;
    throw new Error("Should not be called");
  };

  const creds = readClaudeCodeCredentials({
    platform: "linux",
    execFileSyncImpl,
    credentialsFile: options.credentialsFile,
  });

  assert.equal(securityCalled, false);
  assert.equal(creds?.claudeAiOauth?.accessToken, "linux-token");
});

test("resolveClaudeIdentity parses profile correctly", async () => {
  const fakeFetch = async (url, options) => {
    assert.match(options.headers.Authorization, /^Bearer valid-token$/);
    return {
      ok: true,
      json: async () => ({
        account: {
          uuid: "user-uuid-123",
          email_address: "alice@example.com",
        },
        organization: {
          uuid: "org-uuid-456",
          name: "Alice Org",
        },
      }),
    };
  };

  const identity = await resolveClaudeIdentity("valid-token", { fetchImpl: fakeFetch });
  assert.deepEqual(identity, {
    accountId: "user-uuid-123",
    email: "alice@example.com",
    organizationUuid: "org-uuid-456",
  });

  // Returns undefined on HTTP error or missing uuid
  const failFetch = async () => ({ ok: false });
  assert.equal(await resolveClaudeIdentity("bad-token", { fetchImpl: failFetch }), undefined);
});

test("importClaudeAccount creates account and re-import updates in place", async () => {
  const options = fixture();
  writeFileSync(
    options.credentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "import-access-token",
        refreshToken: "import-refresh-token",
        expiresAt: Date.now() + 3600_000,
      },
    }),
  );

  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      account: { uuid: "acct-uuid-1", email_address: "first@example.com" },
      organization: { uuid: "org-uuid-1" },
    }),
  });

  // First import creates account
  const imported1 = await importClaudeAccount(undefined, {
    ...options,
    platform: "linux",
    fetchImpl: fakeFetch,
  });

  assert.ok(imported1);
  assert.equal(imported1.identity?.accountId, "acct-uuid-1");
  assert.equal(imported1.identity?.email, "first@example.com");
  assert.equal(imported1.label, "first@example.com");

  const state1 = readClaudeAccountPoolState(options.filePath);
  assert.equal(Object.keys(state1.accounts).length, 1);

  // Check private credentials file was written
  const credPath = claudeSubscriptionAccountCredentialsPath(imported1.id, options);
  assert.equal(existsSync(credPath), true);
  const storedCreds = JSON.parse(readFileSync(credPath, "utf8"));
  assert.equal(storedCreds.claudeAiOauth.accessToken, "import-access-token");

  // Second import with same identity updates in place rather than creating new account
  writeFileSync(
    options.credentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "rotated-access-token",
        refreshToken: "import-refresh-token",
        expiresAt: Date.now() + 7200_000,
      },
    }),
  );

  const imported2 = await importClaudeAccount("Updated Label", {
    ...options,
    platform: "linux",
    fetchImpl: fakeFetch,
  });

  assert.equal(imported2.id, imported1.id);
  assert.equal(imported2.label, "Updated Label");

  const state2 = readClaudeAccountPoolState(options.filePath);
  assert.equal(Object.keys(state2.accounts).length, 1);

  const updatedCreds = JSON.parse(readFileSync(credPath, "utf8"));
  assert.equal(updatedCreds.claudeAiOauth.accessToken, "rotated-access-token");
});

test("importClaudeAccount never leaks secrets in errors", async () => {
  const options = fixture();
  // No credentials file
  await assert.rejects(
    () => importClaudeAccount(undefined, { ...options, platform: "linux" }),
    (err) => {
      assert.match(err.message, /No valid Claude Code credentials found/);
      assert.doesNotMatch(err.message, /token|Bearer|secret/i);
      return true;
    },
  );
});

test("importClaudeAccount returns null when discovery is disabled", async () => {
  const options = fixture();
  const prevEnv = process.env.CODEX_ROUTER_NO_DISCOVERY;
  try {
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    const result = await importClaudeAccount(undefined, { ...options, platform: "linux" });
    assert.equal(result, null);
  } finally {
    if (prevEnv === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = prevEnv;
  }
});
