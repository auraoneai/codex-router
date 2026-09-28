# Codex target: install procedure

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Codex outcome

Install Codex Router for the current user, preserve every unrelated Codex
setting and ChatGPT authentication artifact, expose only the external providers
the user wants, verify the integration, and leave the final Codex restart to the
user.

## Codex procedure

1. Read the host platform and check for Codex, Git, Node.js 22.19+, and `uv` or
   Python 3.10+. On Windows, also verify that Windows PowerShell reports
   `FullLanguage` and permits `Add-Type`; the process-tree safety boundary fails
   closed before mutation under Constrained Language, AppLocker, or WDAC.
   Read-only checks are allowed. Do not install a package manager or system
   runtime without the user's permission.
2. Use a stable checkout: `~/.local/share/codex-router` on macOS/Linux, or
   `%LOCALAPPDATA%\codex-router` on Windows. Do not install the service from a
   temporary clone.
3. Never ask the user to paste OAuth tokens or API keys into chat, command
   arguments, logs, environment snippets, or tracked files.
4. Determine which provider IDs the user requested: `anthropic-api`,
    `kimi-oauth`, `antigravity-oauth`, `kimi-api`, `kimi-api-cn`, `deepseek`, `grok-oauth`, `grok-api`, `qwen-plan`,
    `zai-coding`, `ollama-cloud`, `minimax-token-plan`, `meta`, `clinepass`,
    `venice`, `nousresearch`, and/or
   `opencode-go`
   (shown to users as "opencode Go/Zen"; its `opencode-go-messages`,
   `opencode-go-responses`, `opencode-zen`, `opencode-zen-messages`, and
   `opencode-zen-responses` variants share its stored key
   and are enabled and disabled with it automatically; never select or toggle
   them separately. Zen ships no preselected models — curate them per user
   with `bin/curate-models opencode-zen`; Claude lands on Messages and
   GPT/Grok/Muse on Responses), and/or `commandcode`
   (shown to users as "Command Code"; its `commandcode-messages` variant
   shares its stored key and is enabled and disabled with it automatically;
   never select or toggle it separately. Command Code uses its stored or
   environment API key; it has no router-managed CLI sign-in path. The
   catalog-only providers `groq`, `together`, `fireworks`,
   `cerebras`, `mistral`, `nvidia-nim`, `siliconflow`, `huggingface`,
   `github-copilot`, `chutes`, `orca`, and `vertex` are also selectable, but they ship no
   preselected models: after
   the credential is stored, the user must run `bin/curate-models PROVIDER` in an
   interactive terminal to choose models. Vertex uses Application Default
   Credentials from `gcloud auth application-default login` plus
   `./bin/control vertex set PROJECT_ID LOCATION` rather than an API key, and
   it is never selected by `defaultProviderIds()`. If they did not specify and
   credentials already exist, use
   `configured` rather than showing providers that cannot authenticate.
   `gemini-api` ships the reviewed direct `models/gemini-3.8-flash` route;
   additional Google models still require `bin/curate-models gemini-api`.
   `openrouter`, `venice`, and `nousresearch` also ship live-reviewed checked-in
   presets, so their picker is not empty after the key is stored; anything else
   on their current account catalogs still has to be curated.
   `venice` and `nousresearch` are ordinary API-key providers — Venice keys come
   from venice.ai/settings/api and Nous Portal keys from
   portal.nousresearch.com; neither has a router-managed CLI sign-in path, and
   Venice carries a `planNote` because a free Venice account has no API
   entitlement at all.
   The anonymous providers `opencode-free` and `kilo-free` are also selectable
   (`opencode-free-responses` is an internal, single-model protocol variant of
   the former and is never selected or curated separately),
   but they need no credential only for their documented free model subsets.
   `kilo-free` and `opencode-free` are catalog-only and need
   `bin/curate-models PROVIDER` after selection. `custom` is selectable on the
   same terms and is a container whose models each name their own endpoint, so
   enabling it asks for nothing and curating it is unnecessary. All three must
   be selected explicitly; never select one on the user's behalf just because
   it can authenticate without a key.
   `kimi-api` and `kimi-api-cn` are two different Moonshot platforms, not a
   fallback pair: the global console at platform.moonshot.ai and the mainland
   one at platform.moonshot.cn have separate accounts, separate billing, and
   keys that each host rejects from the other. Ask which platform the user's
   key came from rather than defaulting, and never copy a stored key between
   the two.
5. For Kimi OAuth, reuse a valid `kimi login` session. If login is needed, run
   the official CLI only in an interactive terminal. For API providers, invoke
   `bin/model-router codex provider-key PROVIDER set` in a PTY so the hidden
   prompt receives the value directly; do not relay it through chat. GitHub
   Copilot requires a fine-grained PAT with the Copilot Requests permission;
   never read or copy the official Copilot CLI credential store. Command
   Command Code is API-key-only: invoke `bin/model-router codex provider-key
    commandcode set` in a PTY so the hidden prompt receives the value directly.
   For Antigravity OAuth, never read or reuse the official `agy`/IDE credential
   store and never use the vendor's OAuth client or identity. Require one
   coherent operator-owned Google OAuth client ID and secret pair: the operator
   must create a Google OAuth **Desktop app** client they own. **The Google
   Cloud project behind that OAuth client must be allowlisted for
   `cloudcode-pa.googleapis.com`, a private Google API.** Most projects are not
   allowlisted, and operators cannot enable this API themselves: it requires
   the producer-side `servicemanagement.services.bind` permission.
   Run `bin/model-router codex providers login antigravity-oauth`; the router
   first binds `127.0.0.1` on an OS-assigned port, then opens a loopback-only
   setup page where the client ID and matching secret are submitted without
   entering shell history. Open only the local URL through the OS browser
   command and redirect to Google inside that listener, so neither client value
   reaches argv or terminal logs. The coherent pair and resulting tokens are
   stored together in the router's owner-only credential file and used for
   refresh on macOS, Linux, and Windows; they never belong in a service
   environment. Sign-in does not call the private Antigravity service or enable
   the route. Run the explicitly quota-consuming
   `providers probe antigravity-oauth --live --yes` next; add
   `--provision-project` only when the operator separately authorizes creation
   of a Google Cloud project. The live probe will fail with `SERVICE_DISABLED`
   if the OAuth client's project is not allowlisted. Provisioning still
   requires a successful, schema-valid bootstrap response that explicitly
   advertises the selected tier; auth errors, server errors, malformed
   responses, and missing tiers fail closed. The probe identifies itself
   truthfully as Codex Router, and only a successful proof makes the provider
   enableable. The Antigravity forwarder is not spawned or health-gated before
   that proof, so an unused provider port cannot fail the whole router. A
   passing probe records a generation-bound `pending_activation` that every
   configured and publication reader rejects. Startup alone may boot its exact
   pending proof; only after the whole local stack is healthy does it
   atomically promote that generation active. A failed restart, an early
   process death, a credential replacement, or a disconnect leaves it
   nonpublishable. The probe restarts an installed service through that
   sequence, and a foreground operator must restart that process before
   enabling the provider. A v2 proof record with no activation metadata is not
   grandfathered: it was written by the unsafe pre-readiness path and must pass
   the explicit live probe again. If Google accepts only an impersonated vendor
   client, leave it disabled. If the project is not allowlisted, this provider
   cannot currently be used.
   A key does not mean every account may use the Provider API: the Go plan is
   refused with "Your Go plan doesn't include API access". GOAT, Pro, Max, Team,
   and Provider plans do have API access and meter against their own credits.
   Say so rather than re-running setup, which cannot change an entitlement.
   Never ask for the key in chat or place it in command
   arguments, logs, environment snippets, or tracked files.
6. Run read-only legacy detection. It is safe to pass `--migrate-known` when the
   detector identifies a repository-recognized older Codex Router: migration is
   scoped, snapshotted, and reversible. Never migrate, stop, delete, or replace
   an unknown router automatically.
7. On macOS/Linux, run
   `./install.sh --target codex --auto --providers IDS --migrate-known` from the
   stable checkout. On Windows, run
   `./install.ps1 -Target codex -Auto -Providers IDS -MigrateKnown`. Omit the
   migration flag when detection found nothing. Do not enable the smoke test
   unless the user agrees to a quota-consuming request.
8. Run `bin/model-router codex doctor` (or
   `./model-router.ps1 codex doctor` on Windows). Core config, config privacy,
   catalog, caller capability, internal key, service, router health, and
   selected credentials must be `OK`. Unselected credentials may be `WARN`.
9. If a managed layer fails, use `model-router codex doctor --fix`; add
   `--migrate-known` only for a recognized older installation. Repair rebuilds
   the Node and Python dependencies unconditionally, unlike a normal install or
   update, which skips whichever dependency step already matches its
   fingerprint. Force that rebuild by hand with `bin/install --force-deps`
   (`./install.ps1 -CheckoutInstall -ForceDeps`) when an environment looks
   corrupted rather than merely out of date. If repair still fails, create
   `bin/support-bundle` and report its path without uploading it.
10. Do not terminate Codex. Tell the user to fully quit it, reopen it, create a
    new task, and choose the new model.
