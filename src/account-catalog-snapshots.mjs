import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { NATIVE_CONTEXT_VARIANT_SLUGS } from "./native-context-variants.mjs";

// Each ChatGPT account keeps a router-catalog snapshot that a profile switch
// restores before it republishes. Only the active account used to be
// re-snapshotted, so inactive accounts kept router entries from whenever they
// were last active (a new model or a changed reasoning ladder never reached
// them). After every publish, rebuild each snapshot from the account's own
// native entries plus the router-managed entries just published.

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]+$/;
const CONTEXT_VARIANTS = new Set(NATIVE_CONTEXT_VARIANT_SLUGS);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function regularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function writePrivateJson(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

// Pure merge: account-owned entries (its native slugs and their context
// variants) are kept verbatim; everything else comes from the fresh publish.
export function rebuildAccountSnapshot(accountModels, accountNativeSlugs, publishedModels, globalNativeSlugs) {
  const accountOwned = (slug) => accountNativeSlugs.has(slug) || CONTEXT_VARIANTS.has(slug);
  const routerManaged = (slug) => !globalNativeSlugs.has(slug) && !CONTEXT_VARIANTS.has(slug);
  const kept = accountModels.filter((model) => accountOwned(String(model?.slug || "")));
  const keptSlugs = new Set(kept.map((model) => String(model.slug)));
  const routed = publishedModels.filter((model) => {
    const slug = String(model?.slug || "");
    return slug && routerManaged(slug) && !keptSlugs.has(slug);
  });
  return [...kept, ...routed];
}

export function refreshAccountCatalogSnapshots({
  homesDir,
  publishedModels,
  globalNativeSlugs,
  announcedModelsPath,
} = {}) {
  const result = { updated: [], skipped: [] };
  if (!homesDir || !existsSync(homesDir) || !Array.isArray(publishedModels)) return result;
  for (const entry of readdirSync(homesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ACCOUNT_ID.test(entry.name)) continue;
    const dir = path.join(homesDir, entry.name, "router-catalog");
    const mergedPath = path.join(dir, "merged-models.json");
    const nativePath = path.join(dir, "native-models.json");
    if (!regularFile(mergedPath) || !regularFile(nativePath)) continue;
    const merged = readJson(mergedPath);
    const native = readJson(nativePath);
    if (!Array.isArray(merged?.models) || !Array.isArray(native?.models)) {
      result.skipped.push(entry.name);
      continue;
    }
    const accountNativeSlugs = new Set(native.models.map((model) => String(model?.slug || "")));
    const models = rebuildAccountSnapshot(
      merged.models,
      accountNativeSlugs,
      publishedModels,
      globalNativeSlugs,
    );
    writePrivateJson(mergedPath, { ...merged, models });
    const announcedTarget = path.join(dir, "announced-models.json");
    if (announcedModelsPath && regularFile(announcedModelsPath) && regularFile(announcedTarget)) {
      const announced = readJson(announcedModelsPath);
      if (announced) writePrivateJson(announcedTarget, announced);
    }
    result.updated.push(entry.name);
  }
  return result;
}
