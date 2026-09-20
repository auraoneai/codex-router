import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseShellAssignments,
  readShellEnvironment,
  resolveAmbientProviderCredential,
} from "../src/shell-environment.mjs";
import {
  adoptProviderCredential,
  credentialStatus,
  discoverAdoptableCredentials,
  removeProviderCredential,
} from "../src/provider-credentials.mjs";
import { PROVIDERS } from "../src/model-registry.mjs";

test("parseShellAssignments parses various shell export syntaxes correctly", () => {
  const sample = `
# Comment line
export MOONSHOT_API_KEY="sk-moonshot-test-123"
export GEMINI_API_KEY='AIza-test-gemini-456'
export SIMPLE_VAR=plain_value
NO_EXPORT_VAR="no-export-value"
export WITH_TRAILING_COMMENT=value_here # inline comment
# export COMMENTED_OUT="should-not-appear"
export EMPTY_VAR=""
`;

  const parsed = parseShellAssignments(sample);
  assert.equal(parsed.get("MOONSHOT_API_KEY"), "sk-moonshot-test-123");
  assert.equal(parsed.get("GEMINI_API_KEY"), "AIza-test-gemini-456");
  assert.equal(parsed.get("SIMPLE_VAR"), "plain_value");
  assert.equal(parsed.get("NO_EXPORT_VAR"), "no-export-value");
  assert.equal(parsed.get("WITH_TRAILING_COMMENT"), "value_here");
  assert.equal(parsed.has("COMMENTED_OUT"), false);
});

test("readShellEnvironment reads files in precedence order", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-router-shell-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpHome, ".bashrc"),
      'export TEST_OVERRIDE="from-bashrc"\nexport BASH_ONLY="bash-val"\n',
    );
    fs.writeFileSync(
      path.join(tmpHome, ".zshrc"),
      'export TEST_OVERRIDE="from-zshrc"\nexport ZSH_ONLY="zsh-val"\n',
    );

    const env = readShellEnvironment({ home: tmpHome });
    assert.equal(env.get("TEST_OVERRIDE")?.value, "from-zshrc");
    assert.equal(env.get("TEST_OVERRIDE")?.file, ".zshrc");
    assert.equal(env.get("ZSH_ONLY")?.value, "zsh-val");
    assert.equal(env.get("BASH_ONLY")?.value, "bash-val");
    assert.equal(env.get("BASH_ONLY")?.file, ".bashrc");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("resolveAmbientProviderCredential resolves from mock shell files", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-router-ambient-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpHome, ".zshrc"),
      'export MOONSHOT_API_KEY="sk-test-moonshot"\n',
    );

    // Save and clear process.env.MOONSHOT_API_KEY to test shell file fallback
    const origEnv = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    try {
      const ambient = resolveAmbientProviderCredential("kimi-api", { home: tmpHome });
      assert.ok(ambient);
      assert.equal(ambient.value, "sk-test-moonshot");
      assert.equal(ambient.envVar, "MOONSHOT_API_KEY");
      assert.match(ambient.source, /~[/\\]\.zshrc/);
    } finally {
      if (origEnv !== undefined) process.env.MOONSHOT_API_KEY = origEnv;
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("ANTIGRAVITY_API_KEY is mapped to gemini-api provider", () => {
  const provider = PROVIDERS.get("gemini-api");
  assert.ok(provider.credential.environment.includes("ANTIGRAVITY_API_KEY"));
});

test("discoverAdoptableCredentials discovers unconfigured providers with shell credentials", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-router-discover-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpHome, ".zshrc"),
      'export ANTHROPIC_API_KEY="sk-ant-test-key-789"\n',
    );
    const origEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const adoptable = discoverAdoptableCredentials({ home: tmpHome });
      const found = adoptable.find((a) => a.provider.id === "anthropic-api");
      assert.ok(found);
      assert.equal(found.ambient.value, "sk-ant-test-key-789");
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_API_KEY = origEnv;
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("adoptProviderCredential throws when no ambient key is found", () => {
  assert.throws(
    () => adoptProviderCredential("minimax-token-plan", { home: "/nonexistent-home-dir" }),
    /No API key found in environment or shell configuration/,
  );
});
