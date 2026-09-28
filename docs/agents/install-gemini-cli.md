# Gemini CLI target

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Gemini CLI outcome

Publish the router's routed models into Gemini CLI by writing one marker block
in the environment file it already reads, preserve every other line in that
file, never open its `settings.json` for writing, and leave the user's next
`gemini` run to pick the change up.

## Gemini CLI procedure

1. Steps 1-6 of the Codex procedure apply unchanged, except that Codex itself is
   not a prerequisite: a Gemini-only machine needs Node 22.19+, `uv` or Python
   3.10+, and the `gemini` CLI. Do not run `src/catalog.mjs` there, for the same
   reason the harness does not.
2. Run `./install.sh --target gemini --auto --providers IDS` (macOS/Linux) or
   `./install.ps1 -Target gemini -Auto -Providers IDS` (Windows).
   `--migrate-known` and `--adopt-native-catalog` are refused here: both act on
   Codex's own configuration.
3. Run `bin/model-router gemini doctor`. "Gemini routing config", "Gemini
   environment conflicts", "Gemini environment privacy", and "Gemini default
   model" must be `OK`, alongside the shared-plane checks.
4. Do not tell the user to quit anything. Gemini CLI reads its environment once,
   at process start, so the next `gemini` invocation has the new values. Tell
   them instead to choose "Use Gemini API key" if the CLI asks how to
   authenticate — that is a one-time choice the CLI saves for itself, and the
   key it will use is this router's local caller capability, not a Google one.

## What the Gemini integration writes, and what it must never touch

Gemini CLI speaks only the Gemini API, so it is the one client that cannot be
pointed at `/v1/responses`. Everything below exists so that fact costs one
translation layer and nothing else.

1. **One file, three keys, and no `settings.json`.** The router owns
   `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, and `GEMINI_MODEL` inside a
   `# BEGIN codex-router-gemini` block in `~/.gemini/.env` (`GEMINI_HOME` in
   `paths.mjs`, which honours the CLI's own `GEMINI_CLI_HOME` override). That is the whole
   integration: `createContentGenerator` in `@google/gemini-cli-core` builds a
   plain `@google/genai` client from those variables, so nothing else has to be
   configured. Its `settings.json` is JSONC carrying the user's own comments and
   is never opened for writing — a `JSON.parse`/`stringify` round trip there
   deletes every one of them. Publishing twice is byte-identical, removing the
   block restores the document exactly, and `test/gemini-env.test.mjs` asserts
   both against a document with somebody else's work around ours.
2. **Refuse rather than guess.** `dotenv` lets the last assignment of a key in a
   file win, so a `GEMINI_API_KEY=` below our block silently decides the
   credential and nothing in the file says so. `conflictingAssignments()` finds
   any managed key assigned outside the block and the publish stops with the
   line named and the file untouched. Damaged markers — a missing end, a second
   begin — are refused the same way. Never add a "best effort" path there.
3. **The document is private.** It carries the caller key and the managed base
   URL, so it is written 0600. `~/.gemini` is created 0700 when absent and
   deliberately *not* re-moded when present: that directory is Gemini CLI's, and
   `protectPrivateFile` on a directory would strip its execute bit and break the
   CLI outright. Status output reports the redacted URL, never the whole one.
4. **`gemini` is a leaf of the caller capability, like `v1` and `panel`.** The
   SDK appends `/v1beta/models/{model}:{method}` to whatever base URL it is
   given, so the secret has to sit in the path ahead of it. A new leaf must be
   added to `redactCallerUrl` at the same time it is added to the router, or the
   caller key reaches doctor output and support bundles in the clear.
5. **The surface translates and re-enters; it never reaches a provider.**
   `gemini-surface.mjs` converts a Gemini request into a Responses request,
   sends it through the router's own `/v1/responses` over the loopback, and
   converts the answer back. That is what keeps the harness rule intact in
   spirit: tool-result ageing, the vision bridge, prompt-token substitution,
   upstream retry, model failover, and usage accounting all still sit on one
   request path. Do not give this surface its own upstream.
6. **The loopback carries no credential.** The key the CLI presents *is* this
   router's caller capability, and the path it presented it on is already the
   proof. Relaying it upstream would put a router secret on a hop that can be
   substituted onto a provider — and leaving the header off is also what makes
   `callerBroughtNoUpstreamCredential` true, which is how a client with no
   ChatGPT session of its own reaches native models after the user explicitly
   authorizes the shared router plane once.
7. **The default model is written, and that is deliberate.** Gemini CLI's own
   default is `gemini-2.5-pro`, which this router does not route, so an install
   that left it alone would 404 on the user's first turn. `GEMINI_MODEL`
   out-ranks `settings.json`'s `model.name` and is out-ranked by `--model`;
   `--no-default-model` turns it off. This is the one place the Gemini
   integration deliberately departs from the harness's opt-in rule, because
   there the default is a convenience and here it is the difference between a
   working install and a broken one.
8. **`embedContent` is refused, not faked.** The separate OpenAI-compatible
   `/v1/embeddings` surface is model-gated and is not a Gemini translation
   contract. Gemini CLI calls `embedContent` only from `baseLlmClient`, never
   from the turn loop, so a named 501 is the honest answer and a fabricated
   vector would be the dishonest one.
9. **`countTokens` is estimated.** There is no upstream to ask, and spending a
   real turn to answer a count would bill the user for a question they asked for
   free. A client that gets no number cannot decide whether to compact, so the
   same byte-ratio estimate `response-usage.mjs` uses for prompt accounting is
   the better failure.
10. **The model list is served live, so it cannot drift.**
    `/gemini/v1beta/models` reads the catalog the router already publishes,
    which is why this integration has no copy to keep in step. The published
    *default model* is a snapshot and can drift; `gemini-models.json` records
    it, doctor compares it against the routable set, and it is the marker that
    decides whether the integration is installed.
11. **A tool schema arrives as `parametersJsonSchema`, not `parameters`.**
    `tools.js` in `@google/gemini-cli-core` writes every built-in tool's schema
    into that field and validates incoming calls against the same one. Reading
    only `parameters` — the older Schema-proto spelling, which the type also
    permits — sent all ten tools upstream with no schema at all: the model
    invented argument names and the CLI rejected each call with "params must
    have required property 'file_path'". Every test passed while that was true,
    because a fixture written from the type definition spells it the other way.
    A declaration with neither field is sent as `{type: "object", properties:
    {}}` rather than with `parameters` omitted, because a chat-completions
    provider refuses a function whose parameters are absent.
12. **Verify against the real CLI, not against the docs.** Google's own
    documentation does not describe this configuration; the contract was read
    out of the installed `@google/genai` and `@google/gemini-cli-core` bundles
    (`GOOGLE_AI_API_DEFAULT_VERSION`, `formatMap('{model}:streamGenerateContent
    ?alt=sse')`, `GOOGLE_API_KEY_HEADER`, `resolveModel`'s pass-through default)
    and then proved by driving `gemini -p` at the surface. A change to the wire
    shape needs that same proof, not a plausible reading.
