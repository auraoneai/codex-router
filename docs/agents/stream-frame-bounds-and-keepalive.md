# Pre-commit frame bounds and stream keepalive

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## LiteLLM's echoed prelude sets the pre-commit frame bounds

LiteLLM 1.96's Chat Completions to Responses bridge copies the request's
`instructions` and whole `tools` array into both `response.created` and
`response.in_progress` (`_default_response_created_event_data` in
`litellm/responses/litellm_completion_transformation/streaming_iterator.py`);
its `response.completed` does not echo them. Measured against the pinned
LiteLLM offline, with no provider quota: a 300-tool list and a 16 KiB
`instructions` string make `response.created` and `response.in_progress`
409 KiB each, while `response.completed` stays at 716 bytes and carries
`tools: []`. A stream repair that meets a frame over any of its pre-commit
budgets releases the bytes raw and switches itself off for the rest of the
response, so a small budget disables the repair in exactly the sessions with
the most tools, and no mock gateway with a bare envelope shows it.

1. **The frame bound is 10 MiB**, matching `MAX_SSE_FRAME_BYTES` in
   `src/namespace-relay.mjs`. `DeepseekToolMessageCompatTransform` and
   `TranslatedToolMessageCompatTransform` in
   `src/deepseek-tool-message-compat.mjs` use it, so the blank-message cleanup
   and direct DeepSeek's reasoning-bridge repair survive a large prelude.
2. **Every per-frame budget moves with it.** The strict JSON scan also counts
   object members and key code units per frame, and tool schemas are
   member-dense: with only the byte bound raised, the 8 KiB member budget still
   failed the same frame open. Both scan budgets are derived from the frame
   bound at the density the 256 KiB bound allowed. The 64 KiB candidate hold
   budget is deliberately unchanged, because the prelude is relayed as soon as
   it parses and is never held.
3. **A bound moves where failure happens, never what it does.** An over-budget
   frame is still released byte-identical, after any capture held ahead of it,
   and the repair stays off for that response. Never truncate, re-serialize, or
   skip part of a frame to fit a budget. Accumulator storage grown past an
   ordinary event is released once its frame is taken, so one large prelude
   does not pin that capacity for the whole stream.
4. **The scan costs CPU in proportion to the frame, so keep it bulk.** A
   pre-commit frame is decoded, uniqueness-scanned, and parsed synchronously on
   the router's event loop. Measured on the 409 KiB prelude that prompted this:
   3-6 ms, scaling at roughly 7 ms per MiB to 53 ms at 7.5 MiB. The frame
   scanner reaches that by jumping between line feeds rather than walking every
   byte -- the per-byte loop it replaced cost 49 ms on an 8 MiB frame on its
   own. Raising a bound again, or adding another pre-commit parser to the
   routed path, needs a measurement at the new bound rather than only a passing
   test. Measure uncontended: on a loaded machine these numbers inflate by more
   than an order of magnitude and invite a fix for a cost that is not there.
5. **Fixtures for this path echo a large, dense tool list.** "router keeps
   DeepSeek message repairs behind a Desktop-sized prelude" in
   `test/routing.test.mjs` asserts that its echoed prelude crosses both old
   budgets before it asserts either repair; the small-limit cases in
   `test/deepseek-tool-message-compat.test.mjs` hold the fail-open semantics.

## A silent Grok stream is kept alive, never replayed

Grok OAuth can reason for minutes with nothing to send, and every layer between
xAI and Codex has its own idle limit. The router's post-prologue stall guard
(`CODEX_ROUTER_GROK_STREAM_STALL_MS`, ten minutes) is the one meant to decide.

1. **Every transport hop outlasts the guard.** `src/grok-stream-timeouts.mjs`
   sizes the router's Grok gateway pool (its headers and body bounds), the
   gateway's per-deployment `stream_timeout` and non-streaming `timeout`, and
   the forwarder's xAI pool from that one value. Compaction is a hop too: it is
   not streamed, so its headers arrive only after the whole generation, and it
   uses the same pool and deployment bound as a turn. A new hop on the Grok path
   takes its bound from there. The shared Undici pool keeps its default for
   every other provider.
2. **Codex's idle timer is fed a lifecycle event, never a comment.** Codex
   abandons a stream after five minutes without a parsed data event and sends
   the whole turn again, which bills the provider twice; an SSE comment or a
   WebSocket ping does not reset that timer. `src/responses-heartbeat.mjs`
   relays `response.in_progress` carrying only the response's id, model, and
   creation time -- only after `response.created`, only at an event boundary,
   never after a terminal event, and as the last pipeline stage so no router
   transform parses it. It never carries text, reasoning, or a tool item: the
   rule against router-authored transcript content stands.
3. **Only Grok OAuth routes get either.** Other providers keep their stall bound
   and receive no heartbeat. Widening either needs the same proof: a router test
   that a silent stream survives, and one that another route is unchanged.
4. Coverage lives in `test/grok-stream-timeouts.test.mjs`,
   `test/responses-heartbeat.test.mjs`, `test/fetch-transport.test.mjs`, and the
   Grok cases in `test/empty-completion-router.test.mjs`.
