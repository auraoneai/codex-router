# Prompt-token count substitution

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Substituting a prompt-token count a provider reported as zero

Codex decides when to compact from the `input_tokens` each response reports, so
a provider that answers a large prompt with an explicit zero disables
compaction entirely and the session runs until the provider rejects the turn.
The router replaces that number on the way to Codex. The rules are narrow on
purpose.

1. Only an **explicit zero** is replaced, and only on a **routed** response
   whose request the router measured as large. A missing usage block, a missing
   prompt field, and any positive count are all forwarded untouched, so a
   provider that reports correctly never sees this path and the substitution
   stops by itself the moment the upstream recovers. Do not widen the predicate
   into "the number looks wrong".
2. The estimate errs **high**. Compaction sits below the provider's hard limit
   (900,000 of 1,048,576 for the affected models, a 14% margin), so an estimate
   that lands low still lets the turn die, while a high one only compacts
   sooner. Do not "improve" the ratio toward accuracy without re-checking that
   margin, and do not add a tokenizer dependency or download for it.
3. Telemetry keeps what the **provider** said. The usage event records the
   reported counts verbatim and adds `estimatedInputTokens` beside them; the
   log line names the substitution. Never fold the estimate into `inputTokens`
   — a run of estimated turns is the evidence that the provider is still
   broken, and an overwritten field would read as a recovery.
4. The response body is otherwise byte-identical, including bytes that are not
   valid UTF-8: the rewrite path forwards the original buffers and re-encodes
   only the one `data:` line it replaces, preserving framing and terminators.
   Do not reintroduce a decoded-text passthrough, which silently rewrites a
   malformed byte to U+FFFD.
5. If a provider is ever added that reports prompt tokens *excluding* cache
   hits, a fully cached turn could report a truthful zero. Substituting there
   is still right for compaction — cached tokens occupy the context window —
   but say so in that provider's registry work rather than discovering it from
   a surprised user.
6. Regression coverage lives in `test/response-usage.test.mjs` and the
   `prompt-token estimate` cases in `test/routing.test.mjs`. A change to the
   predicate, the ratio, or the telemetry needs a test there.
7. Actual image references may use a documented provider/model token bound
   instead of charging their base64 bytes as text. Direct DeepSeek Flash and
   its retired Flash aliases use the documented 1,024-token maximum per image
   (verified 10 September 2026). File references still contribute image tokens.
   Do not extend this bound to resellers or other models without evidence, or
   discount pasted image JSON, tool schemas, or unknown content shapes. The
   estimate must not mutate or upload the caller's image data.
