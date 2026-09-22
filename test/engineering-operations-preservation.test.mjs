import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

test("disable, refresh, and uninstall preserve engineering and provider state byte-for-byte", {
  skip: process.platform === "win32",
}, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "engineering-operations-preservation-"));
  const codexHome = path.join(testRoot, "codex");
  const stateDir = path.join(testRoot, "state");
  const fakeBin = path.join(testRoot, "bin");
  const calls = path.join(testRoot, "node-calls.txt");
  mkdirSync(path.join(codexHome, "agents"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(codexHome, "skills", "user-owned-skill"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateDir, "engineering", "artifacts", "run-1"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(path.join(stateDir, "generic-provider-credentials"), { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });

  const preserved = new Map([
    [path.join(stateDir, "enabled-providers.json"), "provider-selection-byte-sentinel\n"],
    [path.join(stateDir, "deepseek-api-key.secret"), "provider-credential-byte-sentinel\n"],
    [path.join(stateDir, "engineering-policy.json"), "engineering-policy-byte-sentinel\n"],
    [path.join(stateDir, "engineering", "state.json"), "engineering-state-byte-sentinel\n"],
    [path.join(stateDir, "engineering", "artifacts", "run-1", "evidence.json"), "engineering-evidence-byte-sentinel\n"],
    [path.join(codexHome, "agents", "user-agent.toml"), "user-agent-byte-sentinel\n"],
    [path.join(codexHome, "skills", "user-owned-skill", "SKILL.md"), "user-skill-byte-sentinel\n"],
  ]);
  for (const [target, contents] of preserved) {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { mode: 0o600 });
  }

  const fakeNode = path.join(fakeBin, "node");
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\ncase "$*" in\n  *"target-integration.mjs installed-targets"*) printf 'dsh\\n' ;;\nesac\nexit 0\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeNode, 0o700);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TARGET: "codex",
  };

  const assertPreserved = () => {
    for (const [target, contents] of preserved) {
      assert.deepEqual(readFileSync(target), Buffer.from(contents), `${target} changed`);
    }
  };

  try {
    execFileSync(process.execPath, [path.join(root, "src", "skills-install.mjs"), "install"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    assert.ok(
      existsSync(path.join(codexHome, "skills", "codex-engineering-orchestrator", "SKILL.md")),
      "the engineering skill is installed as owned integration",
    );
    assertPreserved();

    for (const command of ["disable", "refresh-catalog", "uninstall"]) {
      const result = spawnSync("/bin/sh", [path.join(root, "bin", command)], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assertPreserved();
    }
    assert.match(readFileSync(calls, "utf8"), /skills-install\.mjs uninstall/u);

    execFileSync(process.execPath, [path.join(root, "src", "skills-install.mjs"), "uninstall"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    assert.equal(
      existsSync(path.join(codexHome, "skills", "codex-engineering-orchestrator")),
      false,
      "uninstall removes the marker-owned engineering skill",
    );
    assert.ok(existsSync(path.join(codexHome, "skills", "user-owned-skill", "SKILL.md")));
    assert.ok(existsSync(path.join(codexHome, "agents", "user-agent.toml")));
    assertPreserved();
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
