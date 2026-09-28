# Shipping models and providers to every installer

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Ship a model to every installer

1. Run `./bin/discover-models PROVIDER`; discovery is read-only. Confirm the
   model ID and capabilities against the provider's current official
   documentation. Never infer tools, images, context size, reasoning, or billing
   behavior from the model name.
2. Add the model declaratively to the vendor's registry fragment (the
   `config/<vendor>/<method>/models.json` file for its provider; a new
   provider also needs its definition in `config/<vendor>/<vendor>.json`)
   with unique `slug`,
   `gatewayModel`, and provider/upstream IDs; complete picker metadata;
   supported reasoning levels; input modalities; context/compaction limits;
   and the correct request profile. Use `listed: false` for compatibility-only
   aliases. An optional `availabilityNux` string ships announcement copy that
   Codex renders as its "Introducing {model}" card the first few launches
   after the model appears; reserve it for a genuinely new flagship, because
   every installer will see it. Checked-in models that newly become routable
   (added by an update, or unlocked when the operator credentials and enables
   their provider) also announce automatically for seven days with copy
   assembled from their verified picker metadata (context window, effort
   ladder, image support) — tracked in the protected
   `announced-models.json` state; the first catalog capture seeds that state
   silently, curated `availabilityNux` copy wins over the generated text, and
   locally curated user models never self-announce. In the CLI TUI this renders as a startup tip
   line; the full-screen prompt is instead driven by an optional `upgradeTo`
   object (`{ "model": "target/slug", "markdown": "..." }`) on the model the
   operator currently runs: Codex renders the markdown as the entire
   "Codex just got an upgrade" modal (with `{model_from}`/`{model_to}`
   placeholders), and accepting switches the operator's default model to the
   target, so ship one only for a genuine successor.
3. A new provider also needs credential isolation, discovery metadata,
   selection/onboarding support, request translation, health behavior, and
   tests. Never place an API key or OAuth artifact in the registry. A new
   provider is not done until the whole checklist in
   "Ship a new provider to every installer" below passes.
4. Set `multiAgentVersion: "v2"` only after the model is proven through native
   Codex collaboration: tool calls work, encrypted subagent payload relay works
   without disclosure, a marker-return spawn succeeds, and a same-thread
   follow-up succeeds. Otherwise omit it and retain conservative v1 behavior.
   The registry is not the only way a route reaches v2. The operator's own
   selection promotes it — `subagents mode selected` plus `subagents set <slug>
   on`, or `mode all` — and so does a completed local verification of all five
   checks recorded in `multi-agent-proofs.json`. Selection is the ordinary path
   and the one the Control Center switch uses; the registry exists so nobody
   has to select a proven route by hand. None of this loosens the gate: an
   explicit `off` beats every mode, a hidden model is never promoted, a partial
   verification or a mismatched slug promotes nothing, the legacy diagnostic
   statuses promote nothing, and only the pull request that moves the registry
   entry may accept a `v2_agent/` application. Read
   `docs/SUBAGENT-CERTIFICATION.md` in full before changing
   `src/subagent-*.mjs`, `src/multi-agent-state.mjs`, `v2_agent/`, or the
   Subagents column — it records which questions have already been answered at
   the cost of provider quota.
