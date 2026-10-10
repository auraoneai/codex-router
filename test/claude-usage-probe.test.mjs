import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as rawWriteFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { protectPrivateFile } from "../src/file-security.mjs";
import {
  clearClaudeAccountUsageCacheForTests,
  cachedClaudeAccountUsageById,
  recordClaudeAccountUsage,
} from "../src/claude-account-usage.mjs";
import {
  clearClaudeAccountAuthInvalid,
  isClaudeAccountAuthInvalid,
  resetClaudeRotationStateForTests,
} from "../src/claude-account-rotation.mjs";
import {
  clearInFlightProbesForTest,
  executeProbeClaudeAccountUsage,
  nextKnownClaudeResetAt,
  probeClaudeAccountUsage,
  resetClaudeProbeTimersForTest,
  scheduleClaudePostTurnUsageProbe,
  scheduleClaudeResetAwareProbe,
  triggerClaudeEmergencyDepletionProbe,
  USAGE_PROBE_COMFORTABLE_MAX_AGE_MS,
  USAGE_PROBE_RATE_LIMIT_BACKOFF_MS,
  USAGE_URL,
} from "../src/claude-usage-probe.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createValidClaudeAccountRecord(id, overrides = {}) {
  return {
    id,
    state: "active",
    paused: false,
    priority: 50,
    label: "Test Account",
    createdAt: new Date().toISOString(),
    identity: { accountId: `uuid-${id}`, email: `${id}@example.com` },
    subscription: { status: "usable" },
    health: { state: "healthy" },
    turns: 0,
    requests: 0,
    ...overrides,
  };
}

test.beforeEach(() => {
  clearClaudeAccountUsageCacheForTests();
  resetClaudeRotationStateForTests();
  resetClaudeProbeTimersForTest();
  clearInFlightProbesForTest();
});

test("nextKnownClaudeResetAt computes earliest upcoming reset timestamp across windows", () => {
  const now = 1_000_000_000_000;

  // Single account with multiple windows
  const account1 = {
    id: "clacct_0000000000000001",
    fiveHour: { resetsAtMs: now + 5000 },
    weekly: { resetsAtMs: now + 20000 },
    fable: { resetsAtMs: now + 15000 },
  };

  assert.equal(nextKnownClaudeResetAt([account1], { now }), now + 5000);

  // Multiple accounts, weekly is earliest
  const account2 = {
    id: "clacct_0000000000000002",
    fiveHour: { resetsAtMs: now + 10000 },
    weekly: { resetsAtMs: now + 2000 },
  };

  assert.equal(nextKnownClaudeResetAt([account1, account2], { now }), now + 2000);

  // Epoch seconds conversion
  const accountSeconds = {
    id: "clacct_0000000000000sec",
    fiveHour: { resetsAtMs: 1_700_000_000 }, // seconds (< 1e11)
  };
  assert.equal(
    nextKnownClaudeResetAt([accountSeconds], { now: 1_699_000_000_000 }),
    1_700_000_000_000,
  );

  // Past resets are ignored
  const accountPast = {
    id: "clacct_000000000000past",
    fiveHour: { resetsAtMs: now - 5000 },
    weekly: { resetsAtMs: now },
  };
  assert.equal(nextKnownClaudeResetAt([accountPast], { now }), null);

  // Map and Object inputs
  const mapAccounts = new Map([
    ["a1", { fiveHour: { resetsAtMs: now + 8000 } }],
    ["a2", { fable: { resetsAtMs: now + 4000 } }],
  ]);
  assert.equal(nextKnownClaudeResetAt(mapAccounts, { now }), now + 4000);

  const objAccounts = {
    a1: { weekly: { resetsAtMs: now + 6000 } },
  };
  assert.equal(nextKnownClaudeResetAt(objAccounts, { now }), now + 6000);
});

