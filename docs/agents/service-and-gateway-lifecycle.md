# Service lifecycle and gateway supervision

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## `stop` and `start` act on the same layer, and the proxy survives either

`bin/stop` unloads the background service. `bin/start` used to exec the
supervisor in the foreground instead, so the obvious `stop; start` pair was
asymmetric: it retired the managed service and left an unmanaged copy in its
place. The copy carried the calling shell's environment rather than the
installed one and died with the shell that started it.

That is how a live installation lost its proxy. A `stop; start` issued from a
`zsh -lc` that a desktop app had spawned produced a router with no
`HTTP_PROXY` and no `NODE_USE_ENV_PROXY`, because the shell had neither. Every
upstream was dialled directly, chatgpt.com timed out, and the router answered
502 with the message from `src/transport-failure.mjs` telling the operator to
set an opt-in that was already set -- in the LaunchAgent it had just unloaded.
The service definition still looked correct at every glance.

1. **Both verbs go through `src/service.mjs`.** `bin/start`, Windows
   `codex-router.ps1 start`, and their corresponding stop paths manage the same
   background-service layer. Never add a lifecycle verb that manages the service
   on one side and bypasses it on the other.
2. **The foreground supervisor stays reachable, never by accident.**
   `bin/start --foreground` and `codex-router.ps1 start --foreground` are the
   explicit debugging paths. They enter through `src/foreground-start.mjs`,
   which holds the shared service-operation lock for the supervisor's lifetime.
   That keeps caller-capability rotation/recovery from swapping generations
   underneath an unmanaged foreground router. Direct `src/start.mjs` remains the
   OS-service payload; do not route the managed service through the lifetime lock.
3. **A silent environment adopts the recorded proxy.**
   `inheritedProxyEnvironment()` in `src/proxy-environment.mjs` reads the
   install manifest, and `src/start.mjs` applies it to `process.env` before it
   reads anything or spawns a child, so the router and all three forwarders
   inherit it. This is the belt to the service definition's braces: it makes
   the foreground path, and any future path that execs the supervisor directly,
   reach upstreams exactly as the managed one does.
4. **Silence is the only trigger.** `proxyEnvironmentDeclared` already treats a
   named proxy -- or any `NODE_USE_ENV_PROXY`, `0` included -- as the operator
   speaking, and the restore defers to it. A deliberate unproxied run stays
   unproxied. Do not widen the trigger to "no proxy reachable" or similar
   inference; the manifest records a decision, not a guess.
5. **Coverage.** `test/proxy-environment.test.mjs` holds the restore contract
   and `test/service-lifecycle.test.mjs` holds the dispatch/ownership boundary:
   normal start reaches the managed service layer, Windows matches POSIX, and
   explicit foreground startup cannot boot while another service lifecycle
   operation owns the shared lock. The same file keeps the silent-environment
   proxy restore regression.

## The gateway is restarted in place; the router is not taken down with it

`src/gateway-supervisor.mjs` watches the LiteLLM child and replaces it when it
dies. It exists because the gateway is the one child of the service that is not
ours: a bug anywhere in that pinned Python tree can end the process rather than
the request, and issue #261 is exactly that — mapping an upstream 429 raised out
of LiteLLM's own request handler and the proxy exited 1. `start.mjs` raced every
child's exit, so one failed request killed the router and all three forwarders
and every client saw a bare "Connection error" naming nothing.

1. **Only the gateway is supervised.** The forwarders and the router are ours;
   when one of them dies the service still exits and the OS supervisor rebuilds
   it. Do not extend the supervisor to them to "be consistent" — a crash in our
   own code is a bug report, and papering over it costs the incident.
2. **Supervision starts only after the gateway has been healthy once.** A
   gateway that never came up is a dependency or configuration failure, and
   retrying it buries the message the operator needs. Startup failure is
   unchanged: it throws out of `main()` and takes the service down, which is
   what `test/startup-cleanup.test.mjs` asserts.
3. **Bounded, and bounded *in a window*.** At most five restarts inside ten
   minutes, backing off 1s, 2s, 4s, 8s, 16s, capped at 30s. The window is
   load-bearing in both directions: a lifetime budget would eventually stop
   restarting an install that crashes once a month, and no bound at all turns a
   gateway that dies on every request into a spawn loop. Past the bound the
   supervisor returns and the service exits exactly as it used to, so launchd's
   `KeepAlive`, systemd's `Restart=always`, and Task Scheduler get their clean
   restart. `CODEX_ROUTER_GATEWAY_RESTARTS=0` disables it entirely and restores
   the pre-#261 behaviour, which is what a crash investigation wants.
4. **Never silent.** The production LaunchAgent hard-sets `CODEX_ROUTER_QUIET`,
   and a router that quietly resurrects a crashing gateway is indistinguishable
   from one that never failed. Every crash, every restart, and the decision to
   stop restarting are logged unconditionally.
5. **A replacement that never becomes healthy is stopped, not left parked.**
   Otherwise the loop waits on an exit that only an external kill can produce,
   and a hung gateway looks like a healthy one.
