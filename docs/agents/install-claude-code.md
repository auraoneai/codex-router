# Claude Code target

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Claude Code outcome

Publish every selected, credentialed routed model to Claude Code through a
router-owned `claude-router` launcher, preserve Claude's settings and login,
and keep every turn on the shared canonical Responses path.

1. Require the official `claude` CLI. Never edit `~/.claude/settings.json`.
2. Run `./install.sh --target claude --auto --providers IDS` on macOS/Linux or
   `./install.ps1 -Target claude -Auto -Providers IDS` on Windows.
3. The launcher supplies a secret-bearing loopback `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_AUTH_TOKEN`, and gateway model discovery only to its child
   process. It must not persist those values into Claude-owned files. It also
   pins Claude Code's agent and default-tier model names
   (`CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, and
   `ANTHROPIC_DEFAULT_OPUS_MODEL`/`_SONNET_MODEL`/`_HAIKU_MODEL`) to the same
   routed model the session runs: built-in agents and agents whose frontmatter
   pins `model: opus` resolve through the tier aliases rather than through
   `CLAUDE_CODE_SUBAGENT_MODEL`, and an unpinned alias falls back to a literal
   Anthropic id the router does not serve, which 404s every spawned agent of
   that type. A caller value that already names a routed id is preserved.
4. Model discovery publishes every routed slug as
   `codex_router/anthropic/ROUTER_SLUG`. The `anthropic` segment is required:
   Claude Code filters gateway-discovered ids that do not contain `claude` or
   `anthropic`. A model whose `contextWindow` is at least 1M is published with
   Claude Code's `[1m]` suffix (`codex_router/anthropic/ROUTER_SLUG[1m]`):
   Claude Code caps every other gateway id at 200k no matter what discovery
   declares, and a large tool surface then auto-compacts on every turn. The
   suffix never reaches the wire. Discovery and `GET /v1/models/{id}` report
   `max_input_tokens`/`max_tokens` so smaller models compact at their real
   window. Only Claude-family models get the marker.
5a. The launcher runs Claude Code with `ENABLE_TOOL_SEARCH=true`, and the
   Messages surface emulates Anthropic's deferred loading: a tool marked
   `defer_loading: true` is offered to the model only after a `tool_result`
   in the conversation references it with a `tool_reference` block.
5. The Anthropic Messages surface translates and re-enters `/v1/responses`; it
   never reaches a provider directly. Tool use/results, images, token counting,
   SSE pings, and the model list are part of the compatibility boundary.
6. Run `bin/model-router claude doctor`. Routing config, launcher, catalog
   freshness, caller capability, service, router health, and credentials must
   be `OK`. Then tell the user to run `claude-router` and use `/model`.
7. Anthropic officially supports Claude Code gateways for Claude models. Using
   non-Claude models through this compatibility surface is functional but not
   an Anthropic-supported product configuration; do not describe it otherwise.
