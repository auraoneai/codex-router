# Model Router installation instructions

This file is the canonical instruction index for Codex and Claude-based agents.
It holds the rules that apply to all work in this repository. Every other
instruction lives, verbatim, in a topic file under `docs/agents/`. Before acting
on a task, find every line under "Topic files" whose condition matches the task
and read each linked file in full: that file is **mandatory reading** for that
task, not background. When a task matches several lines, read all of them. When
unsure whether a line applies, read the file. Instructions cross-reference each
other by section title; `docs/agents/SECTION-MAP.md` maps every title to its
file.

## Repository maintenance workflow

- Use `$repo-maintainer` for incoming-change adoption decisions and consequential
  maintenance that can cross modules, clients, operating systems, installers,
  providers, credentials, protocols, generated artifacts, or release surfaces.
- Use its impact analysis and risk-proportional verification before calling such
  work complete. Skip it for factual replies and obviously isolated trivial
  edits.

These instructions apply when a user asks an agent to install this repository.

## Choose the target

- `codex` (the Codex CLI and desktop app), `dsh` (DeepSeek Harness), `gemini`
  (Gemini CLI), `cursor` (Cursor Agent plus Cursor App), and `claude` (Claude
  Code through the router-owned launcher), and `openclaw` (OpenClaw through a
  router-owned Responses provider) are supported
  targets. OpenCode is not a `MODEL_ROUTER_TARGET`: it is both a provider and
  one of the five *published-into* clients described under "Five clients,
  one publisher, one key each" below, which `control client-setup` writes a
  custom provider into rather than installing a target for. A published-into client never gets its
  own service, state directory, or credential store.
- Cursor is asymmetric: Cursor Agent uses the router's authenticated loopback
  Connect adapter, while retail Cursor App sends BYOK traffic through Cursor's
  servers and therefore needs an explicit stable public HTTPS tunnel to the
  router's separately keyed, app-only edge on port 4214. Never expose the main
  caller capability or the router port itself to the public Internet.
- **A target is a client, not a router.** One installation serves all of them:
  one background service, one gateway, one set of provider credentials, one
  provider selection, one set of ports. `MODEL_ROUTER_TARGET` selects which
  client's configuration a command writes. It must never fork the state
  directory, the service, or the credential store — a user who installs two
  would otherwise be asked for every API key twice and would run two gateways
  against one set of provider quotas. `ROUTER_PLANE_TARGET` in
  `src/paths.mjs` names that shared plane, and the environment aliases and the
  `/health` service name are keyed on it rather than on the client.
- Installing more than one is normal and needs no special handling: run the
  install once per target. Whichever ones are already present are republished
  whenever the routable set changes, so the clients cannot drift apart.

## Topic files

Client targets (installing, publishing, repairing, or uninstalling a client):

- Installing, updating, repairing, or diagnosing the `codex` target, or any other target (the DeepSeek Harness, Gemini CLI, and Cursor procedures reuse its steps 1-6), or storing provider credentials during setup → read docs/agents/install-codex.md in full before acting
- Installing, publishing into, repairing, or uninstalling DeepSeek Harness (`dsh`), including `control harness setup`/`status`/`disconnect` and the `dsh web` UI → read docs/agents/install-deepseek-harness.md in full before acting
- Installing or changing the Gemini CLI target, `~/.gemini/.env` publishing, or the Gemini surface (`gemini-surface.mjs`) → read docs/agents/install-gemini-cli.md in full before acting
- Installing or changing the Cursor target (Cursor Agent, Cursor App, the port-4214 public edge, or the Connect adapter), or adding any CLI-backed provider → read docs/agents/install-cursor.md in full before acting
- Installing or changing the Claude Code target, the `claude-router` launcher, or the Anthropic Messages surface → read docs/agents/install-claude-code.md in full before acting
- Installing or changing the OpenClaw target → read docs/agents/install-openclaw.md in full before acting
- Publishing into opencode, pi, omp, Command Code, or Hermes Agent (`control client-setup`/`client-disconnect`/`client-update`, `src/routed-harness-*.mjs`), or adding another published-into client → read docs/agents/published-clients.md in full before acting
- Native GPT models for clients without their own ChatGPT login (`chatgpt-session`, `src/codex-native-session.mjs`), or handling of unrouted `provider/model` slugs (`src/unrouted-model.mjs`) → read docs/agents/native-gpt-session.md in full before acting