6. **`/health` names the unreachable dependency.** The unauthenticated leaf
   carries `degraded: ["gateway"]` — a closed set of three fixed local service
   names, never a URL, a credential, or the per-service payloads the protected
   leaf carries, and `test/routing.test.mjs` asserts that boundary. It is what
   lets doctor report "serving but reports gateway unreachable" instead of "not
   ready", which sent operators looking for a dead service when the gateway was
   the thing that died.
7. **The launcher is spawned through `spawnableCommand`, like every other
   external command.** The installer produces `litellm.exe` on Windows, so the
   shipped path is untouched pass-through — but `MODEL_ROUTER_LITELLM_BIN` and
   `CODEX_ROUTER_LITELLM_BIN` are operator-set, and Node has refused to spawn a
   `.cmd`/`.bat` without a shell since CVE-2024-27980. A batch launcher there
   used to end the service before it spawned anything, with an EINVAL naming
   neither the file nor the reason. Never reintroduce a bare
   `spawn(command, args)` in `start.mjs`; `test/gateway-restart.test.mjs` guards
   the shape, because the behaviour itself cannot be exercised on POSIX. All
   three fields of the result are load-bearing, `options` included: for a batch
   shim it carries `windowsVerbatimArguments`, without which Node re-quotes a
   command line that is already escaped for cmd.exe. A call site that spreads
   only `command` and `args` is a Windows bug that POSIX CI cannot see — it was
   how `devinCliVersion` came to report "unknown" for an installed CLI. Note
   the one cost of the batch path: the service then holds the `cmd.exe` hop
   rather than the gateway, so a signal reaches the hop and the real process is
   orphaned. That is strictly better than not starting at all, and it is another
   reason the installer produces an `.exe`.
8. **Z.ai choice-bearing terminal usage is normalized before LiteLLM.** LiteLLM
   1.95/1.96 can discard authoritative usage when an OpenAI-compatible provider
   puts `finish_reason` and `usage` on the same streaming chunk. Z.ai does that,
   so `src/zai-cache-usage.mjs` rewrites only that provider shape into the
   standard usage-only terminal chunk and preserves explicit cached-token
   details. Do not replace missing usage with estimates at this boundary and do
   not downgrade LiteLLM to escape the bug; the pin is also a security and
   wheel-availability floor. `scripts/verify-zai-litellm-usage.mjs` exercises
   the pinned LiteLLM bridge with synthetic authoritative usage on every Python
   lock job.
9. **Z.ai Responses streams need a post-LiteLLM message-envelope repair.**
   Live GLM-5.3 traffic through LiteLLM 1.96 can finish a reasoning item and
   then emit `response.output_text.delta` for the assistant message without the
   required `response.output_item.added` / `response.content_part.added`
   envelope. The same malformed stream can reuse reasoning's `output_index=0`
   for the message and close the message with a `reasoning_text` content part.
   `src/zai-responses-compat.mjs` repairs only that Z.ai event-stream shape
   after LiteLLM translation: valid streams remain byte-identical, native
   OpenAI traffic is never attached to the transform, and provider reasoning
   must never be copied into assistant-visible message content. A real Codex
   live probe is the regression oracle: no `OutputTextDelta without active
   item` warnings and the message occupies the next output index after
   reasoning.
10. **LiteLLM custom-tool streaming uses a mixed lifecycle.** LiteLLM 1.96
   converts Responses `type: "custom"` tools into Chat Completions functions
   whose one required string property is `content`. On the return stream it can
   already restore `response.output_item.added` / `done` as native
   `custom_tool_call` items while still emitting legacy
   `response.function_call_arguments.delta` / `done` events whose JSON wrapper
   is `{ "content": "..." }`. `NamespaceToolCallTransform` may decode that
   wrapper only when the source opening itself was already a native custom call;
   the router's own custom-function bridge keeps its `{ "input": "..." }`
   contract. Keep the streamed-input fingerprint check and fail closed when the
   delta, terminal arguments, or output-item close disagree. The focused
   namespace-relay test and Z.ai router fixture hold both sides of this boundary.
   The wrapper is a request, not a guarantee: models put `content` after another
   key, answer `{ "input": ... }` or `{}`, or send raw patch text, and LiteLLM
   relays those rather than rejecting them. For a native custom call the relay
   therefore derives the input exactly as LiteLLM's
   `unwrap_custom_tool_arguments` does -- a string `content` from a JSON
   object, otherwise the arguments verbatim -- and never a stricter reading;
   rejecting a shape LiteLLM accepted aborts a committed stream and Codex
   retries the identical turn until it fails. A present non-string `content`
   stays unsupported, and the delta check is skipped only when the decoder
   emitted no input text for the client to contradict.
11. **Do not answer a gateway crash by moving the litellm pin.** The pin is a
   security floor and a wheel-availability decision (see the lock section
   above), any change to it has to be proven by booting the proxy rather than by
   a successful resolve, and a router that survives its gateway is worth having
   at every version. Coverage lives in `test/gateway-supervisor.test.mjs` (the
   loop, the bound, the window, the backoff) and `test/gateway-restart.test.mjs`
   (end to end: a stand-in gateway exits 1 mid-request, the service does not,
   and the router is still serving afterwards).
