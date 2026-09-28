# Tool-call integrity on routed streams

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## A completed function_call must carry parseable JSON arguments

A provider that finishes a tool call with unterminated or otherwise invalid
JSON arguments produces an item the client cannot execute. Codex stores it
anyway, replays it on the next turn, and every later request on that thread
then fails — locally on Anthropic/Messages routes, as a generic provider 400
on OpenAI-compatible ones (#797). LiteLLM's `_attempt_json_repair` only closes
unmatched brackets and correctly refuses a string that was never terminated;
closing it here would invent command bytes.

1. **Fail the completed call, never repair it.** When a routed
   `function_call_arguments.done`, `output_item.done`, or non-streaming
   `output[]` carries non-empty arguments that `JSON.parse` rejects, withhold
   the whole call (opening item and deltas included) and fail that attempt.
   Closing an unterminated string would invent command bytes. Empty arguments
   stay allowed (the call may still be streaming). Custom tool calls and
   `preserveRawArguments` codec items keep their freeform text for the native
   hook. Duplicate keys still parse and are not this failure. If nothing has
   been relayed, retry once on the same path as an empty completion. After that
   retry, or if a byte already left, fail the turn locally so Codex cannot
   store the item.
2. **`jsonArgumentsAreUnambiguous` still only gates rewriting.** The namespace
   relay's `#unsafeSseFrame` pass-through is not permission to store an
   unusable call. The refusal lives in `src/invalid-function-call.mjs`, after
   the namespace transform (so restored names appear in the error) and before
   the empty-completion guard.
3. **A stored invalid call is refused locally before any provider request.**
   Name the tool, call id, and input index. Do not echo the argument body.
   Do not attribute the failure to the provider. Coverage lives in
   `test/invalid-function-call.test.mjs`, the conversion cases in
   `test/error-translation.test.mjs` and `test/model-failover.test.mjs`, and
   the router cases in `test/model-failover-router.test.mjs`.

## A model that writes its tool calls as text has them recovered, not relayed

Tencent Hy4 Preview carries a tool-call syntax of its own,
`<tool_calls:NONCE><tool_call:NONCE>name<arg_key:NONCE>k</arg_key:NONCE><arg_value:NONCE>v</arg_value:NONCE>...`.
Serving stacks disagree about it: the agent-check tool probe recorded
`commandcode/hy4-preview` failing on exactly this markup while
`opencode-go/hy4-preview` passed the same probe minutes later, and the
opencode-go route then leaked it intermittently mid-session. Nothing reaches the
`tool_calls` array on a leaked turn, so LiteLLM's chat-completions -> Responses
bridge relays a reasoning item followed by an assistant message with empty
content and no `function_call`. Codex ends the turn there and writes
`task_complete` with `last_agent_message: null`: the client shows its
"Worked for ..." group and no answer at all, with no error anywhere.

`src/leaked-tool-call-recovery.mjs` parses that markup back into real
`function_call` items.

1. **Only the model's own calls.** The transform relays a call the model wrote;
   it never authors one. A span that is unterminated, carries a mismatched
   nonce, names something that is not a tool name, or fails to parse for any
   other reason is relayed verbatim and recovers nothing. A stream without the
   markup is passed through byte-for-byte, and invalid UTF-8 disables rewriting
   for the rest of the stream.
2. **The nonce is read, never assumed.** `6124c78e` appears in every capture to
   date, on both routes, but it is taken from the opening tag and the closing
   tag must repeat it. Do not hardcode it.
3. **One item contributes its calls once.** The same span arrives on the delta
   channel, in the `.done` snapshot, and in the stored item; recovery is keyed
   by output index so the call is emitted a single time. The summary and content
   channels are two renderings of one item's thinking, so they hold separate
   span streams and the fuller reading wins -- sharing one stream between them
   made the second channel look like a genuine extension of the first and
   recovered, and executed, the call twice.
4. **A leaked argument value is text.** It is read as JSON only when its text is
   exactly its own JSON form, so a declared `20000` or `true` survives while a
   shell command, a path, or `0755` stays the string the model wrote.
5. **Hy4 routes only, before the namespace transform**, so a recovered
   flattened `mcp__server__tool` call is restored like any other, the empty-
   completion guard sees content, and the phase labeller reads the blank
   message as commentary instead of a final answer. Native streams gain no
   stage, and neither does any other routed family: this is Hy4's own syntax,
   and scanning every routed provider's text for it would turn prose that
   merely *quotes* the markup -- a diff, a web page, this file -- into executed
   tool calls. `usesHy4NonceMarkup` is the gate (`usesLeakedToolCallRecovery`
   is its name at this call site); widening it past `hy4-preview` reopens that
   injection channel. The reasoning-tag stripper reads the same gate for the
   markup's reasoning delimiter, `</think:NONCE>` (#654): it strips the
   suffixed spelling and treats an orphan close -- one whose opening tag never
   arrived -- as the end of leaked reasoning, dropping the text in front of it.
   That reading is destructive, so it stays behind the gate and behind the
   suffix; a bare `</think>` keeps its prefix on every route. Coverage lives in
   `test/leaked-tool-call-recovery.test.mjs`, `test/reasoning-tag-stripper.test.mjs`
   and the leaked-channel case in `test/namespace-relay-routing.test.mjs`.
6. **A span is scanned once, not re-scanned per delta.** The capture is held
   unjoined with a closing-tag overlap because `_transform` is synchronous:
   re-scanning one growing string re-flattens the rope every delta, and a
   1.25 MB unterminated span blocked the event loop for 21.5 s against 0.8 s
   for the same bytes with no span open. The capture bound is 4 MiB.
