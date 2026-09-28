# Devin CLI provider

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## The Devin CLI provider is unverified, and says so

`devin-cli` reuses the session `devin auth login` writes and spends that
account's ACU credits, the same shape as `kimi-oauth` and `grok-oauth`. What is
not the same is the transport, and that difference governs everything else
about it.

1. **There is no model API.** Cognition documents a *session* API
   (`api.devin.ai`), not a chat API. The models answer only on Cascade —
   `exa.api_server_pb.ApiServerService` over Connect RPC at the
   `api_server_url` the CLI stored. The schemas in `src/devin-proto.mjs` are
   transcribed from the descriptor the shipped Devin client carries, which is
   the only published source for them. Treat every field number as evidence
   from one client version, not as a contract.
   Where that descriptor lives moved with the 3000.x series. The 2025.x `devin`
   binary embedded a descriptor set; 3000.10.31 is stripped of one, and the
   readable source is now the desktop client's generated protobuf-es field
   lists under `@exa/chat-client` (`Devin.app/Contents/Resources/app/
   node_modules/`), which spell each `no:` literally for the same
   `exa.api_server_pb`, `exa.codeium_common_pb`, and `exa.chat_pb` messages.
   Re-transcribe from whichever of the two the installed client actually ships,
   and record the version you read.
2. **Unverified until someone with an account proves it.** No maintainer has
   run a live turn. The registry entry ships no models, the provider is
   catalog-only, and nothing may claim support until `bin/devin-probe --live
   --tools` passes for a real account. Do not set `multiAgentVersion`, do not
   check in model fragments, and do not describe this provider as working in
   README or release notes on the strength of the unit tests alone.
3. **The unit tests prove translation, not the protocol.** `protobuf-wire`,
   `devin-cli-turn`, `devin-cli-status`, and `devin-connect` cover the wire
   codec, the request mapping, the credential reader, and the envelope framing
   against fixtures. They cannot prove Cascade accepts the request. A green
   suite here is necessary and nowhere near sufficient.
4. **The decoder must stay permissive and the credential reader strict.**
   Unknown protobuf fields are skipped, because the upstream adds them without
   notice and a strict decoder would fail whole turns. `credentials.toml` is the
   opposite: it is read through `toml-structure.mjs`, so a duplicate key or a
   value the scanner cannot read plainly is refused rather than guessed at.
5. **The router reads that file and never writes it.** No code path may create,
   move, copy, or delete another tool's credential file, and the token never
   reaches a log, an argument, or an error message. `--no-discovery` must keep
   the file closed entirely.
6. **Entitlement is the account's, not the registry's.** Which models an
   operator may run is decided server-side by `GetCascadeModelConfigs` and team
   settings. Discovery asks; the registry never guesses. A model that appears
   for one account may be absent or refused for another.
7. **Expect drift, and fail loudly when it happens.** An unversioned transport
   can change under a `devin` update. When it does, the symptom is a Connect
   `invalid_argument` on every turn, not a subtle wrong answer — keep it that
   way rather than adding tolerant parsing that would mask a schema change.
   That is not hypothetical: it happened, and the shape of it is worth keeping.
   Devin 3000.x moved the CLI's model list from `GetCascadeModelConfigs` to
   `GetCliModelConfigs` (#770). Both methods are still declared on the service
   — `GetCascadeModelConfigs` is the IDE's and the CLI no longer calls it — so
   a CLI-credentialed account was answered `invalid_argument` rather than
   `unimplemented`, and the router read that as its own encoding being wrong.
   It was not: `bin/devin-probe`'s request-shape check passed in the same run,
   and re-reading every field the router writes against 3000.10.31 found all of
   them unchanged. **A refused call whose encoding audits clean is evidence
   about the method, not about the bytes** — check the method the installed CLI
   calls before touching a field number. `test/devin-proto.test.mjs` pins the
   method names and those field numbers as literals, because a test that reads
   the constant it guards passes straight through a rename.
   Two rules make "loudly" mean something. First, a Connect error code must
   reach the router as the HTTP status the protocol assigns it: the sixteen-code
   table in `src/connect-stream-audit.mjs` is the single source, imported by the
   client rather than restated, and a code that fell through to 502 would be
   read one layer up as a transient fault in the chain and sent again — which is
   precisely wrong for `unimplemented`, the answer to a service path or method
   name that drifted. Second, the client asks for
   `connect-accept-encoding: identity` and refuses a frame that carries the
   compressed bit anyway (`devin_compressed_frame`). Compressed bytes are not
   protobuf, so decoding them produces an empty turn or an unactionable wire
   error; do not add decompression to this transport on the strength of a
   fixture, because no maintainer can test it against Cascade.
8. **An operator who never curated a Devin model pays nothing for it.** Unlike
   the three forwarders that always run, `src/devin-cli-forwarder.mjs` is
   spawned only when `MODELS` contains a `devin-cli` model, so an unconfigured
   install starts no fourth child, binds no fourth port, and waits on no fourth
   health probe. The gate is deliberately the curated model and not the stored
   credential: a curated model is exactly what makes `writeLiteLlmConfig()`
   emit a `DEVIN_CLI_FORWARD_BASE_URL` route, and both are read from the same
   `MODELS` array on the same boot, so a live gateway route can never point at
   a port nothing bound. Gating on `credentials.toml` instead would trade the
   forwarder's actionable 401 naming `devin auth login` for a bare connection
   error. An unverified provider must stay free for the people not using it —
   apply the same rule to any future provider that needs its own forwarder.
