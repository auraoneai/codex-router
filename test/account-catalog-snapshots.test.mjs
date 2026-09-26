import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  rebuildAccountSnapshot,
  refreshAccountCatalogSnapshots,
} from "../src/account-catalog-snapshots.mjs";

const levels = (...efforts) => efforts.map((effort) => ({ effort }));

test("rebuild keeps account natives and replaces every router entry", () => {
  const account = [
    { slug: "gpt-5.6-sol", priority: 3 },
    { slug: "kiro-prism/claude-opus-5", supported_reasoning_levels: levels("low") },
  ];
  const published = [
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "kiro-prism/claude-opus-5.5", supported_reasoning_levels: levels("low", "max") },
  ];
  const out = rebuildAccountSnapshot(account, new Set(["gpt-5.6-sol"]), published, new Set(["gpt-5.6-sol"]));
  assert.deepEqual(out.map((m) => m.slug), ["gpt-5.6-sol", "kiro-prism/claude-opus-5.5"]);
  assert.equal(out[0].priority, 3);
});

test("refresh rewrites every account snapshot on disk", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "acct-snap-"));
  try {
    for (const id of ["acct_a1", "acct_b2"]) {
      const dir = path.join(home, id, "router-catalog");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "native-models.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] }));
      writeFileSync(path.join(dir, "merged-models.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }, { slug: "kiro-prism/old" }] }));
    }
    mkdirSync(path.join(home, "acct_empty"));
    const result = refreshAccountCatalogSnapshots({
      homesDir: home,
      publishedModels: [{ slug: "gpt-5.6-sol" }, { slug: "kiro-prism/claude-opus-5.5" }],
      globalNativeSlugs: new Set(["gpt-5.6-sol"]),
    });
    assert.deepEqual(result.updated.sort(), ["acct_a1", "acct_b2"]);
    for (const id of result.updated) {
      const merged = JSON.parse(readFileSync(path.join(home, id, "router-catalog", "merged-models.json"), "utf8"));
      assert.deepEqual(merged.models.map((m) => m.slug), ["gpt-5.6-sol", "kiro-prism/claude-opus-5.5"]);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
