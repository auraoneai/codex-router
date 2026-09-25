import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";
import { protectPrivateFile } from "../src/file-security.mjs";
import { isClaudeAccountAuthInvalid } from "../src/claude-account-rotation.mjs";
import {
  injectClaudeAttributionSystemPrompt,
  CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT,
} from "../src/claude-attribution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-claude-pool-forwarder-internal-key-12345678";

function writePrivateJson(target, data) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  protectPrivateFile(target);
}

function createTestAccount(poolPath, homesDir, accountId, {
  label = `${accountId}@example.com`,
  plan = "pro",
  accessToken = `token_for_${accountId}`,
  refreshToken = `refresh_for_${accountId}`,
  expiresAt = Date.now() + 3600_000,
} = {}) {
  let pool = { version: 1, policy: { enabled: true, mode: "switch" }, accounts: {} };
  try {
    pool = JSON.parse(readFileSync(poolPath, "utf8"));
  } catch {}

  pool.accounts[accountId] = {
    id: accountId,
    state: "active",
    paused: false,
    priority: 50,
    label,
    createdAt: new Date().toISOString(),
    identity: { accountId: `uuid_${accountId}`, email: label },
    subscription: { status: "usable", plan },
    health: { state: "healthy" },
    turns: 0,
    requests: 0,
  };
  writePrivateJson(poolPath, pool);

  const credPath = path.join(homesDir, accountId, "credentials.json");
  writePrivateJson(credPath, {
    accessToken,
    refreshToken,
    expiresAt,
    tokenType: "Bearer",
    subscriptionTier: plan,
  });
}

async function listen(server, port) {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

async function waitForHealth(base, headers, child, errors) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors()}`);
    try {
      const health = await fetch(`${base}/health`, { headers });
      if (health.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${errors()}`);
}

