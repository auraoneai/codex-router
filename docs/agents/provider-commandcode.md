# Command Code provider routes

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Command Code is reached by two routes, and the plan picks which

Command Code sells one catalog behind two surfaces, and the documented one is
an entitlement rather than a credential. `POST /provider/v1/chat/completions`
and `/provider/v1/messages` are the published Provider API; an account below
the Provider plan signs in, mints a real key, runs the official CLI all day,
and is still answered
`403 {"error":{"code":"upgrade_required","message":"Your Go plan doesn't
include API access…"}}`. `POST /alpha/generate` is the route the `command-code`
CLI itself uses for every turn it takes, and it is not plan-gated. Serving the
cheap plans means speaking that route.

1. **The fallback is a route change, never a provider split.** `commandcode`
   and `commandcode-messages` stay one family with one credential and one
   catalog, exactly as the provider checklist requires. What changes is where
   the turn is sent, which is why this lives in `src/api-forwarder.mjs` beside
   the Copilot replay rather than in a forwarder of its own.
2. **Only the entitlement refusal may move a turn.** `isUpgradeRequired()` in
   `src/commandcode-plan.mjs` demands a 403 *and* the `upgrade_required` code
   (or its message). A timeout, a 500, or a rate limit says nothing about the
   plan, and reading one as a refusal would quietly move a paying
   Provider-plan account onto its coding-plan credits. Any other 403 is
   relayed with the provider's own message.
3. **It is legal because nothing has been relayed yet.** The refusal arrives
   before the first response byte reaches the caller, which is the same
   boundary the upstream-retry and model-failover rules draw. A fallback after
   a relayed byte would not be legal and is not attempted.
4. **The verdict is remembered per credential, not per process.**
   `commandcode-plan.json` stores a SHA-256 fingerprint of the key — never the
   key — so a new key after an upgrade re-probes, and a six-hour window
   re-checks a plan that changed under the same key. A success is written only
   when that window came due, so a healthy account does not rewrite state once
   per turn.
5. **The envelope is reverse-engineered, so re-derive it rather than guess.**
   Command Code publishes no reference for `/alpha/generate`. The shapes in
   `src/commandcode-generate.mjs` and `src/commandcode-stream.mjs` came from
   the shipped bundle at `$(npm root -g)/command-code/dist/cli.mjs` (v1.14.1)
   and were confirmed against the live gateway. Three traps are load-bearing:
   `config` is schema-strict and every field is required, `memory` is a string
   and not an object, and `params.messages` is the Vercel AI SDK
   `ModelMessage[]` schema — not Anthropic blocks and not OpenAI tool
   messages. The response is newline-delimited JSON despite the
   `text/event-stream` content type, its blocks interleave, and the trailing
   `tool-call` event keys on `toolCallId` where every incremental event keys
   on `id`.
6. **An empty `system` field is not "no system prompt".** It is a cue to
   splice in the Command Code agent's own preamble. Measured against the live
   gateway, the same one-line turn cost 92 prompt tokens with a system prompt
   and 7,637 without, and the model spent them being told it was Command Code
   with Command Code's tools. A turn carrying none gets a neutral one.
7. **Billing differs even though the models do not.** The Provider plan pays
   as it goes; a coding plan spends plan credits against 5-hour and weekly
   window caps and per-model allowances. That is what the `planNote` is for,
   and it is why the note stays on the registry entry now that the plan no
   longer blocks access outright.
