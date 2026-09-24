import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(directory) {
  const stateDir = path.join(directory, "state");
  return {
    ...process.env,
    HOME: directory,
    CODEX_HOME: path.join(directory, "codex"),
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_CLAUDE_ACCOUNT_POOL: path.join(stateDir, "claude-account-pool.json"),
    MODEL_ROUTER_CLAUDE_ACCOUNT_HOMES: path.join(stateDir, "claude-accounts"),
    CODEX_ROUTER_SERVICE_PLATFORM: "test-fixture",
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    CODEX_ROUTER_SKIP_SYSTEMCTL: "1",
    KIMI_CODE_HOME: path.join(directory, "kimi-code"),
    GROK_AUTH_PATH: path.join(directory, "grok", "auth.json"),
  };
}

function doctor(env) {
  const result = spawnSync(process.execPath, ["src/doctor.mjs", "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ok(result.stdout, result.stderr);
  return { result, report: JSON.parse(result.stdout) };
}

function validAccount(id, { state = "active", paused = false } = {}) {
  return {
    id,
    state,
    paused,
    priority: 50,
    label: "test account",
    createdAt: new Date().toISOString(),
    subscription: { status: "usable" },
    health: { state: "healthy" },
    turns: 0,
    requests: 0,
  };
}

function validPoolJson(accounts = {}) {
  return `${JSON.stringify(
    {
      version: 1,
      policy: { enabled: true, mode: "switch" },
      accounts,
    },
    null,
    2,
  )}\n`;
}

test("doctor reports ok when Claude account pool has active accounts", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-ok-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL,
    validPoolJson({
      clacct_active1111: validAccount("clacct_active1111"),
      clacct_active2222: validAccount("clacct_active2222"),
    }),
    { mode: 0o600 },
  );

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check was not found in doctor output");
    assert.equal(row.status, "ok");
    assert.equal(row.detail, "2 active account(s) (2 total)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports warn when Claude account pool is configured but contains no active accounts", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-empty-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL,
    validPoolJson({
      clacct_paused111: validAccount("clacct_paused111", { paused: true }),
    }),
    { mode: 0o600 },
  );

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check was not found in doctor output");
    assert.equal(row.status, "warn");
    assert.equal(row.detail, "pool is configured but contains no active accounts");
    assert.equal(row.fix, "Run ./bin/control claude-account-pool add to register an account.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports fail when Claude account pool state is invalid and anthropic-api is selected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-corrupt-selected-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL, "invalid json bytes\n", { mode: 0o600 });

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check was not found in doctor output");
    assert.equal(row.status, "fail");
    assert.equal(row.detail, "pool state is invalid");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports warn when Claude account pool state is invalid and anthropic-api is not selected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-corrupt-unselected-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL, "invalid json bytes\n", { mode: 0o600 });

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check was not found in doctor output");
    assert.equal(row.status, "warn");
    assert.equal(row.detail, "pool state is invalid");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor omits Claude account pool check when no pool file exists and anthropic-api is not selected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-absent-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.equal(row, undefined, "Claude account pool check should not be added when unselected and absent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports warn (not fail) when no pool file exists and anthropic-api is selected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-absent-selected-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
    { mode: 0o600 },
  );

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check should be present when anthropic-api is selected");
    assert.equal(row.status, "warn");
    assert.equal(row.detail, "not configured");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports warn advisory when credential discovery is disabled", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doctor-claude-pool-no-discovery-"));
  const env = {
    ...environment(directory),
    CODEX_ROUTER_NO_DISCOVERY: "1",
  };
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL,
    validPoolJson({
      clacct_active1111: validAccount("clacct_active1111"),
    }),
    { mode: 0o600 },
  );

  try {
    const { report } = doctor(env);
    const row = report.checks.find((check) => check.name === "Claude account pool");
    assert.ok(row, "Claude account pool check should be present");
    assert.equal(row.status, "warn");
    assert.match(row.detail, /pool not evaluated while credential discovery is disabled/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runOnboarding(env) {
  const result = spawnSync(
    process.execPath,
    ["-e", 'import("./src/provider-onboarding.mjs").then(m => console.log(JSON.stringify(m.providerOnboardingSnapshot())))'],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("provider onboarding snapshot marks anthropic-api ready with claudeAccountPool when pool is configured", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "onboarding-claude-pool-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL,
    validPoolJson({
      clacct_active1111: validAccount("clacct_active1111"),
    }),
    { mode: 0o600 },
  );

  try {
    const snapshot = runOnboarding(env);
    const provider = snapshot.providers.find((p) => p.id === "anthropic-api");
    assert.ok(provider, "anthropic-api provider not found in snapshot");
    assert.equal(provider.configured, true);
    assert.equal(provider.action, "ready");
    assert.ok(provider.claudeAccountPool);
    assert.equal(provider.claudeAccountPool.version, 1);
    assert.ok(provider.claudeAccountPool.accounts.clacct_active1111);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider onboarding snapshot marks anthropic-api add-key when neither API key nor pool exists", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "onboarding-claude-absent-"));
  const env = environment(directory);
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  try {
    const snapshot = runOnboarding(env);
    const provider = snapshot.providers.find((p) => p.id === "anthropic-api");
    assert.ok(provider, "anthropic-api provider not found in snapshot");
    assert.equal(provider.configured, false);
    assert.equal(provider.action, "add-key");
    assert.equal(provider.claudeAccountPool, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider onboarding snapshot omits claudeAccountPool when discovery is disabled", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "onboarding-claude-no-discovery-"));
  const env = {
    ...environment(directory),
    CODEX_ROUTER_NO_DISCOVERY: "1",
  };
  const stateDir = env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    env.MODEL_ROUTER_CLAUDE_ACCOUNT_POOL,
    validPoolJson({
      clacct_active1111: validAccount("clacct_active1111"),
    }),
    { mode: 0o600 },
  );

  try {
    const snapshot = runOnboarding(env);
    const provider = snapshot.providers.find((p) => p.id === "anthropic-api");
    assert.ok(provider, "anthropic-api provider not found in snapshot");
    assert.equal(provider.claudeAccountPool, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

