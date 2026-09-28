# Reasoning replay, reasoning items, and message phase

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## DeepSeek Responses and Chat reasoning replay

Only direct provider `deepseek` with upstream model `deepseek-flash` uses the
existing API forwarder's native `/responses` route, including compaction.
Legacy aliases and resellers retain Chat. LiteLLM 1.96's unknown-model fallback
removes upstream streaming and synthesizes SSE; setting its protocol alone is
insufficient. Keep credentials, transport, usage, cancellation and pre-byte
retry rules on the shared path.

- Replay native reasoning once as a `reasoning.content` array of `reasoning_text`
  parts; convert legacy summaries there, never into visible messages. Preserve
  typed image/tool outputs and `input_image.file_id`, without uploading files.
- Convert recovered `agent_message` handoffs with `agentMessagesAsUserMessages`
  on ordinary and compaction requests: task text in an unsupported item type
  is not delivered. Flatten namespaces/deferred tools through the existing
  adapters; retain native top-level `apply_patch` and bridge other custom tools.
  Restore exact namespace/name identities, including plain-name collisions.
- Codex can flatten native and MCP function/custom declarations before sending
  them to a routed provider. Restore namespaces only for live, directly exposed
  tools identified by the request's canonical turn metadata. Rewrite declarations
  only on routes that flatten tools. Responses-native routes that skip
  flattening send the client's declarations unchanged, but build their response
  lookup from the restored inventory so a returned flat call still reaches Codex
  under its `{namespace, name}` identity. Restore before app expansion and
  normal flattening so client schemas, custom formats and collaboration model
  constraints use the existing adapters. Never infer tools from name prefixes or
  create declarations from metadata alone; ambiguous and ordinary-name
  collisions remain unchanged.
- GLM thinking, legacy DeepSeek thinking, Hy4 Preview (`hy4-reasoning`) and
  Command Code's DeepSeek Flash Chat route carry reasoning through LiteLLM as
  assistant `thinking` parts, restored by the forwarder to `reasoning_content`.
  An interleaved-thinking model that instead sees its past reasoning replayed as
  visible assistant text moves new thinking into the answer channel and loops
  on its last progress note (Hy4 on opencode Go, 12 September 2026: 2, 4, 5,
  8, 16 copies per message). The rule belongs to the upstream model, not to
  the reseller or its request profile, so `src/chat-reasoning.mjs` also keys
  it on the upstream family (DeepSeek, GLM-5.x, Kimi K3, MiniMax M3, Tencent
  Hy3/Hy4) for the Chat Completions resellers it lists. Add a family only with
  evidence the vendor expects `reasoning_content` back, and a reseller only
  after a live probe shows the route returns reasoning and accepts the
  echo-back; Anthropic-protocol variants never enter it. Do not special-case
  the carry instead. A Chat Completions route **outside** the contract drops the
  reasoning from the carry rather than replaying it as `output_text`: the
  visible-text replay is the loop trigger named above, and dropping asserts
  nothing about a vendor's `reasoning_content` handling, so it needs none of the
  evidence a family entry does. That path was inert until #708 widened the
  reasoning-lifecycle repair to every `openai`-protocol provider and Codex began
  storing reasoning items for these turns (#755). Adding a family is still the
  better outcome where the evidence exists — dropping keeps the model coherent,
  but it does lose the thinking. This is a routed-path rule only, and it does
  not generalise: the native backend faces the opposite constraint, since it
  rejects a foreign reasoning item outright and never reads a reasoning
  `summary`, so visible text can be the only replay that survives there. Weigh
  the two separately rather than making either the house style. Remove only successfully carried
  reasoning runs so plaintext cannot also become a user message. Do not mutate
  source items or change other native Responses routes. Keep this policy shared
  between hops without applying direct DeepSeek sampling parameters to resellers.
  Command Code's schema-strict `/alpha/generate` fallback remains separate.

Regression coverage lives in `test/deepseek-responses-routing.test.mjs`,
`test/namespace-relay-custom.test.mjs`, `test/chat-reasoning.test.mjs` and the
Chat replay cases in `test/routing.test.mjs`. For the optional offline proof,
set `MODEL_ROUTER_TEST_LITELLM_PYTHON` to a Python interpreter with the repository's
pinned LiteLLM and run `node --test test/chat-reasoning.test.mjs`. It uses only
loopback services and synthetic credentials, with duplicate negative controls.
See the provider's [Responses contract](https://api-docs.deepseek.com/guides/responses_api/).

## Routed assistant messages carry a phase label

Native models label every assistant message `commentary` or `final_answer`.
Codex folds commentary into its "Worked for ..." group, renders the final
answer below it, and finds a thread's answer with
`json_extract(item_json, '$.phase') = 'final_answer'`. Routed providers send no
label, so `src/message-phase.mjs` assigns one.

1. **The rule is the one native turns follow, read from item order.** A message
   that a tool call or another message follows is commentary; the last message
   of a `response.completed` or `response.done` is the final answer, even when
   reasoning items follow it. Reasoning decides nothing: labelling that message
   commentary left the turn without an answer, and Codex's thread-history
   fallback reads only messages whose phase is null. `response.failed`,
   `response.incomplete` (a stream error to Codex), and `error` leave the last
   message unlabelled. Never infer the label from the text.
2. **A provider's phase always wins.** Only an absent or null phase is filled,
   so a Responses provider that already labels messages passes through
   unchanged.
3. **Hold one message frame, briefly.** Only the message's `output_item.done`
   waits, until a tool call or message opens or the response settles. A
   reasoning item in between is held with it, deltas included, inside the
   1 MiB bound; text deltas before the done frame stream live, and everything
   held is replayed in order. A failed, incomplete, errored, or
   `[DONE]`-terminated response, a clean end of stream without a terminal,
   invalid UTF-8, or an exhausted hold bound releases the original bytes
   unlabelled. An upstream error does not: `pipeResponse` destroys the stage, a
   destroyed stream cannot push, and the held frames are lost with the stream
   -- as they are in the item-lifecycle normalizer and the other holding stages
   -- before the router ends the body with `local_router_stream_failed`.
4. **It is metadata, not transcript, but Codex replays it.** It adds no text and
   costs no model tokens. Codex stores the label and sends it back with the
   message on every later turn. Chat-translated routes drop it: LiteLLM
   rebuilds chat history from role and content, Anthropic-protocol routes are
   rebuilt the same way, and Antigravity builds its messages from text and tool
   calls. Providers with `protocol: "openai-responses"` receive it. Their
   `openai/responses/<model>` deployments pass input items through, as do
   `normalizeRoutedInput`, `normalizeResponsesRequest`,
   `deepSeekResponsesInput`, and WebSocket continuation state. That covers Meta,
   OpenCode, OpenCode free, GitHub Copilot, and DeepSeek Responses. OpenAI's
   Responses schema defines the field, and native passthrough keeps it. Local
   rollouts show OpenCode's Responses surface accepting it (Muse Spark emits it
   itself); the other built-in Responses providers are unverified. An
   operator-configured `--adapter openai-responses` endpoint is an unknown
   validator, so `src/api-forwarder.mjs` omits `phase` from its message input
   items with `withoutInputMessagePhase`. A built-in provider shown to reject
   the field needs the same narrow input strip and a test, not a change to the
   label.
