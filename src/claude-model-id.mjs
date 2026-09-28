export const CLAUDE_MODEL_PREFIX = "codex_router/anthropic/";

// Claude Code only believes a declared window above 200k for model names it
// knows natively or for names carrying its `[1m]` marker; a gateway id that
// declares 1M through discovery is still capped at 200k, which makes a large
// tool surface auto-compact on every turn. Claude Code strips the marker
// before the name reaches the wire, so the router still sees the plain id.
export const CLAUDE_1M_MARKER = "[1m]";
const ONE_MILLION_CONTEXT = 1_000_000;
const MARKER_PATTERN = /\[1m\]$/i;

// Claude Code's gateway discovery intentionally keeps only IDs containing
// "claude" or "anthropic". The router supports many model families, so the
// transport prefix carries "anthropic" while the suffix remains the exact
// router slug. display_name still shows the model's real human-facing name.
export function claudeModelId(slug) {
  return `${CLAUDE_MODEL_PREFIX}${String(slug || "")}`;
}

export function claudeContextWindow(model) {
  const value = Number(model?.contextWindow ?? model?.context_window);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const CLAUDE_FAMILY = /(^|[/._-])(claude|opus|sonnet|fable|haiku|mythos)([/._-]|$)/i;

function isClaudeFamily(model) {
  return [model?.slug, model?.upstreamModel].some((value) => CLAUDE_FAMILY.test(String(value || "")));
}

// The id published to Claude Code itself: the transport id, plus the `[1m]`
// marker for Claude-family models whose route holds a 1M-token window. Other
// families keep Claude Code's default sizing: a 1M figure a reseller declares
// for them is not Anthropic's guarantee, and overstating it would trade an
// early compaction for a hard "prompt too long" failure.
export function claudeCodeModelId(model) {
  const id = claudeModelId(model?.slug);
  return isClaudeFamily(model) && (claudeContextWindow(model) ?? 0) >= ONE_MILLION_CONTEXT
    ? `${id}${CLAUDE_1M_MARKER}`
    : id;
}

export function claudeRoutedSlug(model) {
  const value = String(model || "").replace(MARKER_PATTERN, "");
  return value.startsWith(CLAUDE_MODEL_PREFIX)
    ? value.slice(CLAUDE_MODEL_PREFIX.length)
    : value;
}