test("executeProbeClaudeAccountUsage performs HTTP probe, verifies headers, and updates cache", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-test-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const accountId = "clacct_0000000000000001";
  const homeDir = path.join(homesDir, accountId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  writeFileSync(
    path.join(homeDir, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access-token-123",
        refreshToken: "test-refresh-token-123",
        expiresAt: Date.now() + 3600_000,
      },
    }),
    { mode: 0o600 },
  );

  const initialPool = {
    version: 1,
    policy: { enabled: true, mode: "switch", selectedAccountId: accountId },
    accounts: {
      [accountId]: createValidClaudeAccountRecord(accountId, { label: "Primary Work" }),
    },
  };
  writeFileSync(poolPath, JSON.stringify(initialPool), { mode: 0o600 });

  let receivedRequest = null;
  const server = http.createServer((request, response) => {
    receivedRequest = {
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    };

    response.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.35",
      "anthropic-ratelimit-unified-5h-reset": "1727200000",
      "anthropic-ratelimit-unified-7d-utilization": "0.60",
      "anthropic-ratelimit-unified-7d-reset": "1727300000",
      "anthropic-ratelimit-unified-status": "allowed",
    });
    response.end(JSON.stringify({ status: "ok" }));
  });

  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    const snapshot = await executeProbeClaudeAccountUsage({
      poolPath,
      homesDir,
      cachePath,
      usageUrl,
    });

    assert.equal(snapshot.version, 1);
    assert.ok(snapshot.fetchedAt);
    assert.equal(snapshot.accounts.length, 1);

    const acct = snapshot.accounts[0];
    assert.equal(acct.id, accountId);
    assert.equal(acct.preferred, true);
    assert.equal(acct.label, "Primary Work");
    assert.equal(acct.fiveHour.usedPercent, 35);
    assert.equal(acct.fiveHour.remainingPercent, 65);
    assert.equal(acct.fiveHour.resetsAtMs, 1727200000000);
    assert.equal(acct.weekly.usedPercent, 60);
    assert.equal(acct.weekly.remainingPercent, 40);
    assert.equal(acct.weekly.resetsAtMs, 1727300000000);
    assert.equal(acct.status, "allowed");

    // Verify received HTTP request
    assert.ok(receivedRequest);
    assert.equal(receivedRequest.method, "GET");
    assert.equal(receivedRequest.url, "/api/oauth/usage");
    assert.equal(receivedRequest.headers.authorization, "Bearer test-access-token-123");
    assert.equal(receivedRequest.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(receivedRequest.headers["anthropic-version"], "2023-06-01");
    assert.match(receivedRequest.headers["user-agent"], /^codex-router\//);

    // Verify cache file was written to disk
    assert.equal(existsSync(cachePath), true);
    const diskContent = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(diskContent.version, 1);
    assert.equal(diskContent.accounts[0].id, accountId);
    assert.equal(diskContent.accounts[0].fiveHour.remainingPercent, 65);

    // Verify cached reader picks it up
    const cached = cachedClaudeAccountUsageById({ usagePath: cachePath, force: true });
    assert.equal(cached.get(accountId)?.fiveHour?.remainingPercent, 65);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("executeProbeClaudeAccountUsage parses JSON body if headers are absent", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-json-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const accountId = "clacct_0000000000000002";
  const homeDir = path.join(homesDir, accountId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  writeFileSync(
    path.join(homeDir, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-token-json",
        expiresAt: Date.now() + 3600_000,
      },
    }),
    { mode: 0o600 },
  );

  const initialPool = {
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: {
      [accountId]: createValidClaudeAccountRecord(accountId, { label: "JSON account" }),
    },
  };
  writeFileSync(poolPath, JSON.stringify(initialPool), { mode: 0o600 });

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      five_hour: { utilization: 0.15, reset: 1727250000 },
      seven_day: { utilization: 0.30, reset: 1727350000 },
      status: "allowed",
    }));
  });

  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    const snapshot = await executeProbeClaudeAccountUsage({
      poolPath,
      homesDir,
      cachePath,
      usageUrl,
    });

    const acct = snapshot.accounts[0];
    assert.equal(acct.fiveHour.usedPercent, 15);
    assert.equal(acct.fiveHour.remainingPercent, 85);
    assert.equal(acct.weekly.usedPercent, 30);
    assert.equal(acct.weekly.remainingPercent, 70);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("executeProbeClaudeAccountUsage marks account auth invalid on 401 response", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-401-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const accountId = "clacct_0000000000000003";
  const homeDir = path.join(homesDir, accountId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  writeFileSync(
    path.join(homeDir, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "invalid-token",
        expiresAt: Date.now() + 3600_000,
      },
    }),
    { mode: 0o600 },
  );

  const initialPool = {
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: {
      [accountId]: createValidClaudeAccountRecord(accountId, { label: "Revoked Account" }),
    },
  };
  writeFileSync(poolPath, JSON.stringify(initialPool), { mode: 0o600 });

  const server = http.createServer((request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_token" }));
  });

  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    assert.equal(isClaudeAccountAuthInvalid(accountId), false);

    const snapshot = await executeProbeClaudeAccountUsage({
      poolPath,
      homesDir,
      cachePath,
      usageUrl,
    });

    assert.equal(snapshot.accounts.length, 1);
    const acct = snapshot.accounts[0];
    assert.equal(acct.authInvalid, true);
    assert.equal(acct.authErrorCode, "token_revoked");
    assert.match(acct.error, /invalid_token/);

    // Verify marked auth-invalid in rotation module
    assert.equal(isClaudeAccountAuthInvalid(accountId), true);

    // Verify cache file reflects authInvalid
    const diskContent = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(diskContent.accounts[0].authInvalid, true);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("scheduleClaudeResetAwareProbe debounces and handles delay bounds", () => {
  const now = 1_000_000;
  let probeCalled = 0;
  const mockProbe = async () => { probeCalled += 1; };

  // Past reset returns null
  assert.equal(scheduleClaudeResetAwareProbe(now - 1000, { now, probe: mockProbe }), null);
  assert.equal(scheduleClaudeResetAwareProbe(0, { now, probe: mockProbe }), null);

  // Future reset returns timer handle
  const timer1 = scheduleClaudeResetAwareProbe(now + 10_000, { now, probe: mockProbe });
  assert.ok(timer1);

  // Calling again with different time debounces and replaces timer
  const timer2 = scheduleClaudeResetAwareProbe(now + 20_000, { now, probe: mockProbe });
  assert.ok(timer2);
  assert.notEqual(timer1, timer2);

  // Reset beyond 24h is capped and returns null
  const over24h = now + 25 * 60 * 60 * 1000;
  assert.equal(scheduleClaudeResetAwareProbe(over24h, { now, probe: mockProbe }), null);

  resetClaudeProbeTimersForTest();
});

