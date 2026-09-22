import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  engineeringControlSnapshot,
  engineeringUsageSnapshot,
  sanitizeEngineeringPolicy,
} from "../src/engineering/control-snapshot.mjs";
import {
  engineeringControlHttpResponse,
  parseEngineeringHttpRequest,
} from "../src/engineering/http.mjs";
import { readEngineeringPolicyDefaults } from "../src/engineering/policy-state.mjs";
import { privateFileIsProtected } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-engineering-control-"));
  return {
    stateDir,
    stateOptions: { stateDir },
    dispose: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

function usageEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    at: "2026-09-22T00:00:00.000Z",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    role: "general_coder",
    sourceRevision: "abc123",
    model: "provider/model",
    provider: "provider",
    family: "family",
    source: "router",
    providerRequestId: "must-not-leave-the-control-plane",
    authorization: "must-not-leave-the-control-plane",
    usage: {
      inputTokens: { kind: "measured", value: 10 },
      cachedInputTokens: { kind: "unknown" },
      outputTokens: { kind: "estimated", value: 4 },
      reasoningTokens: { kind: "unknown" },
      totalTokens: { kind: "measured", value: 14 },
      costMicros: { kind: "unknown" },
    },
    ...overrides,
  };
}

test("sanitized control snapshot is off by default and exposes only stable control fields", () => {
  const policy = { ...readEngineeringPolicyDefaults(), futureSecret: "do-not-copy" };
  const snapshot = engineeringControlSnapshot({
    state: {
      status: "default",
      degraded: false,
      revision: 0,
      updatedAt: null,
      policy,
      path: "/private/state/engineering-policy.json",
      error: "secret internal diagnostic",
    },
    usageEvents: [usageEvent()],
  });
  assert.deepEqual(Object.keys(snapshot), [
    "version", "revision", "status", "fresh", "configured", "enabled", "healthy",
    "degraded", "activePreset", "roles", "usage", "gates", "updatedAt",
  ]);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.usage.requests, 1);
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /private\/state|internal diagnostic|futureSecret|providerRequestId|authorization/u);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.roles), true);
});

