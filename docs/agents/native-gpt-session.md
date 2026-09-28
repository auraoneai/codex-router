# Native GPT session sharing and unrouted slugs

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Native GPT for a client with no ChatGPT login of its own

Native traffic is authorized by the caller's session: `nativeHeaders` copies
`authorization` and `chatgpt-account-id` off the incoming request, and Codex
attaches both. A harness turn attaches neither, so native models advertised to
it were models it could never spend.

`src/codex-native-session.mjs` closes that by falling back to the session this
machine is already signed in with, in `$CODEX_HOME/auth.json`, only after the
user authorizes that use once. `native-session-consent.json` is an owner-only
marker carrying no credential and belongs to the shared router plane: asking
the same OS user to sign in or authorize once per harness buys nothing.

- **Consent fails closed.** A missing, malformed, or unrecognized marker means
  off. `chatgpt-session enable` refuses until `codex login` has produced a
  usable session, then republishes every installed client; `disable` removes
  the marker and republishes them again without signing Codex out. The
  `CODEX_ROUTER_NATIVE_SESSION_FALLBACK=1` environment override is the explicit
  headless opt-in, while `0` is an emergency off switch. No other value is
  consent.

- **Fallback, never override.** Injection happens only when the request carried
  no *upstream* credential. Codex always carries one, so a Codex turn is
  byte-identical to before — verified by relaying a deliberately invalid token
  and getting that token's own 401 back rather than a success.
- **"No credential" is not "no header".** The harness authenticates to this
  router with the router's own caller key, sent as a bearer token, because a
  provider route has nowhere else to put one. Testing `!headers.authorization`
  therefore never fired for a real harness turn: the caller key went upstream
  and every turn came back "API key is invalid". Compare the presented bearer
  token against `CALLER_KEY` and `INTERNAL_KEY` and treat a match as no upstream
  credential. When there is nothing to substitute, delete the header rather than
  forward it — a router secret must never leave the machine.
- Test the shape the client actually sends. A curl with no `Authorization`
  header at all passes the naive guard and proves nothing.
- **The native endpoint accepts a narrower request than the public Responses
  API.** `store` must be `false`, `stream` must be `true`, and ten parameters a
  generic OpenAI client sends are rejected one at a time as bare 400s:
  `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `max_tokens`,
  `max_output_tokens`, `metadata`, `seed`, `user`, `truncation`. Codex complies
  already, so the payload is normalized *only* for a caller whose session was
  substituted — a Codex turn is never rewritten. `reasoning`, `tool_choice`,
  `parallel_tool_calls`, and `instructions` are accepted and must survive; the
  strip is a denylist for that reason, not a whitelist. Measure any change to
  that list against the live endpoint rather than guessing.
- **Publishable exactly while spendable.** `dshRoutedModels()` includes native
  models only while `nativeSessionAvailable()` is true, so the harness is never
  offered a model that would 401. `visibility: "hide"` entries stay unpublished:
  they are Codex's own internals, a watermarked build and the auto-review model.
- **The credential never leaves the process.** It is not logged, not returned by
  a status call, and not put in an error message. `nativeSessionStatus()` reports
  presence, usability, and age — `test/codex-native-session.test.mjs` asserts the
  serialized status contains neither the token nor the account id.
- **It widens the caller key.** With sharing authorized, anything holding that
  local key spends the ChatGPT subscription and not only the API-key providers.
  That is a deliberate, user-made tradeoff recorded once for the shared plane;
  `chatgpt-session disable` revokes it everywhere and the clients silently drop
  back to routed models only.
- **The access token lives about ten days, and Codex renews it only when Codex
  is used.** A harness-only stretch longer than that would otherwise leave the
  router sending a dead token. `nativeSessionHeaders()` reads the `exp` claim
  and declines two minutes early, so an expired session withholds the headers
  and `dshRoutedModels()` stops publishing native models — the picker loses the
  eight rather than serving certain 401s.
- **Codex refreshes its own credential; this router never does.** Reproducing
  that OAuth exchange would mean guessing an unpublished client identity and, if
  refresh tokens rotate, either rewriting Codex's own file or invalidating the
  login this router was asked not to disturb. `refreshViaCodex()` runs
  `codex login status` instead — best effort, single-flight, at most once every
  five minutes — and lets Codex decide. If nothing renews, the session simply
  reads as expired.
- `doctor` reports it as its own line, because "open Codex once" is the fix and
  nothing else would say so.

## A provider-prefixed slug is never forwarded to ChatGPT

`handleResponses` treats a model it has no route for as native GPT traffic and
forwards it to chatgpt.com. That is correct only for native slugs, and no native
slug contains a `/`: not the captured account catalog, not the context variants
in `src/native-context-variants.mjs`, not the native-alias keys or the
native-redirect sources. Every routed slug is `provider/model`.

So a slug containing `/` that resolves to no route — exact slug, migration or
curation alias, or native alias — is refused locally with HTTP 400,
`invalid_request_error`, code `unrouted_model` (`src/unrouted-model.mjs`),
before native redirect or native passthrough can take it. Issue #689 is why: a
user model added to `user-models.json` after the service started reached the
Codex picker (the catalog is rebuilt in another process) but not the live
router's `MODEL_BY_SLUG`, went to ChatGPT, and came back as "The 'vendor/model'
model is not supported when using Codex with a ChatGPT account" — which reads
as an OpenAI restriction and sent the user's prompt to OpenAI besides.

- Keep the check ahead of `readNativeRedirect()`. The redirect exists for
  Codex's background sessions on native slugs; it must not quietly serve a
  mistyped or unloaded routed model with some other model.
- The message names the slug, whether its prefix is a registered and enabled
  provider, and the reason `mergeUserModels` skipped a user model with that slug
  (`USER_MODELS_SKIPPED`), and points at `bin/control service restart` and
  `user-models.json`. It never carries a credential, caller key, base URL, or
  path. It does not probe credentials: that spawns keychain lookups.
- Client surfaces already resolve their own prefixes before re-entering this
  path — Claude strips `codex_router/anthropic/`, Cursor maps its neutral ids to
  the slug, Gemini, DeepSeek Harness, and OpenClaw send the router slug — and the
  Responses WebSocket re-enters over HTTP, so this one check covers them.
- If a native namespace with a `/` ever appears, narrow the rule to prefixes
  that are not that namespace; do not drop it.
