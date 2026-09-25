// Claude Code billing attribution header for Anthropic subscription OAuth tokens.
// When using a Claude subscription OAuth token, Anthropic requires the first-party
// Claude Code attribution block in the system prompt. Without it, Anthropic rejects
// frontier models (like Opus 5.5 and Fable 5.1) with HTTP 429 rate_limit_error.

export const CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT =
  "x-anthropic-billing-header: cc_version=2.1.282.a7a; cc_entrypoint=sdk-cli; cch=00000; cc_turn_origin=sdk;";

export function injectClaudeAttributionSystemPrompt(payload) {
  if (!payload || typeof payload !== "object") return;
  const header = CLAUDE_CODE_ATTRIBUTION_HEADER_TEXT;
  if (!payload.system) {
    payload.system = [{ type: "text", text: header }];
    return;
  }
  if (typeof payload.system === "string") {
    if (!payload.system.includes("x-anthropic-billing-header:")) {
      payload.system = `${header}\n\n${payload.system}`;
    }
    return;
  }
  if (Array.isArray(payload.system)) {
    const hasHeader = payload.system.some(
      (part) =>
        (typeof part === "string" && part.includes("x-anthropic-billing-header:")) ||
        (part && typeof part === "object" && typeof part.text === "string" && part.text.includes("x-anthropic-billing-header:")),
    );
    if (!hasHeader) {
      payload.system.unshift({ type: "text", text: header });
    }
    return;
  }
  if (typeof payload.system === "object") {
    if (typeof payload.system.text === "string") {
      if (!payload.system.text.includes("x-anthropic-billing-header:")) {
        payload.system = [
          { type: "text", text: header },
          payload.system,
        ];
      }
    } else {
      payload.system = [
        { type: "text", text: header },
        payload.system,
      ];
    }
  }
}
