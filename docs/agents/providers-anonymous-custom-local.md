# Anonymous, per-model-endpoint (`custom`), and local providers

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Anonymous remote providers

`authMode: "anonymous"` is not the same as `keyless`. A keyless provider is
loopback-only and serves from this machine; an anonymous provider sends the
operator's prompt to a fixed remote endpoint under a provider-controlled free
model policy. It must never declare a credential, keyless mode, or a base-URL
override, and the registry loader keeps its endpoint allowlisted.

Anonymous providers are **configured but never defaulted**: the credential
resolver may report them as ready, and an explicit `--providers` choice may
route a free model, but `defaultProviderIds()`, the no-argument setup path,
`--providers configured`, and `ensure-configured` must not add them when the
operator did not ask. Never check in a paid model ID or silently turn on an
anonymous endpoint during installation.

Which free IDs a reseller gateway serves is decided by `anonymousModelAllowed`
in `src/model-registry.mjs`, never by the registry fragment alone, and the
`ANONYMOUS_ENDPOINTS` table beside it is the reason a fragment edit cannot
point a credential-free provider at a model somebody would be billed for.
`opencode-free` and `kilo-free` each expose a large free subset picked out by a
naming rule that changes without notice, so neither ships that subset: discovery
filters the provider's live `/models` response and the user curates locally.

## A provider whose models each name their own endpoint

`custom` is a **container, not a destination**. It declares no `baseUrl`, no
`credential`, and no `protocol`; each of its models carries all three in an
`endpoint` block, and `endpointForModel()` is what every consumer asks instead
of reading `provider.baseUrl`. The loader refuses a container that declares any
of them, because two answers to "where does this go" have a silent winner.

1. **The endpoint descriptor is provider-shaped on purpose.** `baseUrl`,
   `authMode`, `keyless`, and `credential` mean exactly what they mean on a
   provider, so `resolveProviderBaseUrl` and the whole credential chain accept
   one unchanged. Do not grow a parallel resolver: the moment the two
   implementations differ, one of them is the one nobody audited.
2. **Identity is derived, never declared.** `id` is the model slug and `kind`
   is fixed, both injected at load; a fragment that set either could point one
   model's credential file and Keychain entry at another model's secret. The
   loader refuses a fragment that spells them.
3. **Exactly one auth story per endpoint** — anonymous, keyless, or a
   credential. Two would leave a silent winner; none would send an
   unauthenticated request to an address nobody vetted.
4. **The allowlist follows the address down.** An `authMode: "anonymous"`
   endpoint reaches a third party with no credential, so its address must
   appear in `ANONYMOUS_MODEL_ENDPOINTS`, keyed by slug. Without that, adding a
   JSON file under `config/custom/` would be enough to send an operator's
   prompts to any HTTPS host on earth with nothing to authenticate them — which
   is the exact hazard the provider-level allowlist exists to prevent, one level
   down. A `keyless` endpoint stays loopback-only for the same reason, and
   neither may declare a `baseUrlEnv`, because an environment override walks
   around whichever of the two rules applied. An endpoint that carries a
   credential needs no allowlist entry: the key is already the boundary.
5. **Never defaulted.** `defaultProviderIds()` excludes `per-model` alongside
   `anonymous`. What the container holds is whatever somebody put in it, and at
   least one of those addresses is reached with no credential, so "enabling this
   sends prompts off-box" stays a choice a person made.
6. **Nothing offers a key at the container level.** `apiProvider()` refuses it,
   the onboarding card is informational, and `resolveProviderCredential()`
   returns a persistent marker so selection, health, and the catalog still work.
   A key stored against `custom` would be read by nothing.
7. **Discovery refuses it.** Discovery asks one endpoint what it serves, and a
   container is not an endpoint. Picking one of its models' addresses and
   reporting that as the provider's catalog would be worse than the refusal.
8. **Check in metadata you measured.** A `custom` model ships with a verified
   context window, modality set, and effort ladder rather than the conservative
   defaults `curate-models` would guess. An anonymous endpoint answers without a
   credential, so there is no excuse for inferring any of it.

## Local models as a provider

`local` is a keyless provider: it serves from this machine, so there is no
credential to store, prompt for, or redact.

Local models are published as **experimental**, and the two roles are not
equally proven. Reading images is dependable: a local vision model transcribes
codes, numbers, and dates exactly, every run. Driving a Codex turn is not: the
same model has passed `local-models agent-check` and failed the identical check
minutes later. Do not quietly drop the label because a check happened to pass.

1. `keyless: true` is only valid with a loopback `baseUrl` and no `credential`
   block; the loader rejects both violations. An unauthenticated provider
   pointed at the internet would send traffic off-box with no key.
2. Checked local models are published into the user-model overlay, the same
   mechanism curated cloud models use. Do not add a second registry path for
   them, and never write local models into the checked-in `config/` tree --
   they exist only on the machine that installed them.
3. A change to the checked set must rewrite **both** the Codex catalog and the
   gateway route table (`refreshModelSettingsCatalog({ routes: true })`).
   Writing one without the other is the drift doctor's "Catalog matches gateway
   routes" check exists to catch.
4. Checking, installing, and removing are three separate actions. Unchecking
   never deletes a download; removing requires explicit consent and unchecks
   the model so nothing stays selected once it is off disk.
5. A local model advertises image input only when its family can actually read
   images -- the same standard the checked-in registry is held to.
6. Codex drives every turn through tool calls, so a local model is publishable
   only when Ollama reports the `tools` capability. Most vision models do not
   have it. `local-models inspect <tag>` reads the registry's chat template to
   answer that before a download, but a template mentioning `.Tools` is
   necessary and not sufficient -- `qwen2.5-coder:7b` advertises tools and
   still returns them as plain JSON text, which Codex cannot dispatch. Treat
   the flag as a filter and a real request as the proof.
7. New providers only reach a running router after the service restarts, since
   the registry and gateway config load at startup. If the router starts
   answering every request with `local_router_error`, suspect a process still
   holding pre-change state rather than the new code.
