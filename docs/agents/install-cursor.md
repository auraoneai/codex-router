# Cursor target (Cursor Agent and Cursor App)

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Cursor outcome

Publish every selected, credentialed routed model to Cursor Agent and Cursor
App without exposing the main router capability, preserve unrelated Cursor
settings, and leave Cursor stopped so the user can reopen it cleanly.

## Cursor procedure

1. Steps 1-6 of the Codex procedure apply, except that Cursor App and/or the
   official `cursor-agent` binary replace Codex as the client prerequisite.
2. Require an explicit stable public HTTPS origin for Cursor App. It must be a
   user-owned named tunnel (or equivalent) forwarding only to
   `127.0.0.1:4214`; never accept a temporary quick-tunnel URL and never point
   it at the main router port. Do not create DNS, tunnel, or cloud credentials
   without the user's authority.
3. Fully quit Cursor before writing its settings database. Run
   `./install.sh --target cursor --auto --providers IDS
   --cursor-public-url https://HOST` on macOS/Linux or
   `./install.ps1 -Target cursor -Auto -Providers IDS
   -CursorPublicUrl https://HOST` on Windows. The manager refuses a live Cursor
   process because the app can overwrite external SQLite changes on exit.
4. Run `bin/model-router cursor doctor`. The Cursor app routing config, Agent
   launcher, catalog freshness, caller capability, separate public-edge key,
   service, router health, and selected credentials must be `OK`.
5. Tell the user to run `cursor-router-agent` for Cursor Agent and to reopen
   Cursor App and choose a `codex_router/readable_name__digest/effort` model.
   The neutralized name avoids Cursor's built-in-substring BYOK rejection, and
   the suffix is how the user changes effort because Cursor gives ordinary
   user-added models no native parameter controls. The app override is global,
   so they should turn it off before returning to Cursor-managed models.
6. Cursor Agent text turns and its local read, shell, edit, and write loop are
   supported. The adapter sends typed controlled-exec messages back to the
   official client, which performs the operation under Cursor's own permission
   mode, then returns the typed result before the model resumes. Never execute
   those operations inside the router or bypass Cursor's permissions. Cursor
   MCP tools use a separate exec shape and stay unadvertised until it has the
   same official-client proof.

## Cursor target

Cursor is a client target, not a provider. The implementation was measured
against Cursor Agent `2026.08.25-3e8eec8` and Cursor App `3.16.17`.

1. **Cursor Agent speaks Connect/protobuf.** `CURSOR_API_ENDPOINT` points the
   official binary at the router's caller-capability root. The adapter serves
   auth exchange, live routed model catalog/default, `RunSSE`, and
   `BidiAppend`, then re-enters `/v1/responses`. `cursor-router-agent` is the
   installed launcher and keeps the capability out of command arguments.
2. **CLI tool execution stays in Cursor.** The adapter maps read, bash, edit,
   and write calls onto Cursor's typed controlled-exec protocol, waits for the
   client's result, and resumes the model with that result. Cursor therefore
   remains the process that applies its permission mode and touches the local
   workspace; the router never executes a model-requested command or file
   mutation itself. The protocol is covered by wire-level tests and a live
   official-CLI proof. MCP declarations are not advertised because their
   separate exec shape has not received the same proof.
3. **Retail Cursor App is server-mediated.** A loopback base URL is refused as
   private-network access. `--target cursor` therefore requires a stable public
   HTTPS origin whose tunnel forwards only to `127.0.0.1:4214`. The separate
   edge accepts only secret-bearing `/v1/models` and `/v1/chat/completions`,
   translates both Chat Completions and Responses-shaped bodies, and re-enters
   the canonical router path. The main router port stays loopback-only.
4. **Cursor's override is global.** Enabling it can also send Cursor-managed
   model slugs to the custom edge. Routed models use collision-safe
   `codex_router/readable_name__digest/effort` aliases because Cursor rejects a
   custom BYOK id containing a built-in model id before it reaches the edge.
   Cursor gives user-added models no stable native parameter metadata, so each
   supported reasoning effort is a separate picker row and the edge restores
   it as `reasoning.effort`. Turn the override off when returning to
   Cursor-managed models.
5. **Cursor must be stopped for settings writes.** The manager transactionally
   updates the application-user JSON in `state.vscdb`, preserves unrelated
   state, records its owned aliases, and reverses only its own changes. A live
   Cursor process may overwrite an external transaction on exit, so publish,
   republish, repair, and uninstall refuse while it is running.

Three findings from that work generalize to any CLI-backed provider, and cost
real debugging to obtain:

- A CLI's `--stream-partial-output` may not *replace* its message-level
  emitter. cursor-agent runs both, so a turn answering "391" emits two
  `assistant` events each reading "391"; concatenating every one of them
  streams "391391". Reconcile deltas against an accumulator rather than
  trusting that one emitter excludes the other.
- Token usage came back camelCase (`inputTokens`) from the live result while
  the shipped bundle's source spells it snake_case. Reading only the spelling
  the source suggests reported every real turn as zero usage, which the router
  records as a genuinely free turn.
- Reading a vendor's bundled source narrows the guesswork but does not replace
  one real request. Every one of these survived a full green suite built on
  fixtures derived from that source.
