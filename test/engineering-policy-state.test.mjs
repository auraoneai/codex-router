import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readEngineeringPolicyDefaults,
  readEngineeringPolicyState,
  replaceEngineeringPolicy,
  updateEngineeringPolicy,
} from "../src/engineering/policy-state.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-engineering-policy-"));
  return { root, stateDir: path.join(root, "state") };
}

test("checked-in engineering policy defaults are valid and opt-in off", () => {
  const policy = readEngineeringPolicyDefaults();
  assert.equal(policy.enabled, false);
  assert.equal(policy.lead.model, "gpt-6-astra");
  assert.equal(policy.lead.executionMode, "native-parent");
  assert.deepEqual(policy.deepSeekRecovery.map(({ model }) => model), [
    "cloudflare-workers-ai/glm-5.3",
    "gpt-6-sol",
    "kiro-prism/claude-sonnet-5",
  ]);
});

test("policy state uses owner-only atomic CAS updates and preserves immutable revisions", () => {
  const { root, stateDir } = fixture();
  try {
    const initial = readEngineeringPolicyState({ stateDir });
    assert.equal(initial.status, "default");
    assert.equal(initial.revision, 0);
    assert.equal(initial.enabled, false);

    const enabled = updateEngineeringPolicy((policy) => ({ ...policy, enabled: true }), {
      expectedRevision: 0,
      stateDir,
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });
    assert.equal(enabled.revision, 1);
    assert.equal(enabled.enabled, true);
    if (process.platform !== "win32") assert.equal(statSync(enabled.path).mode & 0o777, 0o600);
    assert.equal(Object.isFrozen(enabled.policy), true);

    const before = readFileSync(enabled.path, "utf8");
    assert.throws(() => updateEngineeringPolicy((policy) => policy, {
      expectedRevision: 0,
      stateDir,
    }), (error) => error.code === "revision_conflict" && error.currentRevision === 1);
    assert.equal(readFileSync(enabled.path, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid or unprotected mutable policy fails closed without deleting evidence", {
  skip: process.platform === "win32" ? "chmod cannot widen a protected Windows ACL fixture" : false,
}, () => {
  const { root, stateDir } = fixture();
  try {
    const policy = { ...readEngineeringPolicyDefaults(), enabled: true };
    const written = replaceEngineeringPolicy(policy, { expectedRevision: 0, stateDir });
    chmodSync(written.path, 0o644);
    const degraded = readEngineeringPolicyState({ stateDir });
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.enabled, false);
    assert.match(degraded.error, /not owner-only/u);
    assert.equal(JSON.parse(readFileSync(written.path, "utf8")).policy.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid policy transforms leave the prior revision byte-identical", () => {
  const { root, stateDir } = fixture();
  try {
    const written = replaceEngineeringPolicy(readEngineeringPolicyDefaults(), {
      expectedRevision: 0,
      stateDir,
    });
    const before = readFileSync(written.path, "utf8");
    assert.throws(() => updateEngineeringPolicy((policy) => ({
      ...policy,
      activePreset: "missing",
    }), {
      expectedRevision: 1,
      stateDir,
    }), /does not exist/u);
    assert.equal(readFileSync(written.path, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
