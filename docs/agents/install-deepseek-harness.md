# DeepSeek Harness (`dsh`) target

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## DeepSeek Harness outcome

Publish the router's routed models into DeepSeek Harness as one provider route,
preserve every other section, route, comment, and credential in the harness's
own documents, and leave the harness running — it hot-reloads, so there is
nothing to restart and nothing to tell the user to quit.

## DeepSeek Harness procedure

1. Steps 1-6 of the Codex procedure apply unchanged, except that Codex itself is
   not a prerequisite: a harness-only machine needs Node 22.19+, `uv` or Python
   3.10+, and the harness. Do not run `src/catalog.mjs` there — it asks the
   Codex CLI whether the session is signed in and refuses to publish when it
   cannot ask, which is a failure, not a fallback.
2. Run `./install.sh --target dsh --auto --providers IDS` (macOS/Linux) or
   `./install.ps1 -Target dsh -Auto -Providers IDS` (Windows).
   `--migrate-known` and `--adopt-native-catalog` are refused here: both act on
   Codex's own configuration, and the harness has no counterpart to either.
3. Run `bin/model-router dsh doctor`. "Harness routing config", "Harness caller
   credential", "Harness settings privacy", and "Harness catalog freshness"
   must be `OK`, alongside the shared-plane checks.
4. Do not tell the user to restart the harness. `dsh-settings-file` watches the
   document and publishes external edits, so the route is live on the next
   request. Saying otherwise trains people to restart for nothing.

## What the harness integration writes, and what it must never touch

The router owns exactly two keys, in two documents that belong to the harness.
Both are hot-reloaded by it, and its own Models page writes provider routes
beside ours, so everything else in them is somebody else's work.

1. **One route, not a section.** The router owns
   `llm-pi-ai.providers.codex-router` in `$DSH_HOME/settings.yaml` and
   `CODEX_ROUTER_CALLER_KEY` in `$DSH_HOME/.credentials.yaml`. It never reads,
   rewrites, or removes a sibling route, another adapter's section, or another
   credential. Publishing twice is byte-identical, and removing the route
   restores the document exactly — including the user's comments and blank
   lines. `test/dsh-config-manager.test.mjs` asserts both properties against a
   document that has work of somebody else's in every position the router
   writes near; do not weaken them.
   The credentials document comes in two shapes: current harness builds wrap
   the reference map in a `version`/`refs` envelope, older ones kept it at the
   document root. Both are written in place and neither is converted into the
   other, because the shape belongs to the harness build that reads the file.
   `refs` present settles it; `version` without `refs` settles it the other
   way, since that is a current harness on its first install — the case where
   guessing wrong is silent, because the harness resolves `apiKeyEnv` under
   `refs` and a key one level too high 401s with no diagnostic. `status()`
   resolves the credential through that same decision, so it can never report
   one the harness cannot read, and a new reference takes its indentation from
   a sibling rather than from the `refs:` key's own column — a mixed-indent
   block is not YAML any parser reads back, and this file holds every adapter's
   key.
2. **Refuse rather than guess.** `src/yaml-structure.mjs` is a fail-closed
   structural lexer for block-mapping YAML, not a general YAML parser. A
   document it cannot read plainly — a tab indent, a multi-document stream, a
   duplicate key, a sequence root, an unterminated flow collection, an anchored
   key, an inline `providers` mapping — is refused with the file untouched and
   the line named. A refusal costs a command; a wrong guess rewrites a file
   whose only copy is on the user's disk. Never add a "best effort" path there.
3. **Both documents are private.** The settings document carries the managed
   base URL, which is a local caller capability, and the credentials document
   carries the key it references. Both are written 0600 under a 0700 directory,
   the same bound the harness itself holds them to, and status output reports
   the redacted URL exactly as the Codex manager does. Never print the complete
   managed base URL.
