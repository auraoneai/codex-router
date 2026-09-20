import assert from "node:assert/strict";
import test from "node:test";

import { codexCandidatePaths } from "../src/codex-binary.mjs";

const HOMEBREW = "/opt/homebrew/bin/codex";
const USR_LOCAL = "/usr/local/bin/codex";
const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP = "/Applications/Codex.app/Contents/Resources/codex";

// Desktop releases can lag Homebrew, and the resolved binary is what the catalog
// asks for the native model list. Picking a stale desktop CLI silently drops
// native models the newer build knows about, which the user sees as models
// disappearing from the picker.
test("macOS prefers a separately maintained CLI over the desktop bundle", () => {
  const candidates = codexCandidatePaths({ platform: "darwin", home: "/Users/u" });
  assert.ok(
    candidates.indexOf(HOMEBREW) < candidates.indexOf(CHATGPT_APP),
    "Homebrew must precede the ChatGPT.app bundle",
  );
  assert.ok(
    candidates.indexOf(USR_LOCAL) < candidates.indexOf(CODEX_APP),
    "/usr/local must precede the Codex.app bundle",
  );
});

test("macOS lists each candidate exactly once", () => {
  const candidates = codexCandidatePaths({ platform: "darwin", home: "/Users/u" });
  assert.equal(candidates.length, new Set(candidates).size);
  for (const expected of [HOMEBREW, USR_LOCAL, CHATGPT_APP, CODEX_APP]) {
    assert.equal(
      candidates.filter((candidate) => candidate === expected).length,
      1,
      `${expected} must appear once`,
    );
  }
});

// Linux deliberately prefers its own desktop bundle, so the macOS reordering
// must not reach it.
test("Linux ordering is unchanged", () => {
  const candidates = codexCandidatePaths({ platform: "linux", home: "/home/u" });
  assert.ok(candidates.indexOf(CHATGPT_APP) < candidates.indexOf(HOMEBREW));
  assert.ok(candidates.indexOf(HOMEBREW) < candidates.indexOf(USR_LOCAL));
});

test("Windows ordering is unchanged", () => {
  const candidates = codexCandidatePaths({
    platform: "win32",
    localAppData: "C:\\LocalAppData",
    home: "C:\\Users\\u",
  });
  assert.ok(candidates.indexOf(CHATGPT_APP) < candidates.indexOf(HOMEBREW));
  assert.ok(candidates.indexOf(HOMEBREW) < candidates.indexOf(USR_LOCAL));
  assert.ok(candidates.at(-1).endsWith("codex.exe"));
});

// An operator who names an exact build must still win on every platform.
test("an explicit CODEX_BIN still outranks everything", () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = "/tmp/explicit-codex";
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.equal(
        codexCandidatePaths({ platform, home: "/Users/u" })[0],
        "/tmp/explicit-codex",
        `${platform} must honor CODEX_BIN first`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});