test("Header shape per auth kind: OAuth pool vs legacy API key", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-header-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  createTestAccount(poolPath, homesDir, "clacct_hdrshape0001", {
    accessToken: "sk-ant-oauth-test-token-12345",
  });

  const receivedHeaders = [];
  const upstream = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.10",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor((Date.now() + 18000_000) / 1000)),
      "anthropic-ratelimit-unified-status": "allowed",
    });
    res.end(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
      ANTHROPIC_API_KEY: "legacy-anthropic-key-should-not-be-sent",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    // 1. Send request with pool active
    const resPool = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(resPool.status, 200);
    assert.equal(receivedHeaders.length, 1);
    const poolHdr = receivedHeaders[0];
    assert.equal(poolHdr.authorization, "Bearer sk-ant-oauth-test-token-12345");
    assert.equal(poolHdr["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(poolHdr["anthropic-version"], "2023-06-01");
    assert.equal(poolHdr["x-api-key"], undefined, "x-api-key must be ABSENT on pool OAuth requests");
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Header shape for legacy API key when no pool is configured", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-legacy-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  const receivedHeaders = [];
  const upstream = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello legacy" }],
    }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
      ANTHROPIC_API_KEY: "sk-ant-legacy-api-key-9999",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    const resLegacy = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(resLegacy.status, 200);
    assert.equal(receivedHeaders.length, 1);
    const legacyHdr = receivedHeaders[0];
    assert.equal(legacyHdr["x-api-key"], "sk-ant-legacy-api-key-9999");
    assert.equal(legacyHdr["anthropic-version"], "2023-06-01");
    assert.equal(legacyHdr.authorization, undefined, "Authorization header must be ABSENT on API key requests");
    assert.equal(legacyHdr["anthropic-beta"], undefined, "anthropic-beta must be ABSENT on API key requests");
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Rotation on quota-429 rotates to sibling and persists quota telemetry", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-quota429-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  createTestAccount(poolPath, homesDir, "clacct_rotfirst0001", {
    accessToken: "token_account_1",
    label: "first@example.com",
    plan: "pro",
  });
  createTestAccount(poolPath, homesDir, "clacct_rotsecond002", {
    accessToken: "token_account_2",
    label: "second@example.com",
    plan: "max5",
  });

  const attemptedTokens = [];
  const upstream = http.createServer((req, res) => {
    const token = req.headers.authorization;
    attemptedTokens.push(token);
    if (token === "Bearer token_account_1") {
      res.writeHead(429, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "1.00",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor((Date.now() + 3600_000) / 1000)),
        "anthropic-ratelimit-unified-status": "rejected",
      });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Out of usage" },
      }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.15",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor((Date.now() + 7200_000) / 1000)),
      "anthropic-ratelimit-unified-status": "allowed",
    });
    res.end(JSON.stringify({
      id: "msg_success",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ROTATED_OK" }],
    }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    const res = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "test rotate" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, "ROTATED_OK");
    assert.deepEqual(attemptedTokens, [
      "Bearer token_account_1",
      "Bearer token_account_2",
    ]);

    // Check usage persistence (wait for child process to flush write)
    const deadline = Date.now() + 3000;
    let accountUsage;
    while (Date.now() < deadline) {
      if (existsSync(usagePath)) {
        try {
          const usage = JSON.parse(readFileSync(usagePath, "utf8"));
          accountUsage = Array.isArray(usage.accounts)
            ? usage.accounts.find((a) => a.id === "clacct_rotsecond002")
            : usage.accounts?.["clacct_rotsecond002"];
          if (accountUsage) break;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(accountUsage, "Successful account quota must be stored");
    assert.equal(accountUsage.fiveHour.usedPercent, 15);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("No rotation on per-minute 429: absorbs inline and retries same account", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-ratelimit429-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  createTestAccount(poolPath, homesDir, "clacct_absorb000001", {
    accessToken: "token_account_1",
  });
  createTestAccount(poolPath, homesDir, "clacct_absorb000002", {
    accessToken: "token_account_2",
  });

  let calls = 0;
  const attemptedTokens = [];
  const upstream = http.createServer((req, res) => {
    calls++;
    attemptedTokens.push(req.headers.authorization);
    if (calls === 1) {
      // Per-minute burst limit with retry-after: 1 second
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "1",
      });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limit exceeded" },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_success",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "SAME_ACCOUNT_OK" }],
    }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    const res = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "test absorb" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, "SAME_ACCOUNT_OK");
    // Both attempts must have been made with Account 1!
    assert.deepEqual(attemptedTokens, [
      "Bearer token_account_1",
      "Bearer token_account_1",
    ]);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("401 invalidation marks account auth-invalid and rotates to next candidate", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-401-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  createTestAccount(poolPath, homesDir, "clacct_authinv00001", {
    accessToken: "invalid_token_1",
  });
  createTestAccount(poolPath, homesDir, "clacct_authinv00002", {
    accessToken: "valid_token_2",
  });

  const attemptedTokens = [];
  const upstream = http.createServer((req, res) => {
    const token = req.headers.authorization;
    attemptedTokens.push(token);
    if (token === "Bearer invalid_token_1") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "Token expired or revoked" },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_success",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "SECOND_ACCOUNT_SAVED" }],
    }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    const res = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "test 401" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, "SECOND_ACCOUNT_SAVED");
    assert.deepEqual(attemptedTokens, [
      "Bearer invalid_token_1",
      "Bearer valid_token_2",
    ]);

    // Check that Account 1 was marked auth invalid by issuing a second request;
    // Account 1 must be skipped without any upstream attempt.
    attemptedTokens.length = 0;
    const res2 = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "test 401 subsequent" }],
      }),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.content[0].text, "SECOND_ACCOUNT_SAVED");
    assert.deepEqual(
      attemptedTokens,
      ["Bearer valid_token_2"],
      "Account 1 must be skipped as auth-invalid on subsequent requests",
    );
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Fail-closed: pool configured + all credentials unreadable fails with 503 and does not use legacy key", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-fwd-failclosed-test-"));
  const poolPath = path.join(testRoot, "claude-account-pool.json");
  const homesDir = path.join(testRoot, "claude-accounts");
  const usagePath = path.join(testRoot, "claude-account-usage.json");
  const stateDir = path.join(testRoot, "state");
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();

  // Create pool with an active account, but corrupt its credentials.json file
  createTestAccount(poolPath, homesDir, "clacct_corrupted001", {
    accessToken: "corrupted",
  });
  // Corrupt credentials.json
  writeFileSync(path.join(homesDir, "clacct_corrupted001", "credentials.json"), "NOT_JSON");

  let upstreamCalled = false;
  const upstream = http.createServer((req, res) => {
    upstreamCalled = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await listen(upstream, upstreamPort);

  let forwarderStderr = "";
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: poolPath,
      MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: homesDir,
      MODEL_ROUTER_CLAUDE_ACCOUNT_USAGE: usagePath,
      ANTHROPIC_API_KEY: "legacy-key-that-must-never-be-reached",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { forwarderStderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(`http://127.0.0.1:${forwarderPort}`, {
      Authorization: `Bearer ${internalKey}`,
    }, child, () => forwarderStderr);

    const res = await fetch(`http://127.0.0.1:${forwarderPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic-api-claude-opus-4-8",
        max_tokens: 10,
        messages: [{ role: "user", content: "test failclosed" }],
      }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.type, "claude_account_pool_unavailable");
    assert.equal(upstreamCalled, false, "Upstream must never be called with the legacy key");
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude attribution system prompt injection", () => {
  // Case 1: undefined system
  const p1 = {};
  injectClaudeAttributionSystemPrompt(p1);
  assert.deepEqual(p1.system, [{ type: "text", text: CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT }]);

  // Case 2: string system
  const p2 = { system: "You are a helpful assistant." };
  injectClaudeAttributionSystemPrompt(p2);
  assert.equal(p2.system, `${CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT}\n\nYou are a helpful assistant.`);

  // Case 3: string system already containing header
  const p3 = { system: `${CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT}\n\nExisting prompt` };
  injectClaudeAttributionSystemPrompt(p3);
  assert.equal(p3.system, `${CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT}\n\nExisting prompt`);

  // Case 4: array system
  const p4 = { system: [{ type: "text", text: "You are a helpful assistant." }] };
  injectClaudeAttributionSystemPrompt(p4);
  assert.equal(p4.system.length, 2);
  assert.equal(p4.system[0].text, CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT);
  assert.equal(p4.system[1].text, "You are a helpful assistant.");

  // Case 5: array system already containing header
  const p5 = { system: [{ type: "text", text: CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT }] };
  injectClaudeAttributionSystemPrompt(p5);
  assert.equal(p5.system.length, 1);
});

