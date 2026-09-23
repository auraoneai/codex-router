// Native Codex models retired from the user-facing catalogs. The 1M Sol slug
// was a router-generated context variant of the retired native Sol route, so
// it leaves the catalogs with its base model.
export const EXCLUDED_NATIVE_CODEX_MODEL_SLUGS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-sol-1m",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const excludedSlugs = new Set(EXCLUDED_NATIVE_CODEX_MODEL_SLUGS);

export function isExcludedNativeCodexModelSlug(slug) {
  return excludedSlugs.has(String(slug ?? ""));
}

export function filterExcludedNativeCodexModels(models) {
  return (Array.isArray(models) ? models : []).filter(
    (model) => !isExcludedNativeCodexModelSlug(model?.slug),
  );
}
