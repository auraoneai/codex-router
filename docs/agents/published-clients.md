# Published-into clients (opencode, pi, omp, Command Code, Hermes Agent)

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Five clients, one publisher, one key each

opencode, pi, omp, Command Code, and Hermes Agent all offer the same thing: a
user-owned configuration document with a mapping of custom providers in it.
That is why they share `src/routed-harness-*.mjs` rather than getting five
near-identical managers. `routed-harness-catalog.mjs` is the part that
genuinely differs and it is data; `routed-harness-document.mjs` edits one key
of somebody else's file; `routed-harness-manager.mjs` is the publisher.

- **The wire is one the router already serves, never a third one.** The caller
  endpoint answers `/v1/responses` and, behind the `/anthropic` leaf, the
  Anthropic Messages API. Nothing else — there is no `/chat/completions`. So
  opencode, pi, and omp declare a Responses provider, while Command Code and
  Hermes take the Anthropic surface with `claude-model-id.mjs` ids. Command
  Code's BYOK wire is Chat Completions or Anthropic Messages and Hermes's
  `codex_responses` is its xAI path, not a generic Responses client; picking
  the "OpenAI-compatible" option for either would have published a provider
  that 404s on its first turn. `test/routed-harness.test.mjs` asserts no
  adapter ever emits `openai-completions`.
- **The capability is the URL, not the key.** The caller secret is a path
  segment, so a bearer is redundant. Where a client treats a keyless provider
  as first-class it is declared keyless (`auth: none` for omp, `apiKey: false`
  for Command Code, omitted for Hermes); where a client *hides* keyless models
  from its own picker — pi loads them and leaves them unselectable — the same
  secret is repeated in the field it reads. That difference is not cosmetic: it
  decides whether the models show up at all. Every published document is
  written 0600 either way, because the URL is the capability.
- **These are not `MODEL_ROUTER_TARGET` values.** Nothing installs *as*
  opencode. They are published into by `control client-setup <id>` and removed
  by `control client-disconnect <id>`, and neither touches the service.
  `installedTargets()` still counts them, so `bin/disable` will not retire the
  shared plane while one of them is pointed at it.
- **A `codex-router` provider we did not write is never replaced or removed.**
  Ownership is decided by the base URL, not by the key name: a second checkout,
  an older build, or a hand-written proxy can legitimately hold that name.
  Install and disconnect both refuse rather than guess.
- **YAML is spliced, JSON is round-tripped, and neither is reformatted.**
  `omp` and Hermes are edited by line range through `yaml-structure.mjs`, which
  is what preserves comments and hand-formatting. JSON documents go through
  `JSON.parse`, which cannot preserve a `//` comment — so a document that is
  not plain JSON is refused with an explanation, and an `opencode.jsonc` beside
  `opencode.json` blocks publication rather than being rewritten or ignored.
- **The default model is the user's.** opencode is the only one of the five
  whose default key is a plain string in the same document; the others keep
  theirs in a second file or behind a mapping whose schema changes shape on
  first use, and guessing wrong there costs a user their configured model for
  no gain. Even there it is claimed only over a value this router wrote, or
  when nothing is set, and removed on disconnect only while it is still ours.
- **A failed marker write rolls the document back.** A client pointed at a
  route the router has no record of is the one state neither disconnect nor
  drift detection can reason about.
- **Rotation covers all five.** The secret is a path segment of every published
  base URL, so `caller-key.mjs` refreshes each of them and
  `installedTargetsFromStatus` refuses to rotate across one whose managed state
  is partial.
- **Installing the client CLI is still the explicit action it is for the
  harness.** Only `client-setup` installs, and only from a package registry.
  Hermes ships a `curl | bash` installer and omp (can1357/oh-my-pi, whose npm
  package runs on Bun) installs from a script, Homebrew, or Bun; this router
  does not run remote installers on somebody's behalf, so those rows report the
  CLI as missing and link to the official instructions. Do not point the omp
  row at `@oh-labs/oh-omp`: that fork installs `oh-omp` and reads `~/.oh-omp`,
  not the `~/.omp` the `omp` command reads.
- **A client too old to read the document is updated, not published past.**
  Command Code first reads `providers.json` in 1.30.0, so `minimumVersion` on
  its catalog entry makes setup update an older CLI and makes status and doctor
  report one. A version the CLI will not report is unknown, not outdated.
- **Staying current is its own action, and it runs the client's own updater.**
  `@latest` in `npmPackage` only decides what a *first* install fetches;
  `installRoutedHarness` deliberately leaves a CLI that is already there alone,
  because bumping somebody's global coding agent must not be a consequence of
  republishing a model list. `control client-update <id>|--all`, the Harness
  row's **Update** button, and `updateRoutedHarness` are the paths that do it.
  Each prefers the client's own updater (`opencode upgrade`, `pi update
  --self`, `command-code update`, `hermes update --yes`) over `npm install -g`:
  a CLI installed by Homebrew or a `curl | sh` script is not an npm package,
  and reinstalling it as one leaves two copies whose winner is PATH order —
  which shows up as a row reporting the new version while the shell keeps
  running the old one. npm is the fallback only for a client that publishes a
  package and ships no updater. `--all` skips a client that is not installed
  (update what I have, not install five agents I never asked for) and reports
  per client rather than stopping at the first failure. A client that reports
  no version before and after is never called "updated".
- **Check the package name is still the maintained one.** pi moved publishers:
  `@mariozechner/pi-coding-agent` stopped at 0.73.1 and the live line is
  `@earendil-works/pi-coding-agent`. An abandoned package still installs and
  still answers `pi --version`, so nothing in this repository would have
  reported it as wrong — only reading the client's own install docs does.
- **Prove a publication against the real client, not against its docs.** The
  unit suite passed while opencode 1.18 rejected every published model, because
  its schema requires `limit.output` whenever `limit` is present. opencode now
  gets `limit.input` at the router's `autoCompact` and `limit.output` as the
  headroom above it, or no `limit` when there is no threshold. A change to any
  adapter needs the same check: publish into a scratch document, then have the
  installed client list the models from it and take one real turn (a free route
  costs nothing). Listing alone missed that OpenCode's post-completion `ping`
  had become a trailing gateway error: Codex ignores bytes after a terminal
  event, and opencode and pi do not.
- **Devin CLI and T3 Code are deliberately absent.** Devin CLI's config selects
  from Cognition-hosted models and has no custom base URL, so routed models
  cannot be published into it; the `devin-cli` *provider* is the other
  direction and already exists. T3 Code drives official CLIs rather than
  talking to models itself, so it inherits whatever routed client it drives —
  see `docs/COMPATIBLE-APPS.md`. Neither gets a Harness row, because a row that
  cannot publish is a row that lies.