test("sanitized policy and usage reconstruct allowlisted fields", () => {
  const policy = sanitizeEngineeringPolicy({
    ...readEngineeringPolicyDefaults(),
    apiKey: "secret",
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.executionSelectionMode, "pinned");
  assert.equal(Object.hasOwn(policy, "apiKey"), false);

  const usage = engineeringUsageSnapshot([usageEvent()]);
  assert.equal(usage.summary.fields.inputTokens.measured, 10);
  assert.equal(usage.events.length, 1);
  assert.equal(Object.hasOwn(usage.events[0], "providerRequestId"), false);
  assert.equal(Object.hasOwn(usage.events[0], "authorization"), false);
});

test("HTTP parser accepts canonical GET/PATCH and rejects method or shape drift", () => {
  assert.deepEqual(
    parseEngineeringHttpRequest({ method: "GET", url: "/v1/engineering" }),
    { action: "status", method: "GET", body: undefined },
  );
  assert.deepEqual(
    parseEngineeringHttpRequest({
      method: "PATCH",
      url: "/v1/engineering",
      body: '{"expectedRevision":0,"enabled":true}',
    }),
    { action: "patch", method: "PATCH", body: { expectedRevision: 0, enabled: true } },
  );
  const wrongMethod = engineeringControlHttpResponse({ method: "POST", url: "/v1/engineering" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  const unknown = engineeringControlHttpResponse({ method: "GET", url: "/v1/engineering/nope" });
  assert.equal(unknown.status, 404);
});

test("HTTP PATCH toggles only policy state with CAS and returns a sanitized snapshot", () => {
  const current = fixture();
  try {
    const enabled = engineeringControlHttpResponse({
      method: "PATCH",
      url: "/v1/engineering",
      body: { expectedRevision: 0, enabled: true },
    }, { stateOptions: current.stateOptions });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);
    assert.equal(enabled.body.revision, 1);
    assert.equal(privateFileIsProtected(path.join(current.stateDir, "engineering-policy.json")), true);

    const stale = engineeringControlHttpResponse({
      method: "PATCH",
      url: "/v1/engineering",
      body: { expectedRevision: 0, enabled: false },
    }, { stateOptions: current.stateOptions });
    assert.equal(stale.status, 409);
    assert.deepEqual(
      { expectedRevision: stale.body.expectedRevision, currentRevision: stale.body.currentRevision },
      { expectedRevision: 0, currentRevision: 1 },
    );

    const extra = engineeringControlHttpResponse({
      method: "PATCH",
      url: "/v1/engineering",
      body: { expectedRevision: 1, enabled: false, provider: "mutation-is-forbidden" },
    }, { stateOptions: current.stateOptions });
    assert.equal(extra.status, 400);
  } finally {
    current.dispose();
  }
});

test("CLI dispatchers expose engineering only for Codex and preserve other commands", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const engineering = path.join(root, "bin", "engineering");
  assert.ok(statSync(engineering).mode & 0o111);
  for (const file of ["bin/model-router", "bin/codex-router"]) {
    assert.match(readFileSync(path.join(root, file), "utf8"), /engineering/u);
  }
  const refused = spawnSync(path.join(root, "bin", "model-router"), ["dsh", "engineering", "status"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /only for the Codex target/u);

  const version = spawnSync(path.join(root, "bin", "model-router"), ["codex", "--version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test("CLI on/off uses the UI --revision contract and mutates no provider or model state", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const temp = fixture();
  const providerSelection = path.join(temp.stateDir, "enabled-providers.json");
  const userModels = path.join(temp.stateDir, "user-models.json");
  const providerBytes = '{"version":1,"providers":["deepseek"]}\n';
  const modelBytes = '{"version":1,"models":[]}\n';
  writeFileSync(providerSelection, providerBytes, { mode: 0o600 });
  writeFileSync(userModels, modelBytes, { mode: 0o600 });
  const environment = {
    ...process.env,
    CODEX_HOME: temp.stateDir,
    MODEL_ROUTER_STATE_DIR: temp.stateDir,
    MODEL_ROUTER_TARGET: "codex",
  };
  const run = (...arguments_) => spawnSync(path.join(root, "bin", "engineering"), arguments_, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  try {
    const missingRevision = run("on");
    assert.notEqual(missingRevision.status, 0);
    assert.match(missingRevision.stderr, /requires --revision/u);

    const enabled = run("on", "--revision", "0");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(JSON.parse(enabled.stdout).enabled, true);
    assert.equal(JSON.parse(enabled.stdout).revision, 1);

    const stale = run("off", "--revision", "0");
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /revision conflict/u);

    const extra = run("off", "--revision", "1", "--provider", "deepseek");
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /Unsupported engineering argument/u);

    const disabled = run("off", "--revision", "1");
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).enabled, false);
    assert.equal(JSON.parse(disabled.stdout).revision, 2);
    assert.equal(readFileSync(providerSelection, "utf8"), providerBytes);
    assert.equal(readFileSync(userModels, "utf8"), modelBytes);
  } finally {
    temp.dispose();
  }
});

test("CLI policy export and CAS replacement interchange models and efforts without code edits", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const temp = fixture();
  const environment = {
    ...process.env,
    CODEX_HOME: temp.stateDir,
    MODEL_ROUTER_STATE_DIR: temp.stateDir,
    MODEL_ROUTER_TARGET: "codex",
  };
  const run = (...arguments_) => spawnSync(path.join(root, "bin", "engineering"), arguments_, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  const replacementPath = path.join(temp.stateDir, "replacement-policy.json");
  try {
    const exported = run("policy");
    assert.equal(exported.status, 0, exported.stderr);
    const policy = JSON.parse(exported.stdout);
    assert.equal(policy.executionSelectionMode, "pinned");
    policy.presets.balanced.roles.general_coder.candidates[0] = {
      model: "cloudflare-workers-ai/glm-5.3",
      effort: "high",
    };
    writeFileSync(replacementPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });

    const replaced = run("policy", "replace", "--file", replacementPath, "--revision", "0");
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(JSON.parse(replaced.stdout).revision, 1);
    const persisted = JSON.parse(readFileSync(path.join(temp.stateDir, "engineering-policy.json"), "utf8"));
    assert.deepEqual(persisted.policy.presets.balanced.roles.general_coder.candidates[0], {
      model: "cloudflare-workers-ai/glm-5.3",
      effort: "high",
    });

    const stale = run("policy", "replace", "--file", replacementPath, "--revision", "0");
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /revision conflict/u);
  } finally {
    temp.dispose();
  }
});

test("CLI run refuses disabled mode before loading or dispatching the production runtime", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const temp = fixture();
  const requestPath = path.join(temp.stateDir, "run-request.json");
  writeFileSync(requestPath, '{"runId":"disabled-run"}\n', { mode: 0o600 });
  try {
    const result = spawnSync(path.join(root, "bin", "engineering"), [
      "run", "--file", requestPath, "--revision", "0",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: temp.stateDir,
        MODEL_ROUTER_STATE_DIR: temp.stateDir,
        MODEL_ROUTER_TARGET: "codex",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Engineering mode is disabled/u);
    assert.doesNotMatch(result.stderr, /runtime\.mjs/u);
  } finally {
    temp.dispose();
  }
});

