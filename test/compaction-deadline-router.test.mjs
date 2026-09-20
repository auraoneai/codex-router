import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "compaction-deadline-state-")),
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

// A compaction is buffered, not streamed: nothing reaches the client until the
// whole summary exists, so the post-prologue stall guard that protects ordinary
// turns never applies. A provider that accepts the request and then goes silent
// used to leave the session unable to continue and unable to fail for as long as
// the client was willing to wait. The deadline turns that hang into an ordinary
// compaction failure.
test("a compaction against a silent provider fails on its own deadline", async () => {
  let held;
  const gateway = await mockServer((request, response) => {
    // Accept the request, answer nothing, and never close: the exact shape of
    // the hang this deadline exists to bound.
    held = response;
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
    // Short enough to assert against, long enough that the request is genuinely
    // in flight first.
    CODEX_ROUTER_COMPACTION_DEADLINE_MS: "1500",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const startedAt = Date.now();
    const response = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "summarize" }] },
        ],
      }),
    });
    const elapsed = Date.now() - startedAt;

    // It answered at all, rather than hanging: that is the whole fix.
    assert.ok(
      elapsed < 20_000,
      `compaction should have been bounded by its deadline, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed >= 1_000,
      `compaction should not have failed before its deadline, took ${elapsed}ms`,
    );
    assert.ok(
      response.status >= 400,
      `a bounded compaction reports a failure status, got ${response.status}`,
    );
    // Nothing about the local caller's own request was wrong.
    assert.notEqual(response.status, 401);
    await response.text();
  } finally {
    held?.destroy();
    await new Promise((resolve) => gateway.server.close(resolve));
    if (router.exitCode === null && router.signalCode === null) {
      router.kill("SIGTERM");
      await new Promise((resolve) => router.once("exit", resolve));
    }
  }
});