4. **Routed models are always published; native ones require authorization and
   a session.** Publish only the selected, credentialed, listed, non-hidden routed
   models. An unregistered slug on the router's `/v1/responses` endpoint is
   treated as native GPT traffic needing a ChatGPT session, which a harness
   request does not carry — so a native model is advertised only while the user
   has explicitly authorized this shared local router plane and
   `nativeSessionStatus().usable` reports the session this machine is signed in
   with as spendable. `nativeSessionAvailable()` is the combined gate. Missing
   consent, an unreadable consent marker, sign-out, or expiry withholds the model.
   Publishing one the router cannot authorize offers a turn that 401s, which is
   the failure this gate exists to prevent; never widen it to presence alone,
   because an expired session is present.
   The vision-bridge engine candidates still exclude native models: that call
   site admits an engine on evidence the *caller's* session can spend it, and a
   substituted session is not the caller's.
5. **The protocol is `openai-responses`**, because that is the only thing the
   router's caller endpoint serves, and every router capability — tool-result
   ageing, the vision bridge, prompt-token substitution, upstream retry, usage
   and throughput accounting — already sits on that routed path. Do not add a
   second upstream path or a chat-completions surface for the harness; the
   point of pointing it at the same endpoint Codex uses is that there is one
   request path to keep correct. The Gemini surface is not an exception to this:
   it speaks Gemini at the edge because its client can speak nothing else, and
   then re-enters this same endpoint over the loopback rather than reaching a
   provider of its own. `models[].id` is the router **slug**, never
   the gateway model id: `/v1/responses` resolves it against `MODEL_BY_SLUG`,
   and a gateway id falls through to the native path.
6. **No `compat` on the route.** pi-ai types its reasoning-dispatch switches
   only on `openai-completions` and refuses a route-level switch anywhere else.
   Each model's request profile is applied on the router's own side of the hop,
   which is where that knowledge belongs.
7. **A reasoning level pi-ai cannot name is dropped, not approximated.** Its
   level set is `off, minimal, low, medium, high, xhigh, max`; the Codex ladder
   also spells `ultra`. `unmappableEfforts()` reports what was dropped so the
   omission is visible rather than silent. A model with no levels declares
   `reasoningEfforts: false` — omitting the field would inherit whatever
   pi-ai's installed catalog says about a colliding id.
8. **The default model is the user's.** Taking over `agent-default-model` is
   opt-in (`--set-default-model`), snapshotted verbatim, and restored on
   uninstall — the same discipline the Codex login-free mode applies to `model`
   and `model_provider`. Never write it as a side effect of publishing.
9. **Delegation is composition, not settings.** `dsh-tool-subagent` installs no
   settings section, so the router cannot configure the harness's subagent
   model and must not edit a preset it does not own. A child with no model of
   its own inherits the default model selection, which is already a routed
   model once the route is the default;
   `./bin/model-router dsh subagent-preset` prints the block to paste for a
   deployment that wants children on a *different* routed model. Codex's
   `bin/multi-agent` stays Codex-only: it drives `multi_agent_version` and the
   Codex agents directory, whose payloads are Codex's own encrypted format.
10. **Drift is this integration's failure mode.** The harness hot-reloads its
    settings document, so anything else that writes it takes effect at once and
    can leave the published route naming models the gateway no longer routes.
    `dsh-models.json` in the router's own state directory records what the last
    publish wrote; doctor compares it against the routable set, and it is the
    marker that decides whether an integration is installed. Any code path that
    changes the routable set must republish through
    `refreshTargetPickerIfInstalled()`, which refreshes every installed client
    rather than only the active target.

## Installing the harness is one action, and it is never a side effect

`dsh-config-manager.mjs` publishes routed models into a harness that is already
there. On a machine without one that assumption is a manual `npm install -g` the
user has to find in the docs, so `src/dsh-install.mjs` owns the other half.

- `control harness setup` installs `@deepseek-ai/dsh` globally if `dsh` is
  absent, then publishes. `control harness status` reports without touching
  anything. The tray's Settings row drives the same command.