5. **Routed streams only, after the item-lifecycle normalizer**, so items are
   already sequential. Coverage lives in `test/message-phase.test.mjs`, the
   routed case in `test/namespace-relay-routing.test.mjs`, and the generic
   Responses input case in `test/generic-routing.test.mjs`.

## Chat Completions reasoning reaches Codex as one reasoning item

LiteLLM 1.96's Chat Completions to Responses bridge opens the assistant message
first, then streams `response.reasoning_summary_text.delta` under a fresh
hashed `rs_…` id per delta (or the message's id), with no reasoning
`output_item.added` or `reasoning_summary_part.added` and on the message's
`output_index`. Codex drops deltas that belong to no open item, so reasoning
never rendered and no reasoning item was saved to the thread. That held for
every Chat Completions route (measured on `commandcode/hy4-preview` and
`opencode-go/deepseek-v4.1-flash`), not only Grok.

1. **One repair, scoped by protocol.** `reasoningSummaryCompatTransform` in
   `src/grok-reasoning-summary-compat.mjs` attaches the lifecycle repair to
   every provider whose `protocol` is Chat Completions (`openai`, the default)
   **or Anthropic Messages** (`anthropic`). LiteLLM still sets
   `use_chat_completions_api: true` for Anthropic routes, so Union Alpha and
   `commandcode-messages` arrive as the same message-first hashed summary
   stream. Direct `deepseek` is excluded because
   `DeepseekToolMessageCompatTransform` already repairs its bridge, and
   `openai-responses` providers skip this bridge. Widening it to another
   protocol needs a captured stream from that protocol first.
   LiteLLM can also close the assistant message with
   `content_part.done` `reasoning_text` before `output_text.done`. That close
   is thinking leaking onto the message part, not the end of the answer:
   rewriting it to `output_text` while text is still arriving truncates the
   visible reply (Union Alpha stopped at `Union Alpha (`). Drop the premature
   close and only rewrite one that follows a grown `output_text.done`. The
   drop must still apply when no `reasoning_summary_text.delta` has opened
   the repair — a live ImageGen turn streamed the prefix, closed as
   `reasoning_text`, then `response.completed` with 21 tokens, and Codex
   stored that cut as `final_answer`. Hold the prefix until `output_text.done`
   whose text grew after the close; a done snapshot that is still the leaked
   prefix (the ImageGen turnaround that stopped at `(no reference`) is
   truncated thinking too. LiteLLM 1.96's finish sequence also emits that
   done snapshot *before* the `reasoning_text` close, which stored
   `The skill is loaded. This is a single concept-sheet generation: a
   GTA-style AAA` as `final_answer`. Hold the done event until the part
   close; if its text is the thinking or a prefix of it, withhold so
   empty-completion retries. A held done that LiteLLM then closes as
   `output_text` is still truncated when the snapshot is a mid-clause cut
   (`I'll use the image generation` after the 14:12 empty-completion retry).
   Punctuated answers stay answers. A single token with no whitespace
   (`CODEX_ROUTER_STREAM_OK`) is a finished marker, not a mid-clause cut.
   If the stream completes without a grown done, withhold the message so
   empty-completion retries or fails rather than succeeding.
2. **Grok's gateway-error wording stays on Grok OAuth.** Only `grok-oauth`
   replaces an untyped LiteLLM error envelope with the fixed local error. Other
   routes relay that envelope byte-identical, after closing the reasoning item
   as `incomplete` and releasing any message the repair was holding.
3. **The pre-commit frame bound is 10 MiB, like the namespace relay's.**
   LiteLLM echoes the request's `instructions` and full `tools` array in
   `response.created`, and a Codex Desktop tool list exceeds 256 KiB. A smaller
   bound releases that frame raw and disables the repair for the whole stream,
   which no mock gateway with a tiny prelude reproduces. Any fixture for this
   path must echo a Desktop-sized tool list.
4. **Canonical streams pass byte-identical.** Coverage lives in
   `test/grok-reasoning-summary-compat.test.mjs` and the Grok and Desktop-sized
   Chat Completions router cases in `test/routing.test.mjs`. The regression
   oracle is a live Codex turn whose rollout records a `reasoning` item.
