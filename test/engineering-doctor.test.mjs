import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(testRoot) {
  const fakeCodex = path.join(testRoot, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  writeFileSync(
    fakeCodex,
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    { mode: 0o700 },
  );
  if (process.platform !== "win32") chmodSync(fakeCodex, 0o700);
  return {
    ...process.env,
    CODEX_BIN: fakeCodex,
    CODEX_HOME: path.join(testRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    MODEL_ROUTER_TARGET: "codex",
    CODEX_ROUTER_NO_DISCOVERY: "1",
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
    XDG_CONFIG_HOME: path.join(testRoot, "xdg"),
  };
}

function runDoctor(env) {
  const result = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 45_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.doesNotMatch(result.stderr, /SyntaxError|ReferenceError|TypeError/u);
  return JSON.parse(result.stdout);
}

function check(result, name) {
  const found = result.checks.find((candidate) => candidate.name === name);
  assert.ok(found, `missing doctor check ${name}`);
  return found;
}

test("doctor treats the valid default-off engineering policy as healthy", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "engineering-doctor-off-"));
  const env = environment(testRoot);
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const result = runDoctor(env);
    const mode = check(result, "Engineering orchestration");
    assert.equal(mode.status, "ok");
    assert.match(mode.detail, /^off;/u);
    assert.equal(result.checks.some((candidate) => candidate.name === "Engineering executor"), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("doctor gates enabled engineering mode on policy, recovery, private state, skill, and executor", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "engineering-doctor-on-"));
  const env = environment(testRoot);
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  const policy = JSON.parse(
    readFileSync(path.join(root, "config", "engineering-policy.defaults.json"), "utf8"),
  );
  policy.enabled = true;
  for (const preset of Object.values(policy.presets)) {
    for (const role of Object.values(preset.roles)) {
      role.candidates = role.candidates.filter(
        (candidate) => candidate.model !== "gemini-api/models/gemini-3.8-flash",
      );
      if (role.optionalCandidates) {
        role.optionalCandidates = role.optionalCandidates.filter(
          (candidate) => candidate.model !== "gemini-api/models/gemini-3.8-flash",
        );
      }
    }
  }
  const policyPath = path.join(env.MODEL_ROUTER_STATE_DIR, "engineering-policy.json");
  try {
    execFileSync(process.execPath, [path.join(root, "src", "skills-install.mjs"), "install"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    mkdirSync(path.join(env.MODEL_ROUTER_STATE_DIR, "engineering"), { recursive: true, mode: 0o700 });
    writeFileSync(
      policyPath,
      `${JSON.stringify({
        version: 1,
        revision: 1,
        updatedAt: "2026-09-22T00:00:00.000Z",
        policy,
      })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(policyPath, 0o600);
    const result = runDoctor(env);
    for (const name of [
      "Engineering orchestration policy",
      "Engineering routes and efforts",
      "Engineering DeepSeek recovery",
      "Engineering state privacy",
      "Engineering orchestration skill",
      "Engineering executor",
    ]) {
      assert.equal(check(result, name).status, "ok", `${name} should be healthy`);
    }
    assert.match(check(result, "Engineering DeepSeek recovery").detail, /non-Modal recovery order/u);
    assert.match(check(result, "Engineering orchestration skill").detail, /router-owned/u);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("doctor fails closed when an enabled engineering policy is not owner-only", {
  skip: process.platform === "win32",
}, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "engineering-doctor-public-"));
  const env = environment(testRoot);
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  const policy = JSON.parse(
    readFileSync(path.join(root, "config", "engineering-policy.defaults.json"), "utf8"),
  );
  policy.enabled = true;
  const policyPath = path.join(env.MODEL_ROUTER_STATE_DIR, "engineering-policy.json");
  writeFileSync(
    policyPath,
    `${JSON.stringify({
      version: 1,
      revision: 1,
      updatedAt: "2026-09-22T00:00:00.000Z",
      policy,
    })}\n`,
    { mode: 0o644 },
  );
  chmodSync(policyPath, 0o644);
  try {
    const result = runDoctor(env);
    const policyCheck = check(result, "Engineering orchestration policy");
    assert.equal(policyCheck.status, "fail");
    assert.match(policyCheck.detail, /not owner-only/u);
    assert.equal(result.checks.some((candidate) => candidate.name === "Engineering executor"), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