Models and providers:

- Adding or curating a model for the current user only (`bin/curate-models`, `user-models.json`, `providers enable`) → read docs/agents/models-add-for-current-user.md in full before acting
- Shipping a model or a new provider to every installer (the checked-in `config/` registry), or republishing a native model at another context window → read docs/agents/models-ship-to-every-installer.md in full before acting
- Subagent capability, `multiAgentVersion`, `multi-agent-proofs.json`, `v2_agent/`, `control subagents`, the encrypted collaboration relay, or tests that isolate the state directory → read docs/agents/subagents.md in full before acting
- Anonymous providers (`opencode-free`, `kilo-free`), the `custom` per-model-endpoint container, or the keyless `local` provider → read docs/agents/providers-anonymous-custom-local.md in full before acting
- OpenCode Go GLM-5.3-Flash (formerly Ox Alpha) or Union Alpha routes, any GLM-5.3 or GLM-5.3-Flash route on any provider, or their compaction thresholds and effort ladders → read docs/agents/opencode-go-glm-and-union-alpha.md in full before acting
- The `/v1/embeddings` route or any new non-chat endpoint → read docs/agents/embeddings.md in full before acting
- The `devin-cli` provider (Cascade, `src/devin-*.mjs`, `bin/devin-probe`) → read docs/agents/provider-devin-cli.md in full before acting
- The Command Code provider (`commandcode`, `commandcode-messages`, `/alpha/generate`, `src/commandcode-*.mjs`) → read docs/agents/provider-commandcode.md in full before acting
- The vision bridge (image transcription for text-only models, `vision-bridge` commands, `src/vision-*.mjs`, local vision models) → read docs/agents/vision-bridge.md in full before acting

Service, gateway, and dependencies:

- Python/LiteLLM dependency pins or `requirements/` (`bin/lock-python`, `.github/workflows/python-lock.yml`) → read docs/agents/python-gateway-lock.md in full before acting
- Service start/stop, foreground startup, proxy environment restore, gateway supervision/restarts, `/health` degradation, spawning external commands in `start.mjs`, or the Z.ai/LiteLLM stream fixes → read docs/agents/service-and-gateway-lifecycle.md in full before acting

Request path and stream handling:

- Native upstream retries (`src/upstream-retry.mjs`) or model failover and cooldowns (`src/model-failover.mjs`, `buildRoutedRequest`) → read docs/agents/retries-and-failover.md in full before acting
- Invalid or unparseable function_call arguments, or tool calls a model writes as text (Hy4 nonce markup, `src/leaked-tool-call-recovery.mjs`) → read docs/agents/stream-tool-call-integrity.md in full before acting
- LiteLLM's echoed stream prelude and per-frame pre-commit budgets, or Grok stream timeouts and heartbeats → read docs/agents/stream-frame-bounds-and-keepalive.md in full before acting
- DeepSeek Responses/Chat reasoning replay, Chat Completions reasoning-summary lifecycle repair, or assistant message `phase` labels → read docs/agents/stream-reasoning-and-phase.md in full before acting
- Substituting or estimating prompt-token counts (`src/response-usage.mjs`) → read docs/agents/prompt-token-substitution.md in full before acting

Codex client surfaces and the macOS tray:

- The opt-in `codex` PATH shim (`src/codex-shim.mjs`) → read docs/agents/codex-shim.md in full before acting
- Tray visibility and follow mode, Codex process detection, presence mode (`src/presence-state.mjs`), or the macOS app icon → read docs/agents/macos-tray-and-presence.md in full before acting

Changing any file under `docs/agents/` follows the same rule as changing this
index: move or edit instructions in one place only, and keep this index's
conditions and `docs/agents/SECTION-MAP.md` accurate.

## Requests to install or expose more models

First distinguish a local model addition from a repository-wide model change.
Prefer local curation when one user wants a model that an already registered
provider advertises. Change the checked-in registry only when the user intends
to ship tested support to every installer.

- Only the current user wants the model → read docs/agents/models-add-for-current-user.md in full before acting
- Tested support for every installer → read docs/agents/models-ship-to-every-installer.md in full before acting
- Any subagent claim for the model → read docs/agents/subagents.md in full before acting

## Codex safety boundaries

