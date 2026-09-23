import { existsSync, readFileSync, statSync } from "node:fs";

import { NATIVE_CATALOG_PATH } from "../paths.mjs";
import { isExcludedNativeCodexModelSlug } from "../native-model-exclusions.mjs";

const inventoryCache = new Map();

function effortList(levels) {
  if (!Array.isArray(levels)) return [];
  const seen = new Set();
  return levels.flatMap((level) => {
    const effort = typeof level === "string" ? level : level?.effort;
    if (typeof effort !== "string" || !effort.trim() || seen.has(effort)) return [];
    seen.add(effort);
    return [Object.freeze({ effort })];
  });
}

/**
 * Project only listed, exact native Codex routes with an upstream v2
 * collaboration declaration into the engineering policy's safe model shape.
 */
export function engineeringNativeModelsFromCatalog(catalog) {
  if (!Array.isArray(catalog?.models)) return Object.freeze([]);
  const seen = new Set();
  const models = [];
  for (const source of catalog.models) {
    const slug = typeof source?.slug === "string" ? source.slug : "";
    if (
      !slug || isExcludedNativeCodexModelSlug(slug) || slug.includes("/") || seen.has(slug) ||
      source?.visibility !== "list" || source?.multi_agent_version !== "v2"
    ) continue;
    const reasoningLevels = effortList(source.supported_reasoning_levels);
    if (!reasoningLevels.length) continue;
    seen.add(slug);
    models.push(Object.freeze({
      slug,
      displayName: typeof source.display_name === "string" && source.display_name
        ? source.display_name
        : slug,
      provider: "openai",
      upstreamModel: slug,
      gatewayModel: slug,
      native: true,
      listed: true,
      multiAgentVersion: "v2",
      ...(typeof source.default_reasoning_level === "string" && source.default_reasoning_level
        ? { defaultEffort: source.default_reasoning_level }
        : {}),
      reasoningLevels: Object.freeze(reasoningLevels),
      ...(Number.isSafeInteger(source.context_window) && source.context_window > 0
        ? { contextWindow: source.context_window }
        : {}),
      ...(Array.isArray(source.input_modalities)
        ? { inputModalities: Object.freeze(source.input_modalities.filter((item) => typeof item === "string")) }
        : {}),
    }));
  }
  return Object.freeze(models);
}

export function nativeEngineeringModelInventory({ catalogPath = NATIVE_CATALOG_PATH } = {}) {
  try {
    if (!existsSync(catalogPath)) {
      inventoryCache.delete(catalogPath);
      return Object.freeze([]);
    }
    const stat = statSync(catalogPath, { bigint: true });
    const stamp = `${stat.mtimeNs}:${stat.size}`;
    const cached = inventoryCache.get(catalogPath);
    if (cached?.stamp === stamp) return cached.models;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = engineeringNativeModelsFromCatalog(catalog);
    inventoryCache.set(catalogPath, { stamp, models });
    return models;
  } catch {
    inventoryCache.delete(catalogPath);
    return Object.freeze([]);
  }
}
