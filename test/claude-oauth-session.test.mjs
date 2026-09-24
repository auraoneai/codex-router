import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearInFlightRefreshesForTest,
  claudeOAuthSession,
  ensureFreshClaudeOAuthToken,
  EXPIRY_BUFFER_MS,
  OAUTH_BETA_HEADER,
} from "../src/claude-oauth-session.mjs";
import {
  claudeSubscriptionAccountCredentialsPath,
  createClaudeSubscriptionAccount,
  readClaudeAccountPoolState,
} from "../src/claude-account-pool.mjs";
import { protectPrivateFile } from "../src/file-security.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-session-test-"));
  return {
    root,
    filePath: path.join(root, "claude-account-pool.json"),
    homesDir: path.join(root, "claude-accounts"),
  };
}

function setupAccountWithCredentials(options, {
  accessToken = "init-access-token",
  refreshToken = "init-refresh-token",
  expiresAt = Date.now() + 3600_000,
} = {}) {
  const account = createClaudeSubscriptionAccount(options);
  const credPath = claudeSubscriptionAccountCredentialsPath(account.id, options);
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt,
        email: "test@example.com",
      },
    }),
    { mode: 0o600 },
  );
  return account;
}

test("claudeOAuthSession reads credentials and shapes headers correctly", () => {
  const options = fixture();
  const account = setupAccountWithCredentials(options);
  const session = claudeOAuthSession(account.id, options);

  assert.ok(session);
  assert.equal(session.accountId, account.id);
  assert.equal(session.accessToken, "init-access-token");
  assert.equal(session.refreshToken, "init-refresh-token");
  assert.equal(session.expired, false);
  assert.equal(session.needsRefresh, false);
  assert.equal(session.headers.authorization, "Bearer init-access-token");
  assert.equal(session.headers["anthropic-beta"], OAUTH_BETA_HEADER);
});

test("claudeOAuthSession detects expiry margin (5 minutes buffer)", () => {
  const options = fixture();
  const now = Date.now();
  // Token expires in 4 minutes (less than 5-minute buffer)
  const account = setupAccountWithCredentials(options, { expiresAt: now + 4 * 60 * 1000 });
  const session = claudeOAuthSession(account.id, { ...options, now });

  assert.equal(session.expired, false);
  assert.equal(session.needsRefresh, true);
});

test("ensureFreshClaudeOAuthToken refreshes token and persists rotated credentials", async () => {
  const options = fixture();
  clearInFlightRefreshesForTest();
  const now = Date.now();
  const account = setupAccountWithCredentials(options, { expiresAt: now + 2 * 60 * 1000 });

  let endpointCalled = 0;
  const fakeFetch = async (url, fetchOptions) => {
    endpointCalled += 1;
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "init-refresh-token");
    return {
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200,
      }),
    };
  };

  const refreshed = await ensureFreshClaudeOAuthToken(account.id, {
    ...options,
    now,
    fetchImpl: fakeFetch,
  });

  assert.equal(endpointCalled, 1);
  assert.equal(refreshed.accessToken, "new-access-token");
  assert.equal(refreshed.refreshToken, "new-refresh-token");
  assert.equal(refreshed.needsRefresh, false);

  // Assert credentials.json was persisted
  const credPath = claudeSubscriptionAccountCredentialsPath(account.id, options);
  const stored = JSON.parse(readFileSync(credPath, "utf8"));
  assert.equal(stored.claudeAiOauth.accessToken, "new-access-token");
  assert.equal(stored.claudeAiOauth.refreshToken, "new-refresh-token");
});

test("concurrent callers share single in-flight refresh", async () => {
  const options = fixture();
  clearInFlightRefreshesForTest();
  const now = Date.now();
  const account = setupAccountWithCredentials(options, { expiresAt: now + 2 * 60 * 1000 });

  let fetchCalls = 0;
  const fakeFetch = async () => {
    fetchCalls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return {
      ok: true,
      json: async () => ({
        access_token: "shared-refreshed-token",
        expires_in: 3600,
      }),
    };
  };

  const [res1, res2] = await Promise.all([
    ensureFreshClaudeOAuthToken(account.id, { ...options, now, fetchImpl: fakeFetch }),
    ensureFreshClaudeOAuthToken(account.id, { ...options, now, fetchImpl: fakeFetch }),
  ]);

  assert.equal(fetchCalls, 1, "fetch must be called only once for concurrent requests");
  assert.equal(res1.accessToken, "shared-refreshed-token");
  assert.equal(res2.accessToken, "shared-refreshed-token");
});

test("invalid_grant marks account reauth-required in pool health", async () => {
  const options = fixture();
  clearInFlightRefreshesForTest();
  const now = Date.now();
  const account = setupAccountWithCredentials(options, { expiresAt: now - 1000 });

  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: "invalid_grant",
      error_description: "Refresh token is invalid or expired",
    }),
  });

  await ensureFreshClaudeOAuthToken(account.id, { ...options, now, fetchImpl: fakeFetch });

  const state = readClaudeAccountPoolState(options.filePath);
  assert.equal(state.accounts[account.id].health.state, "reauth-required");
  assert.match(state.accounts[account.id].health.lastError, /invalid_grant/);
});

test("invalid_client does not strike account health (systemic issue)", async () => {
  const options = fixture();
  clearInFlightRefreshesForTest();
  const now = Date.now();
  const account = setupAccountWithCredentials(options, { expiresAt: now - 1000 });

  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: "invalid_client",
      error_description: "Client authentication failed",
    }),
  });

  await ensureFreshClaudeOAuthToken(account.id, { ...options, now, fetchImpl: fakeFetch });

  const state = readClaudeAccountPoolState(options.filePath);
  assert.equal(state.accounts[account.id].health.state, "healthy");
});

test("transient network/500 error leaves account eligible with stale token", async () => {
  const options = fixture();
  clearInFlightRefreshesForTest();
  const now = Date.now();
  const account = setupAccountWithCredentials(options, { expiresAt: now - 1000 });

  const fakeFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: "bad_gateway" }),
  });

  const session = await ensureFreshClaudeOAuthToken(account.id, { ...options, now, fetchImpl: fakeFetch });

  // Account stays healthy and returns stale session
  const state = readClaudeAccountPoolState(options.filePath);
  assert.equal(state.accounts[account.id].health.state, "healthy");
  assert.equal(session.accessToken, "init-access-token");
});