test("triggerClaudeEmergencyDepletionProbe enforces 30s debounce", () => {
  let probeCalls = 0;
  const mockProbe = async () => { probeCalls += 1; };

  const start = 1_000_000;

  // First call succeeds
  const res1 = triggerClaudeEmergencyDepletionProbe({ now: start, probe: mockProbe });
  assert.equal(res1, true);
  assert.equal(probeCalls, 1);

  // Second call 10s later is debounced
  const res2 = triggerClaudeEmergencyDepletionProbe({ now: start + 10_000, probe: mockProbe });
  assert.equal(res2, false);
  assert.equal(probeCalls, 1);

  // Call 31s later succeeds
  const res3 = triggerClaudeEmergencyDepletionProbe({ now: start + 31_000, probe: mockProbe });
  assert.equal(res3, true);
  assert.equal(probeCalls, 2);

  resetClaudeProbeTimersForTest();
});

test("scheduleClaudePostTurnUsageProbe enforces 45s debounce", () => {
  const start = 1_000_000;
  let probeCalls = 0;
  const mockProbe = async () => { probeCalls += 1; };

  // First call schedules
  const timer1 = scheduleClaudePostTurnUsageProbe(15_000, { now: start, probe: mockProbe });
  assert.ok(timer1);

  // Second call within 45s returns null (debounced)
  const timer2 = scheduleClaudePostTurnUsageProbe(15_000, { now: start + 20_000, probe: mockProbe });
  assert.equal(timer2, null);

  resetClaudeProbeTimersForTest();
});

