# Subagent capability and routed subagent regressions

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Subagent capability is researched, not asserted

Switching a model on as a subagent (tray toggle, `control subagents set`) is
the operator's whole job; deciding whether that model **under that provider**
can hold the v2 child role is the router's. The same model answers differently
per provider — tool support, request profiles, and payload handling all vary —
so the unit of evidence is always the slug, never the model name.

1. Enabling an unknown model hands it to a detached compatibility probe
   (`src/subagent-verify.mjs`): two live requests through the installed router
   proving streaming and a forced tool call. The proofs snapshot shows
   `checking` until the verdict lands. A passing probe records `candidate`; it
   does **not** advertise v2. A worker that dies without a verdict records a
   failure, and a stale `checking` record is retryable. Explicit registry-v1
   routes are settled decisions and are never re-opened by this local probe;
   registry-v2 routes need no compatibility probe.
2. `multi-agent-proofs.json` is diagnostic application evidence only. Local
   `candidate`, and legacy `experimental` / `proven`, records cannot change the
   catalog's `multi_agent_version`, managed agent definitions, or any client
   route. `applySubagentProofs` deliberately returns the registry capabilities
   unchanged. An unreadable proofs file therefore authorizes and promotes
   nothing.
3. The compatibility probe is not the native collaboration proof. It does not
   exercise Codex's encrypted child payload relay, a marker-return spawn, or a
   same-thread follow-up. A successful ordinary chat/tool request must never be
   presented as evidence that the model can hold the native v2 child role.
4. Only the exact checked-in registry route may assert v2. The route's slug,
   provider, and upstream model must match an accepted artifact under
   `v2_agent/`, and the accepted artifact and `multiAgentVersion: "v2"` change
   land in the same pull request. CI enforces the implication in both
   directions for every post-workflow promotion. Six exact Kimi/Grok route
   identities certified before the artifact gate are grandfathered; changing
   any part of one identity loses that exception.
5. `control subagents verify [SLUG ...]` re-researches explicitly (foreground,
   about two requests per unknown candidate); with no slugs it sweeps the
   enabled list. Select-all and mode changes never trigger probes. Provider,
   model, and family auto-policies are explicit standing consent for matching
   newly configured unknown routes; they still produce only candidates.
6. Machine-local evidence is exactly that. Never edit checked-in `config/`
   because one machine's probe passed. Complete the redacted application,
   reproduce the two native child checks with a spendable account, and review
   the exact provider route before shipping a v2 claim to every installer.

## Routed subagent regression prevention

- A normal `/responses` smoke test does not cover Codex collaboration. Current
  model-generated subagent tasks and messages can arrive as native
  `encrypted_content`, with visible text ending at `Payload:`. External models
  cannot read that payload directly.
- The compatibility relay must remain signed-in-only and fail closed. Send its
  native request with `stream: true`, accept SSE by body framing as well as
  content type, recognize padded `gAAAA...=` ciphertext, and treat non-Fernet
  `encrypted_content` from an external parent as plaintext.
- The same rule applies in reverse, and it is not conditional on the envelope.
  A routed subagent cannot mint an OpenAI token, so Codex stores its readable
  handoff under `agent_message.content[].encrypted_content` whatever the
  surrounding `Message Type:` rendering looks like. Before forwarding to a
  native Responses endpoint — `/responses` and `/responses/compact` alike —
  rewrite every non-Fernet `encrypted_content` part of an `agent_message` to
  `input_text`; that schema accepts only `input_text`, `input_image`, and
  `encrypted_content`, so `output_text` is not a fallback. Classify on the
  ciphertext format (the `gAAAAA` Fernet prefix over base64url with no
  whitespace), never on whether the plaintext looks readable, and forward a
  value that passes byte-identical. Do not gate this on a router-written
  sentinel: the router never authors these items, and a marker would strand
  the already-broken conversations this recovers.
- The native endpoint also checks an optional item `id` against the prefix it
  mints for that item type: `fc` for function calls, `ctc` for custom tool
  calls, `msg` for messages. Codex saves and replays the IDs routed providers
  minted (`call_...`, `tool_...`, `chatcmpl-...`), so a conversation moved back
  to a native model fails with "Expected an ID that begins with 'fc'" once one
  is in its history. `normalizeNativeInput` omits only a string `id` without
  that prefix, on `/responses` and `/responses/compact` alike. `call_id` still
  pairs each call with its result, a native-only history is forwarded
  unchanged, and routed requests keep their IDs. The `native replay omits
  incompatible item IDs` case in `test/routing.test.mjs` holds both sides.
  The custom→function bridge is the other direction: Console Go requires `fc`
  on function-shaped items, and a rewritten `custom_tool_call_output` still
  carried `ctco_…` (#780). `bridgeCustomTools` omits a non-`fc` string `id` on
  the rewritten call and output; `call_id` still pairs them. A native-minted
  `fc…` id is kept. Do not mint a substitute id.
- Never log relay response bodies, decrypted task text, or exception messages
  that can echo either. Regressions require fragmented/mislabeled SSE tests and
  real marker-return probes through every installed routed agent plus a
  same-thread follow-up.
- A test that isolates the state directory must isolate `CODEX_HOME` with it.
  `MODEL_ROUTER_STATE_DIR` and `CODEX_ROUTER_STATE_DIR` do not redirect
  `CODEX_AGENTS_DIR`, which is `$CODEX_HOME/agents`, and `src/catalog.mjs`
  prunes that directory to the exact registry-v2 routes the state it just read
  leaves enabled and visible.
  Point the state at a scratch directory while inheriting the real home and the
  run deletes the operator's own routed agent definitions — every model
  selected in the real state can disappear from that scratch publication —
  while `multi-agent-settings.json` and `multi-agent-proofs.json` live in the
  scratch state. The operator sees subagents reset after an unrelated command.
  `test/state-owner.test.mjs` pins this: no test file may spawn the catalog
  without setting `CODEX_HOME`.
