# Upstream retries and model failover

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Upstream retries are legal only before the first relayed byte

`src/upstream-retry.mjs` retries a native upstream request a bounded number of
times. One rule governs it, and breaking it corrupts responses rather than
merely failing them.

1. A retry is legal only while **nothing has been relayed**. The loop lives
   entirely before its callers touch their `ServerResponse`, and the `canRetry`
   predicate (`response.headersSent`, checked again before every retry) is the
   backstop. `copyResponseHeaders` only stages values with `setHeader`, so
   `headersSent` flips when Node flushes the head — on the first body write, or
   on `end()` for a bodyless upstream. Never move a retry around
   `pipeResponse`: an upstream that dies mid-stream has already delivered
   bytes, and replaying it appends a second response to a stream the client is
   reading. `test/native-retry.test.mjs` asserts the caller received the partial
   stream exactly once.
2. Only failures where an intermediary never obtained a response qualify: 502,
   503, 504, Cloudflare's 520-524, and connect-level socket errors. Do not add
   429 — it is rate limiting, its `Retry-After` is relayed, and sleeping for the
   upstream's suggested delay is the hang the bound exists to prevent. Do not
   add 4xx, and do not add 500, where the origin ran and a repeat risks a second
   execution.
3. Keep the bound small. Codex retries roughly five times on its own and the
   two loops multiply, so the router's share (2 retries, 250ms then 750ms) has
   to keep the product a fast failure. A retry is also only *started* while the
   request has been cheap so far — a five-second budget, because a 504 the edge
   spent half a minute producing, or a connect timeout, must not be tripled.
   `CODEX_ROUTER_NATIVE_RETRIES`, `CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS`, and
   `CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS` tune it; `0` disables it.
4. The request body must stay replayable: encode it into a Buffer once, above
   the retry, so every attempt sends identical bytes under the identical
   `Content-Encoding`. Never hand the loop a stream, and never re-run
   `compressedNativeBody` per attempt — headers and body would be free to
   disagree.
5. An abort stops everything at once, backoff included. Pass the caller's signal
   through to both the fetch and the wait.
6. A silent retry is worse than no retry: it makes a flaky upstream look
   healthy. The retry log line is never gated on `CODEX_ROUTER_QUIET`, which a
   production LaunchAgent hard-sets, and the usage event carries `retries` so a
   turn the router rescued is distinguishable from one that never failed. Log
   the status or the transport error's own name and code — never a response
   body, and never the caller capability path.

## Moving a turn to another model is legal only before the first relayed byte

`src/model-failover.mjs` decides when a turn whose provider reported it has no
usage left is rebuilt for a different model, and `buildRoutedRequest` in
`src/router.mjs` is what makes rebuilding it possible. The rules are narrow on
purpose; several of them exist because the obvious wider version is wrong.

1. The **same relayed-byte rule as upstream retries**, for the same reason. The
   failover branch lives before `pipeResponse`, and `nothingRelayed(response)`
   is re-checked before every hop. Never move it around `pipeResponse`: a
   mid-stream swap grafts a second response onto a stream the client is reading,
   and duplicates any tool call the client has already executed. That second
   hazard is worse than the duplicated stream and has no equivalent in the retry
   path.