- Global, not `npx`. The harness's own README documents `npx @deepseek-ai/dsh
  web`, which refetches per run and leaves no `dsh` behind — and an npx process
  is invisible to `presence-state.mjs`, which has to be able to see the client
  to keep the router up for it.
- Never folded into `apply`, `enable`, or a repair path. It installs a
  third-party package over the network; that must be something a user asked for
  in as many words, not a consequence of something else.
- Node is checked before npm is reached. The package declares no `engines`, so a
  stale runtime otherwise fails at first boot with a syntax error from inside
  `node_modules`. Compare major and minor numerically — `22.9` sorts above
  `22.19` as a string.
- Install then publish, with no rollback between them. A publish that fails
  leaves an installed harness, which is where a retry wants to start, and the
  publish is idempotent so the retry is a re-run of the same call.
- `npm-global-install.mjs` holds the npm mechanics for both this and the
  provider CLIs. One copy, because the details that took a debugging session to
  get right — the PATH a spawn inherits, where npm drops binaries per platform,
  which line of npm's output is worth showing — are exactly what drifts.
- Native GPT models are published only while `codex-native-session.mjs` reports
  both explicit shared-plane authorization and a usable session: they need a
  ChatGPT session, and a harness request carries none of its own. One
  `chatgpt-session enable` applies to every local client for this OS user; they
  are withheld again the moment authorization is revoked or the session is
  missing or expired. The count the button reports is the routable set, not the
  picker.

`src/dsh-web.mjs` starts and finds the browser UI, so the tray's button can be
`Open site` once there is a site to open.

- Adopt, never collide. The harness binds a fixed port rather than picking a
  free one, so a second launch exits with `EADDRINUSE` and takes the click with
  it. `startDshWeb` probes first and returns `startedNow: false` when something
  already answers.
- Stop only what this router started, the same rule `ollama-runtime.mjs`
  follows. PID plus process start identity are persisted together and both must
  match, because PIDs are reused; `src/process-identity.mjs` holds that check
  for both callers.
- The probe asks whether the port answers, not what is behind it. A 404 from the
  harness's own router is a running harness, and fingerprinting somebody else's
  HTML to be surer would be worse than the ambiguity.
- The port is a setting (`MODEL_ROUTER_DSH_WEB_PORT`), not a constant. `dsh web
  --port` exists, and a user who moved theirs must not be sent to a dead URL.
- Setup does not start the UI. It already installs a package and writes another
  program's configuration; adding a server launch makes one click three
  consequential things, and the last is the one the user can do themselves a
  moment later. Starting is its own button, so a republish never puts a browser
  window on screen that nobody asked for.
- `control --json` must carry the *web-aware* snapshot. It is what the tray
  polls, and the cheap synchronous variant reports no `web` at all, which reads
  as "stopped" and offers to start a harness that is already serving.
- Stopping and disconnecting are different questions, and the row asks whichever
  one currently costs something. While the harness is resident it holds a Node
  process and its plugin tree in memory -- ~184 MB measured -- so the secondary
  action is **Turn off**, which stops the process and leaves the route
  published. Once nothing is running, the only thing left to undo is the
  integration, so it becomes **Disconnect**. A harness this router did not start
  is never signalled; the row says where it came from instead.
- Turning a client off is not a reason to tear the plane down. `bin/disable`
  removes the service only once `installedTargets()` is empty; disabling the
  harness while Codex is still published used to uninstall the LaunchAgent and
  stop Codex working too. `control harness disconnect` is the tray's path and
  never touches the service at all.
- The default model is the user's. Restore only over a default this router
  wrote — the harness's own Models page writes the same key, and a snapshot
  taken before their choice is not a licence to undo it. With no snapshot but a
  router-owned default, remove the key rather than leave the harness pointed at
  a provider the same uninstall just deleted. All three cases are covered in
  `test/dsh-config-manager.test.mjs`.