- The config manager owns its marked root `openai_base_url` and
  `model_catalog_json` block plus its marked `model_providers.codex-router`
  table and, when the user has no concurrency preference, its marked
  `[agents].max_concurrent_threads_per_session` default. It may change the root
  `model_provider` only when the user explicitly enables either login-free mode
  or signed routing from a root-OpenAI configuration. Signed routing selects
  the dedicated, ChatGPT-authenticated `codex-router-signed` provider; ordinary
  install, update, repair, and catalog refresh must never create or migrate that
  switch implicitly. Keep its state readable by the previous release and
  restore the prior provider exactly when it is disabled. Login-free mode may
  also select an enabled external `model`; snapshot both previous values in
  protected router state and restore them exactly when the mode is disabled.
- Preserve reasoning settings, profiles, projects, trust, MCP configuration,
  features, and ChatGPT authentication. Preserve `model` and `model_provider`
  outside those explicitly enabled routing modes.
- A user-initiated macOS tray login-mode change may gracefully restart only the
  registered Codex desktop app. This does not authorize an installation task to
  quit Codex, and the tray must never force-terminate it.
- Do not kill unknown processes on ports 4200-4203, or on the Grok OAuth
  forwarder port 4208. The previous 4100-4103/4108 defaults remain valid only
  when explicitly supplied through the port environment variables.
- Do not print or read credential-file contents. Status commands report presence
  and source only.
- Treat the generated `/_codex-router/.../v1` config path as sensitive local
  authentication. Never paste the complete managed base URL into chat or a
  public issue; use the redacted status or support-bundle output.
- Do not delete retained keys, logs, backups, snapshots, or old state
  directories.
- Do not restart or quit the Codex App from the installation task.

## Discovery-disabled means no credential reader touches anything

An install made with `--no-provider --no-discovery` persists a discovery
kill-switch (`discovery-mode.json`, read through
`src/discovery-mode.mjs` `discoveryDisabled()`, overridable with
`CODEX_ROUTER_NO_DISCOVERY=1|0`). While it is set, the promise is absolute:
no provider credential file, macOS Keychain item, other CLI's OAuth or
session file, Codex `auth.json`, or Claude account pool
(`CLAUDE_ACCOUNT_POOL_PATH`, `claude-accounts/`) is read, no `codex login status` probe
runs against the real `CODEX_HOME`, and traffic gets a local
`503 router_idle_no_provider` instead of provider or native forwarding.

1. Every new credential reader, sign-in probe, or session consumer must
   consult `discoveryDisabled()` before its first read or spawn and report
   "nothing found" rather than throwing. The guard belongs at the reader, not
   only at its current callers — call graphs move.
2. An explicitly written empty provider selection is a deliberate state, not
   an error: `ensure-configured` reports it as idle, the doctor warns instead
   of failing, and installing or updating on top of it must keep working.
3. Never select a provider, re-enable discovery, or clear the marker on the
   user's behalf. Re-running setup without the flags is the only exit path,
   and it is the operator's to take.
4. The account-aware `codex debug models` (and `models_cache.json`, which is
   that same catalog written to disk) counts as an account read: the catalog
   capture and the doctor's staleness probe use only `debug models --bundled`
   while the switch is set. `test/doctor-idle.test.mjs` proves the bare form
   never spawns.
5. A corrupt `discovery-mode.json` deliberately reads as discovery **on** —
   the opposite direction of the vision-bridge precedent, which fails toward
   off. There the risk is spending quota nobody approved; here the marker
   only ever exists on a machine that installed with `--no-provider`, where
   resuming reads finds no credentials to spend, while failing toward "off"
   on a credentialed install would silently blind every provider over one
   damaged file. `test/discovery-mode.test.mjs` pins the choice.

## Generated media and scratch output

- Anything a skill, tool, or agent produces that is not source — rendered
  video, images, audio, benchmark dumps, one-off reports — belongs in
  `generated/` at the repository root. That directory is gitignored, so the
  working tree stays clean and nothing large lands in a commit by accident.
- Do not add per-extension ignore rules (`*.mp4`, `*.png`) for this. They also
  hide checked-in assets such as tray icons and documentation screenshots.
- Files that are meant to ship — icons, fixtures, docs assets — go in their
  real home under version control, not in `generated/`.

## Where each moved section lives

When an instruction cross-references a section by title, find its file in
`docs/agents/SECTION-MAP.md`.