2. Only **"your usage is gone"** qualifies: `upstreamFailureKind` returning
   `out_of_usage`, a 402, or a 429 whose `Retry-After` exceeds sixty seconds. Do
   not add 401 or 403 — a swap would hide the rejected credential that is the
   only thing worth telling the operator. Do not add 404 or 400, which are
   deterministic. Do not add 5xx: `upstream-retry.mjs` already absorbs the
   transient shapes, and masking a provider outage costs an incident somebody
   would want to see. Do not lower the 429 threshold; trading a twenty-second
   wait for a cold prompt cache is a bad deal for the rest of the session.
   Entitlement failures are classified **before** quota ones and never swap,
   because "upgrade your plan" appears in both vocabularies and no other
   provider's quota makes a missing entitlement true.
   A local LiteLLM conversion of stored tool-call arguments
   (`Failed to parse tool call arguments for tool … (Anthropic tool invoke)`)
   is the same class of failure: it happens before any provider request, the
   argument body is echoed in the error and can match a quota phrase, and no
   other provider can make that history executable. Classify it before quota
   and never swap (#796).
   Claude Code excludes billing errors from its own fallback on the reasoning
   that they usually mean misconfiguration. That reasoning does not hold here:
   with thirty providers configured, an exhausted plan is a daily event and
   having somewhere else to go is the whole point of the install.
3. **Never trade a quota error for a context error.** A candidate is eligible
   only when its `contextWindow` can hold `estimateInputTokens` of the bytes the
   turn was about to send. That estimate errs high by design, which is the safe
   direction. Falling from a 1M-context model onto a 262K one mid-session is a
   strictly worse turn than the one it replaced.
4. **Never fail over inside the same provider family.** Compare
   `canonicalProviderId`: protocol variants share one credential and therefore
   one quota, so a sibling is guaranteed to fail the same way.
   Compaction is the one exception: a context-length 400 on
   `/responses/compact` may retry a larger-window model, including a
   same-family sibling, without recording a cooldown. Ordinary turns still
   never swap on 400 and still never hop inside the family. See "Union Alpha
   on OpenCode Go Messages compacts below window-minus-output".
5. **A cooldown is only ever a window the provider itself named.** Derived from
   `Retry-After`, `cooldownUntil`, or a wall-clock reset the provider stated in
   its own refusal body — Z.ai's Coding Plan sends "Your limit will reset at
   2026-09-01 21:32:15" and no header, and without reading it an exhausted plan
   is re-attempted once per turn for the whole window. A bare stamp carries no
   zone, so it is resolved to the **earliest** instant any real UTC offset
   allows that has not already passed, and ignored outright when no offset can
   place it ahead. Waking early costs one refusal; waking late withholds a model
   the operator is paying for, and reading a zoneless stamp as local time does
   exactly that for anyone whose clock does not match the plan's. Never
   invented, capped at six hours, and
   cleared on that provider's next successful answer. A provider under cooldown
   is skipped before dispatch, which is the entire saving — so a cooldown that
   is wrong strands the operator's chosen model, and that is why nothing may
   record one from a guess. `control failover reset` and the doctor's report
   exist so a wrong one is visible and removable.
6. **Bounded**: at most two hops, a thirty-second budget for the whole sequence,
   abort-aware, stop on the first success. When nothing is eligible, return the
   failure the operator's own model gave — it is the one they can act on.
7. **Never silent, and never in the transcript.** The log line is not gated on
   `CODEX_ROUTER_QUIET`, which a production LaunchAgent hard-sets. Both attempts
   are metered and the serving row carries `failoverFrom`. Do not "helpfully"
   inject a notice into the stream: Codex replays assistant output as input, so
   a router-authored sentence comes back next turn as something the model
   believes it said.
8. **The rebuild must start from the pristine payload.** `buildRoutedRequest`
   writes to neither `payload` nor the aged input, and this is load-bearing in
   two places. `flattenNamespaceTools` only recognizes `type: "namespace"`
   items, so a second pass over already-flattened tools returns an *empty*
   namespace map — plausible tools with no way to map the model's calls back.
   And `carryReasoningThroughInput` replaces reasoning items in place, so a
   responses-native second pass would find them already gone. The input array is
   copied before it is rewritten — and copied **only when it is an array**,
   because `input` is equally legal as a bare string and spreading one produces
   an array of single characters, which reaches the provider and still reads as
   a 200. `test/router-timing-log.test.mjs` caught exactly that.
9. `selectedConfiguredListedModels()` is **not** cheap: it probes every
   provider's credential synchronously and spawns `/usr/bin/security` per
   keychain service on macOS. Call it only once a failure or a cooldown is
   already known, never on the happy path.
10. Coverage lives in `test/model-failover.test.mjs` (classifier, ranking,
    cooldown store) and `test/model-failover-router.test.mjs` (end to end,
    including that the failed attempt's bytes never reach the client). A change
    to the trigger set, the ranking, or the cooldown rules needs a test there.

**Not implemented: the native ChatGPT tier.** Falling back to the signed-in
ChatGPT plan is deliberately absent. It is not a body swap but the other branch
entirely, and it crosses the routed/native boundary this file governs
elsewhere — `encrypted_content` rewriting, the compatibility relay, the
collaboration envelope. Those rules require live marker-return probes through
every installed routed agent before a change ships, so the tier cannot be added
from the test suite alone. Add it with those proofs or not at all.