test("CLI run revision-binds strict JSON to the runtime and run-status reads retained state", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const temp = fixture();
  const requestPath = path.join(temp.stateDir, "run-request.json");
  const secretPath = path.join(temp.stateDir, "secret-request.json");
  const loaderPath = path.join(temp.stateDir, "runtime-loader.mjs");
  writeFileSync(requestPath, JSON.stringify({
    runId: "run-cli-contract",
    strategy: "single",
    tasks: [{ taskId: "task-1", objective: "prove dispatch" }],
  }), { mode: 0o600 });
  writeFileSync(secretPath, JSON.stringify({
    runId: "must-refuse",
    apiKey: "do-not-forward",
  }), { mode: 0o600 });
  writeFileSync(loaderPath, `
const source = ${JSON.stringify(`
export function createEngineeringRuntime() { return { marker: "runtime-created", status: async (runId) => ({ runId, state: "retained" }) }; }
export async function runEngineeringWorkflow(runtime, request) { return { runtime: runtime.marker, request }; }
`)};
const replacement = \`data:text/javascript,\${encodeURIComponent(source)}\`;
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/engineering/runtime.mjs")) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context);
}
`, { mode: 0o600 });
  const environment = {
    ...process.env,
    CODEX_HOME: temp.stateDir,
    MODEL_ROUTER_STATE_DIR: temp.stateDir,
    MODEL_ROUTER_TARGET: "codex",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --experimental-loader=${loaderPath}`.trim(),
  };
  const run = (...arguments_) => spawnSync(path.join(root, "bin", "engineering"), arguments_, {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  try {
    const enabled = run("on", "--revision", "0");
    assert.equal(enabled.status, 0, enabled.stderr);

    const stale = run("run", "--file", requestPath, "--revision", "0");
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /revision conflict: expected 0, current 1/u);

    const refusedSecret = run("run", "--file", secretPath, "--revision", "1");
    assert.notEqual(refusedSecret.status, 0);
    assert.match(refusedSecret.stderr, /forbidden secret field request\.apiKey/u);

    const dispatched = run("run", "--file", requestPath, "--revision", "1");
    assert.equal(dispatched.status, 0, dispatched.stderr);
    assert.deepEqual(JSON.parse(dispatched.stdout), {
      runtime: "runtime-created",
      request: {
        runId: "run-cli-contract",
        strategy: "single",
        tasks: [{ taskId: "task-1", objective: "prove dispatch" }],
        policyRevision: 1,
      },
    });

    const disabled = run("off", "--revision", "1");
    assert.equal(disabled.status, 0, disabled.stderr);
    const retained = run("run-status", "--run-id", "run-cli-contract");
    assert.equal(retained.status, 0, retained.stderr);
    assert.deepEqual(JSON.parse(retained.stdout), {
      runId: "run-cli-contract",
      state: "retained",
    });
  } finally {
    temp.dispose();
  }
});

test("CLI run remains Codex-target-only", {
  skip: process.platform === "win32" ? "POSIX bin launchers are not Windows entry points" : false,
}, () => {
  const temp = fixture();
  const requestPath = path.join(temp.stateDir, "run-request.json");
  writeFileSync(requestPath, '{"runId":"wrong-target"}\n', { mode: 0o600 });
  try {
    const result = spawnSync(path.join(root, "bin", "engineering"), [
      "run", "--file", requestPath, "--revision", "0",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: temp.stateDir,
        MODEL_ROUTER_STATE_DIR: temp.stateDir,
        MODEL_ROUTER_TARGET: "dsh",
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only for the Codex target/u);
  } finally {
    temp.dispose();
  }
});

test("overview publishes the sanitized engineering snapshot under catalog.engineering", () => {
  const temp = fixture();
  const codex = path.join(temp.stateDir, "codex-signed-out");
  writeFileSync(codex, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  try {
    const result = spawnSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CODEX_HOME: temp.stateDir,
        MODEL_ROUTER_STATE_DIR: temp.stateDir,
        CODEX_CLI_PATH: codex,
        MODEL_ROUTER_TARGET: "codex",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const overview = JSON.parse(result.stdout);
    assert.equal(overview.catalog.engineering.version, 1);
    assert.equal(overview.catalog.engineering.enabled, false);
    assert.equal(Object.hasOwn(overview.catalog.engineering, "policy"), false);
  } finally {
    temp.dispose();
  }
});