5. Remember that Codex advertises only a small priority-ordered subset of native
   spawn-model overrides. Adjust priority intentionally and keep the desired
   Kimi/Grok/GPT choices in that visible subset; do not crowd them out
   accidentally when adding a model. The published catalog carries two
   numberings for exactly this reason (`publishedPickerPriorities` in
   `src/catalog.mjs`): a certified v2 route keeps its authored priority so it
   stays inside that window, while every v1 routed model is published in a
   band above the highest visible native priority so the picker shows vendor
   groups instead of interleaving routed entries among native GPT models
   (issue #544). Only the published entry is renumbered; failover, the vision
   bridge, and the other clients keep reading the registry value.
6. Add registry, catalog, routing/request-profile, and failure-path regression
   tests. Run `npm run check` and `npm test`. With explicit quota approval, run
   `./bin/test-model 'provider/model' --live --yes`, reinstall, fully restart
   Codex, and perform the native subagent probe before claiming support.

## Republish a native model at a different context window

`src/native-context-variants.mjs` publishes a native GPT model under a second
slug carrying a different context window — `gpt-5.6-sol-1m` is the first. It is
not a new model and never becomes one: the entry is copied wholesale from the
capture, the router translates the slug back to its base on the way out, and
the only fields overridden are the slug, the display name, the description, and
the window/compaction pair.

1. The window is read from the provider's current official documentation, the
   same rule as any other model. Never raise one because a request happened to
   be accepted, and never guess from the family name. `bin/doctor` reports
   windows a provider has already disproved; that check does not authorize the
   opposite direction.
2. A variant ships hidden. `seedModelsHidden` applies that default exactly once
   per slug, so it can never re-apply itself over an operator's choice — which
   is why `model-picker.json` records `seeded` alongside `hidden`, and why
   every writer in `src/model-picker-state.mjs` must preserve it. A variant
   that costs more per turn than the model it shadows must never arrive
   switched on in an update.
3. Derive only from a base the capture actually shipped as `visibility: "list"`,
   and never in a login-free install: signed-out Codex surfaces display native
   slugs from a server-supplied allowlist, so a synthesized slug would consume
   an alias slot and then be invisible.
4. Every surface that enumerates the OpenAI group goes through
   `withNativeContextVariants` — the catalog build, the tray probe, and the
   group's Show all / Hide all. A surface that reads `native-models.json`
   directly will silently omit variants. Published clients
   (`src/routed-client-models.mjs`, serving DeepSeek Harness and Gemini CLI)
   are deliberately not among them: they read the capture and do not apply the
   picker's hidden set to native models, so a variant would arrive switched on
   in a surface that has no switch. Publishing one there means fixing that
   first.
5. Cover the derivation, the slug translation on a live native turn, the
   hidden-by-default seeding, and the survival of an explicit choice across a
   rebuild. `test/native-context-variants.test.mjs` is the existing shape.

## Ship a new provider to every installer

A new provider is only complete when all of the following are true. Do not
land a provider that satisfies routing but skips the tray, install, or usage
surfaces.

1. **One-click install.** The provider ID must work end to end with no manual
   config edits: selectable through `install.sh --providers` /
   `install.ps1 -Providers`, through
   `bin/model-router codex providers enable PROVIDER`, and reported correctly
   by `bin/model-router codex doctor`. If the provider ships no preselected
   models, document it as catalog-only and make sure `bin/curate-models`
   handles it.
2. **Tray setup section.** Every provider must appear in the macOS tray with a
   working setup card driven by `src/provider-onboarding.mjs` and the control
   commands the tray invokes:
   - API-key providers get the hidden credential path (tray →
     `control credential PROVIDER` over stdin → `saveApiCredential`). The key
     must never transit chat, logs, or command arguments.
   - OAuth providers additionally get the OAuth section: an `OAUTH_CLIS`
     entry in `src/provider-onboarding.mjs` (executable, npm package, login
     arguments) so the tray's `install-cli PROVIDER` and `login PROVIDER`
     buttons work, plus status,
     session-refresh, and reconnect-on-expiry wiring in the provider's OAuth
     status/session modules (follow `kimi-oauth-*` / `grok-oauth-*` as the
     patterns).
   - Connecting is always one click. Any tray sign-in button installs the
     official CLI when it is missing and then runs the login in the same
     operation (`connectProvider` in the tray), rather than stopping after the
     install and waiting for a second click. Label the button for everything
     it will do (`Install & Sign In`) so the single click stays honest. This
     is the house rule for every provider, OAuth or CLI-session: implement it
     without asking.
   - Add the provider icon under
     `apps/macos/ModelRouterTray/Resources/` and record its source in
     `PROVIDER-ICON-SOURCES.md`.
3. **Plan entitlement.** When a provider's credential can authenticate an
   account whose plan still may not call the API, set `planNote` on its
   registry entry. `providers enable`, `doctor`, and the tray all print it, so
   the requirement is visible where someone connects instead of arriving as a
   403 inside Codex. Command Code is the case: every plan except Go is served
   through the Provider API, while Go remains CLI-only.
4. **Usage, limits, and balance in the tray.** Wire the provider's account
   endpoint into `src/provider-account-usage.mjs` so `provider-usage --json`
   returns real metrics: `quota` metrics (used/limit/remaining with reset
   time) for plan- or window-limited providers, and `balance` metrics (the
   remaining dollar or credit amount) for prepaid/pay-per-use providers. These
   feed the tray's "% left" display, usage cards, and low-remaining reminders,
   so a provider without them silently hides the user's spend. If the provider
   exposes no usage or balance API, the snapshot must degrade gracefully and
   the tray must say usage is unavailable rather than showing stale or empty
   numbers. Routed request/token accounting comes from the shared usage-events
   pipeline and needs no per-provider work beyond correct event recording.
