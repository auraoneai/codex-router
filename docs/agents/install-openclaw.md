# OpenClaw target

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## OpenClaw outcome

Install OpenClaw when it is missing, publish every selected and credentialed
routed model under one router-owned `codex-router` provider, preserve all other
OpenClaw configuration, and leave the next agent run to read the new route.

1. OpenClaw's current releases require Node 22.22.3+, 24.15+, 25.9+, or 26+;
   Node 23 is unsupported. The target installer must refuse an unsupported
   runtime before invoking npm. With npm 11.16+ or 12+, install the official
   package as `npm install -g openclaw@latest --allow-scripts=openclaw`; older
   npm 11 releases omit the scoped lifecycle flag they do not understand.
2. Run `./install.sh --target openclaw --auto --providers IDS` on macOS/Linux
   or `./install.ps1 -Target openclaw -Auto -Providers IDS` on Windows. The
   Control Center Harness action calls the same install-if-missing and publish
   sequence. Do not start onboarding, a gateway, or an agent as a setup side
   effect.
3. Own exactly `models.providers.codex-router`. Write it through `openclaw
   config patch --stdin --replace-path models.providers.codex-router`; never
   put the caller capability in argv, logs, or status output. Refuse a
   pre-existing provider with that id when no router publication marker proves
   ownership, or when its base URL is not a managed loopback caller URL.
4. Publish router slugs as `codex-router/SLUG` over `openai-responses`, with
   each model's context window, input modalities, and exact supported reasoning
   efforts. If no OpenClaw default exists on the first publish, set the
   highest-priority route and record ownership. Preserve any existing default,
   stop owning a default the user changes, and remove it on uninstall only
   while it still equals the router-owned value.
5. The caller URL and API key are local capabilities and make both the
   OpenClaw config and `openclaw-models.json` private state. Caller-key rotation
   must republish OpenClaw inside the same transaction as other credentialed
   clients. Status, doctor, errors, and support material must redact the URL.
6. Run `bin/model-router openclaw doctor`. OpenClaw routing config, CLI,
   config privacy, catalog freshness, caller capability, service, router
   health, and selected credentials must be `OK`.
7. AgentHarnessV2 is OpenClaw's native runtime-plugin boundary, not another
   HTTP provider protocol. A normal Responses endpoint belongs in the provider
   catalog and uses OpenClaw's embedded runtime when no native plugin claims
   it. Do not register a harness plugin or describe this integration as a
   native V2 harness. No restart is needed; tell the user to run `openclaw`.