test("probeClaudeAccountUsage deduplicates concurrent in-flight calls", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-dedup-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const accountId = "clacct_0000000000000004";
  const homeDir = path.join(homesDir, accountId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  writeFileSync(
    path.join(homeDir, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "dedup-token",
        expiresAt: Date.now() + 3600_000,
      },
    }),
    { mode: 0o600 },
  );

  const initialPool = {
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: {
      [accountId]: createValidClaudeAccountRecord(accountId),
    },
  };
  writeFileSync(poolPath, JSON.stringify(initialPool), { mode: 0o600 });

  let serverHits = 0;
  const server = http.createServer((request, response) => {
    serverHits += 1;
    setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.10",
      });
      response.end(JSON.stringify({ ok: true }));
    }, 50);
  });

  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    const [res1, res2] = await Promise.all([
      probeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl }),
      probeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl }),
    ]);

    assert.equal(serverHits, 1, "Two concurrent calls must hit the endpoint only once");
    assert.deepEqual(res1, res2);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a probe does not overwrite a reading the forwarder recorded while it was in flight", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-merge-test-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");
  const accountId = "clacct_0000000000000077";
  mkdirSync(path.join(homesDir, accountId), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(homesDir, accountId, "credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "merge-access", refreshToken: "merge-refresh", expiresAt: Date.now() + 3600_000 },
  }), { mode: 0o600 });
  writeFileSync(poolPath, JSON.stringify({
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: { [accountId]: createValidClaudeAccountRecord(accountId) },
  }), { mode: 0o600 });

  const probeStartedAt = Date.now();
  try {
    await executeProbeClaudeAccountUsage({
      poolPath,
      homesDir,
      cachePath,
      now: probeStartedAt,
      fetchImpl: async () => {
        // A turn completes while the probe waits on the network.
        recordClaudeAccountUsage(accountId, {
          fiveHour: { usedPercent: 97, remainingPercent: 3, resetsAtMs: probeStartedAt + 3600_000 },
        }, { now: probeStartedAt + 500, usagePath: cachePath });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ five_hour: { utilization: 40, resets_at: new Date(probeStartedAt + 3600_000).toISOString() } }),
        };
      },
    });
    const row = JSON.parse(readFileSync(cachePath, "utf8")).accounts.find((a) => a.id === accountId);
    assert.equal(row.fiveHour.remainingPercent, 3, "the newer passive reading survives the probe's write");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a rate-limited probe keeps the last reading and its time, then backs off", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-429-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const accountId = "clacct_0000000000000429";
  const homeDir = path.join(homesDir, accountId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(homeDir, "credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "valid-token", expiresAt: Date.now() + 3600_000 } }),
    { mode: 0o600 },
  );
  writeFileSync(poolPath, JSON.stringify({
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: { [accountId]: createValidClaudeAccountRecord(accountId) },
  }), { mode: 0o600 });

  const readAt = "2026-10-10T13:58:00.000Z";
  const fiveHour = { usedPercent: 56, remainingPercent: 44, resetsAtMs: Date.now() + 3600_000 };
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    fetchedAt: readAt,
    accounts: [{ id: accountId, fiveHour, weekly: null, fetchedAt: readAt }],
  }), { mode: 0o600 });

  let requests = 0;
  let retryAfter;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(429, {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }));
  });
  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    const now = Date.now();
    const first = await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now });
    const row = first.accounts[0];
    assert.equal(requests, 1);
    assert.match(row.error, /Rate limited/);
    assert.equal(row.rateLimited, true);
    assert.equal(row.authInvalid, undefined);
    assert.deepEqual(row.fiveHour, fiveHour);
    // The kept reading keeps the time it was read, not the time it was refused.
    assert.equal(row.fetchedAt, readAt);
    assert.equal(row.probeBackoffUntil, now + USAGE_PROBE_RATE_LIMIT_BACKOFF_MS);

    // Inside the backoff the endpoint is not asked again.
    const second = await executeProbeClaudeAccountUsage({
      poolPath, homesDir, cachePath, usageUrl, now: now + 60_000,
    });
    assert.equal(requests, 1);
    assert.equal(second.accounts[0].probeBackoffUntil, row.probeBackoffUntil);

    // Once it lapses the probe asks again, and a repeat refusal doubles the wait.
    const later = row.probeBackoffUntil + 1;
    const third = await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now: later });
    assert.equal(requests, 2);
    assert.equal(third.accounts[0].probeBackoffUntil, later + 2 * USAGE_PROBE_RATE_LIMIT_BACKOFF_MS);

    // A short Retry-After does not cut the escalation short...
    retryAfter = "60";
    const evenLater = third.accounts[0].probeBackoffUntil + 1;
    const fourth = await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now: evenLater });
    assert.equal(requests, 3);
    assert.equal(fourth.accounts[0].probeBackoffUntil, evenLater + 4 * USAGE_PROBE_RATE_LIMIT_BACKOFF_MS);

    // ...and a long one is honored past the cap.
    retryAfter = "7200";
    const latest = fourth.accounts[0].probeBackoffUntil + 1;
    const fifth = await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now: latest });
    assert.equal(requests, 4);
    assert.equal(fifth.accounts[0].probeBackoffUntil, latest + 7_200_000);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an account with plenty left on a recent reading is not probed", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-probe-comfortable-"));
  const poolPath = path.join(stateDir, "claude-account-pool.json");
  const homesDir = path.join(stateDir, "claude-accounts");
  const cachePath = path.join(stateDir, "claude-account-usage.json");

  const plentyId = "clacct_000000000000plty";
  const lowId = "clacct_0000000000000low";
  for (const id of [plentyId, lowId]) {
    mkdirSync(path.join(homesDir, id), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(homesDir, id, "credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: `token-${id}`, expiresAt: Date.now() + 3600_000 } }),
      { mode: 0o600 },
    );
  }
  writeFileSync(poolPath, JSON.stringify({
    version: 1,
    policy: { enabled: true, mode: "switch" },
    accounts: {
      [plentyId]: createValidClaudeAccountRecord(plentyId),
      [lowId]: createValidClaudeAccountRecord(lowId),
    },
  }), { mode: 0o600 });

  const now = Date.now();
  const readAt = new Date(now - 60_000).toISOString();
  const window = (remainingPercent) => ({
    usedPercent: 100 - remainingPercent, remainingPercent, resetsAtMs: now + 3600_000,
  });
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    fetchedAt: readAt,
    accounts: [
      { id: plentyId, fiveHour: window(90), weekly: window(70), fetchedAt: readAt },
      { id: lowId, fiveHour: window(30), weekly: window(70), fetchedAt: readAt },
    ],
  }), { mode: 0o600 });

  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ five_hour: { utilization: 20 }, seven_day: { utilization: 20 } }));
  });
  const port = await listen(server);
  const usageUrl = `http://127.0.0.1:${port}/api/oauth/usage`;

  try {
    await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now });
    // Only the account whose reading could change a rotation decision is asked.
    assert.deepEqual(asked, [`Bearer token-${lowId}`]);

    // A spent window cannot change before its reset, so it is not asked either.
    asked.length = 0;
    const spent = JSON.parse(readFileSync(cachePath, "utf8"));
    spent.accounts.find((row) => row.id === lowId).weekly = window(0);
    writeFileSync(cachePath, JSON.stringify(spent), { mode: 0o600 });
    await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now });
    assert.deepEqual(asked, []);

    // An explicit `usage` asks every account regardless.
    asked.length = 0;
    clearInFlightProbesForTest();
    await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now, force: true });
    assert.equal(asked.length, 2);

    // A comfortable reading that has aged out is asked again.
    asked.length = 0;
    const later = now + USAGE_PROBE_COMFORTABLE_MAX_AGE_MS + 120_000;
    await executeProbeClaudeAccountUsage({ poolPath, homesDir, cachePath, usageUrl, now: later });
    assert.equal(asked.length, 2);
  } finally {
    await close(server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
