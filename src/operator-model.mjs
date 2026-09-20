import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { OPERATOR_MODEL_PATH } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

// A bare slug is native ChatGPT traffic. Codex hardwires those onto its own
// models -- background agents, compaction, the reserve allowance -- whichever
// model the user actually picked, and no native slug contains a "/". A
// provider-qualified slug is therefore the only evidence that a route was
// chosen rather than assumed.
export function isNativeOpenAIRoute(route) {
  if (!route) return true;
  if (canonicalProviderId(route.provider) === "openai") return true;
  return !String(route.slug || "").includes("/");
}

export function readOperatorModel() {
  if (!existsSync(OPERATOR_MODEL_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(OPERATOR_MODEL_PATH, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.slug !== "string" || !parsed.slug.trim()) {
      return undefined;
    }
    return {
      slug: parsed.slug.trim(),
      native: parsed.native === true,
    };
  } catch {
    // A damaged hint is not worth an error on the request path: the caller
    // simply keeps the route it already resolved.
    return undefined;
  }
}

// Only a routed model is worth remembering. Recording a native one would make
// the hint argue for the fallback this module exists to avoid.
export function rememberOperatorModel(route) {
  if (!route?.slug || isNativeOpenAIRoute(route)) return;
  writePrivateJson(
    OPERATOR_MODEL_PATH,
    {
      version: 1,
      slug: route.slug,
      native: isNativeOpenAIRoute(route),
      updatedAt: new Date().toISOString(),
    },
    { directoryMode: 0o700 },
  );
}

// Give a turn the user never chose a model for -- an internal compaction pass,
// a reserve escalation -- the routed model they last actually ran, so work the
// router generates on their behalf does not silently land on native quota they
// may not have. A turn that already resolved to a routed model is left alone:
// it made its own choice and this hint has no standing to overrule it.
export function followOperatorModel(currentRoute, { modelsBySlug, enabledProviders, fallbackSlug } = {}) {
  const remembered = readOperatorModel();
  const targetSlug = remembered && !remembered.native ? remembered.slug : fallbackSlug;
  if (!targetSlug) return currentRoute;
  if (currentRoute && !isNativeOpenAIRoute(currentRoute)) return currentRoute;
  const next = modelsBySlug?.get?.(targetSlug);
  if (!next || isNativeOpenAIRoute(next)) return currentRoute;
  // A hidden provider would trade a quota failure for a routing error, which is
  // the worse of the two outcomes for a turn the user is not watching.
  if (Array.isArray(enabledProviders) && !enabledProviders.includes(next.provider)) {
    return currentRoute;
  }
  return next;
}

export function clearOperatorModel() {
  if (existsSync(OPERATOR_MODEL_PATH)) unlinkSync(OPERATOR_MODEL_PATH);
}

export function operatorModelSnapshot() {
  const remembered = readOperatorModel();
  return {
    remembered: Boolean(remembered),
    ...(remembered ? { slug: remembered.slug } : {}),
    path: OPERATOR_MODEL_PATH,
  };
}
