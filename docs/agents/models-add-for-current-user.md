# Adding models for the current user (local curation)

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Add models for the current user

1. Inspect the installed selection with
   `./bin/model-router codex providers list --json`. Do not assume that a stored
   credential means the provider is intentionally visible.
2. If authentication is missing, use the provider's official OAuth CLI or run
   `./bin/model-router codex provider-key PROVIDER set` in a PTY. Keep secrets
   out of chat, arguments, logs, environment snippets, and tracked files.
3. If the requested model is already checked into the registry tree under
   `config/` (one vendor directory holding a `<vendor>.json` provider file
   plus per-access-method `models.json` fragments, e.g.
   `config/kimi/kimi.json` and `config/kimi/oauth/models.json`), run
   `./bin/model-router codex providers enable PROVIDER`. This preserves the
   other selected providers and refreshes the installed picker catalog.
4. If the provider is registered but the model is not checked in, run
   `./bin/curate-models PROVIDER` in an interactive terminal. When the user gave
   exact IDs and the live catalog confirms them, the deterministic form is
   `./bin/curate-models PROVIDER --models ID1,ID2 --apply`. On Windows use
   `node .\src\curate-models.mjs` with the same arguments.
   OrcaRouter also supports `--free-only`, which additively curates every live
   concrete OpenAI-compatible entry whose catalog price is zero, tags it
   `isFree`, and removes the moving `orcarouter/free` meta-router if an older
   run curated it. It still requires an OrcaRouter API key for inference and
   never turns the provider on implicitly.
5. Local curation writes protected `user-models.json` state and survives router
   updates. Never edit the checked-in `config/` registry tree merely to
   satisfy one machine's
   request. The provider's own `/v1/models` endpoint alone decides which
   models exist. Interactive curation asks for each new model's context
   window, image support, and reasoning efforts (so the user can switch
   effort in the picker); the deterministic `--models` form takes
   conservative defaults, `--efforts minimal,low,medium,high,xhigh` sets the
   effort ladder, and every stored value stays editable in
   `user-models.json`. The context window is the exception to "conservative
   default": both forms store the `context_length` the provider's own catalog
   advertises for that model (`modelContextLengths` in
   `src/model-discovery.mjs`), because `autoCompact` is derived from it and an
   understated window makes Codex compact a session that had the room. Only a
   model the catalog sizes in silence falls back to 131072.
   OpenCode Zen's anonymous catalog publishes ids and nothing else, so its free
   models are sized and laddered from `src/opencode-curation.mjs`, which
   records OpenCode's own published `limit` and `reasoning_options` for each
   *free id* along with the sourcing. A documented window is stored only when
   the 0.85 auto-compact ratio still reserves that id's published
   `limit.output`; otherwise the id keeps 131072 and its description says the
   window is unknown, because a window a full-length completion can overrun
   fails the turn outright. An id OpenCode documents nothing usable for keeps
   the stock "conservative default metadata" description, which is how a
   stored entry says every value in it is a default rather than an advertised
   capability. An explicit `--efforts` always wins over a documented ladder. An entry curated
   before this landed keeps its stored window — an additive run never rewrites
   existing metadata — so repair it by editing `user-models.json` or by
   `--remove`-ing and re-curating the model. An optional `availabilityNux` string on a model becomes
   the Codex "Introducing {model}" announcement (shown a limited number of
   times per slug, tracked by the Codex client itself); leave it unset unless
   the model is genuinely news to the operator. Curated models are not
   implicitly approved as native v2 subagent model overrides.
6. A curated model inherits a request profile from the provider's registry
   models. The catalog-only resellers ship none, so curation also asks whether
   the model rejects a forced `tool_choice` (`--request-profile
   auto-tool-choice` in the deterministic form). Answer yes only for a model
   observed to answer HTTP 400 on `tool_choice: "required"` while still
   calling tools under `"auto"` — the restriction belongs to the upstream
   behind the reseller, not to the reseller, so it is set per model and never
   as a provider-wide default. When the upstream refuses the field in any
   form, including `"auto"` and `"none"`, use `--request-profile omit-tool-choice`
   instead: it deletes `tool_choice` and keeps the tools, except `none`, which
   also drops the tools so a prohibition cannot become the upstream default.
   Never widen it by changing what
   `src/compatibility-test.mjs` sends: the probe must keep sending `required`,
   or it stops proving tool calling works for every other provider.
   `dashscope-reasoning` is the same kind of model-scoped observation for
   Alibaba Model Studio's OpenAI-compatible surfaces. It folds Codex's rung
   onto the family's documented ladder (Qwen3.8 `none`/`low`/`medium`/`xhigh`,
   GLM-5.3 `low`/`high`/`max`, DeepSeek V4.x `none`/`high`/`max`, with the
   dated `0731`/`0813` snapshots keeping `low`), writes the nested spelling
   on `/responses` and the flat one on `/chat/completions`, maps Codex's
   `minimal` onto DashScope's `none` — Codex has no thinking-off rung of its
   own — and downgrades the forced tool choice the Qwen3.8 family refuses in
   thinking mode on both surfaces.
7. Run `./bin/model-router codex doctor`. A live `bin/test-model` request uses
   provider quota, so run it only with the user's approval. Finally, tell the
   user to fully quit and reopen Codex before checking the picker.

If the provider itself is unknown to the registry, stop treating the request as
installation. It is repository development and requires the process below.
