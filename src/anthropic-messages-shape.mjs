// Request-shape repairs for bodies the forwarder sends to Anthropic's Messages
// API after protocol translation.

const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result"]);
const EPHEMERAL_CACHE = Object.freeze({ type: "ephemeral" });

function hasCacheControl(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasCacheControl);
  if (value.cache_control) return true;
  return Array.isArray(value.content) && value.content.some(hasCacheControl);
}

// Marks the last cacheable block of a message; a string body becomes one text
// block so it can carry the marker.
function markMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (typeof message.content === "string") {
    if (!message.content) return false;
    message.content = [{ type: "text", text: message.content, cache_control: EPHEMERAL_CACHE }];
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (!CACHEABLE_BLOCK_TYPES.has(block?.type)) continue;
    if (block.type === "text" && !block.text) continue;
    message.content[index] = { ...block, cache_control: EPHEMERAL_CACHE };
    return true;
  }
  return false;
}

// Requests reach Anthropic through protocol translation (Claude Code
// Messages -> Responses -> Messages, Codex Responses -> Messages), which drops
// the client's own cache_control markers. Without breakpoints every turn is
// billed and rate-limited as fresh input -- hundreds of thousands of tokens on
// a large tool surface. Place Anthropic's standard breakpoints (tools, system,
// the previous user turn, the newest turn) when the caller set none, staying
// within the four-breakpoint limit.
export function applyPromptCacheBreakpoints(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (hasCacheControl(payload.tools) || hasCacheControl(payload.system) || hasCacheControl(messages)) return 0;
  let placed = 0;
  // Anthropic refuses cache_control on a deferred tool, so the tools marker
  // goes on the last tool that is loaded up front.
  if (Array.isArray(payload.tools)) {
    for (let index = payload.tools.length - 1; index >= 0; index -= 1) {
      if (payload.tools[index]?.defer_loading === true) continue;
      payload.tools[index] = { ...payload.tools[index], cache_control: EPHEMERAL_CACHE };
      placed += 1;
      break;
    }
  }
  if (typeof payload.system === "string" && payload.system) {
    payload.system = [{ type: "text", text: payload.system, cache_control: EPHEMERAL_CACHE }];
    placed += 1;
  } else if (Array.isArray(payload.system)) {
    for (let index = payload.system.length - 1; index >= 0; index -= 1) {
      const block = payload.system[index];
      if (block?.type !== "text" || !block.text) continue;
      payload.system[index] = { ...block, cache_control: EPHEMERAL_CACHE };
      placed += 1;
      break;
    }
  }
  if (messages.length > 0 && markMessage(messages[messages.length - 1])) placed += 1;
  for (let index = messages.length - 2; index >= 0 && placed < 4; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    if (markMessage(messages[index])) placed += 1;
    break;
  }
  return placed;
}

const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

// Current Claude models reject a request whose conversation ends with an
// assistant turn ("does not support assistant message prefill"). No routed
// client prefills on purpose: the trailing turn is an artifact of translation
// -- a closing developer note hoisted into `system`, or reasoning carried past
// the last answer. Trailing thinking-only content carries nothing the model
// needs and is dropped; a trailing turn with real content is kept, and a short
// user turn is appended so the conversation stays intact and legal.
export function endMessagesOnUserTurn(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  let changed = false;
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    const last = messages[messages.length - 1];
    if (!Array.isArray(last.content)) {
      if (typeof last.content === "string" && last.content.trim()) break;
      messages.pop();
      changed = true;
      continue;
    }
    const content = last.content.filter((block) => !THINKING_BLOCK_TYPES.has(block?.type));
    if (content.length > 0) {
      if (content.length !== last.content.length) {
        messages[messages.length - 1] = { ...last, content };
        changed = true;
      }
      break;
    }
    messages.pop();
    changed = true;
  }
  if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
    changed = true;
  }
  return changed;
}

// An assistant turn must end with its tool calls: Anthropic reads text placed
// after the last tool_use as a prefilled continuation and rejects the request
// ("does not support assistant message prefill") even though a tool_result
// turn follows. Translation produces that shape when a commentary message is
// replayed around its calls -- often as an exact copy of the turn's opening
// text. Trailing text that repeats earlier text is dropped; any other text is
// moved in front of the first tool call so nothing the model said is lost.
export function settleToolUseTurns(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return 0;
  let settled = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content;
    let lastToolUse = -1;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      if (blocks[at]?.type === "tool_use") { lastToolUse = at; break; }
    }
    if (lastToolUse < 0 || lastToolUse === blocks.length - 1) continue;
    const trailing = blocks.slice(lastToolUse + 1);
    if (!trailing.every((block) => block?.type === "text")) continue;
    const head = blocks.slice(0, lastToolUse + 1);
    const seen = new Set(head.filter((block) => block?.type === "text").map((block) => block.text));
    const moved = trailing.filter((block) => block.text && !seen.has(block.text));
    const firstToolUse = head.findIndex((block) => block?.type === "tool_use");
    messages[index] = { ...message, content: [...head.slice(0, firstToolUse), ...moved, ...head.slice(firstToolUse)] };
    settled += 1;
  }
  return settled;
}

