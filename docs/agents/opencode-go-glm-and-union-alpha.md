# OpenCode Go: GLM-5.3-Flash (formerly Ox Alpha) and Union Alpha

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Ox Alpha became GLM-5.3-Flash on OpenCode Go

Z.ai revealed the OpenCode Go Ox Alpha preview as GLM-5.3-Flash. OpenCode Go
withdrew `ox-alpha-free` and now publishes `glm-5.3-flash` on Chat Completions.
The checked-in route is `opencode-go/glm-5.3-flash`; the old public slug
`opencode-go/ox-alpha` is a static migration alias so existing picker state and
callers move to the live route instead of reaching a withdrawn upstream ID. The
older curation slug `opencode-go/ox-alpha-free` is an alias to the same target.
OpenCode Go publishes a 1,000,000-token context and 131,072-token output limit
for the named route. Store the provider limit rather than the base model's
1,048,576 architectural maximum. The ordinary 0.85 compaction ratio is not
safe for this route in Codex: large live multimodal histories repeatedly
returned empty completions before that point. Compact conservatively at 400,000
while retaining the provider's advertised context as catalog metadata. This
does not bypass provider moderation; a rejected remote compaction remains a
provider limitation, not a router or stream crash.

No checked-in route preserves the preview under the Ox Alpha name. OpenCode
Free, OpenRouter, and Nous Research withdrew their preview ids. Direct
exact-route probes then rejected `stealth/ox-alpha` on Command Code as
`model_unavailable` on basic, streaming, forced-tool, stateless tool-result,
and compact requests. The available Venice account returned its HTTP 402
billing gate on all five surfaces before `stealth-ox-alpha` could be
wire-certified. Exact probes disable cooldown, response-verdict, and compaction
failover, so neither result can be a healthy alternate answering in disguise.
The repository therefore ships neither preset.

Command Code and Venice discovery still preserve the provider catalog for
explicit operator curation. That is not compatibility certification: a local
entry can fail when the catalog is stale or the account cannot reach inference.
In particular, Venice curation retains the provider-advertised effort metadata;
the repository does not replace it with a cross-provider inference for a route
it could not execute.

The named GLM-5.3-Flash routes on OpenCode Go, OpenRouter, Z.ai API, and Z.ai
Coding did pass direct basic, streaming, forced-tool, stateless tool-result,
and compact probes. Their recorded effort ladder is `low`/`high`/`max`, and it is the
**model's** ladder rather than a generic reseller default. The model always
thinks, and its upstream refuses an off-ladder rung by name:

```
HTTP 400 — [1210] This model always engages in thinking and cannot be
disabled; please use low, high, or max
```

The ladder also collides with the effort clamp in `src/catalog.mjs`. Codex
gained the `max` variant in 0.143.0, so on anything older the catalog rewrites
this model's default down to `xhigh` — a rung every route refuses. The
legacy-named `ox-alpha` request profile in `src/api-forwarder.mjs` closes that
loop for the OpenCode Go, OpenRouter, and Command Code named routes: it clamps
whatever Codex sent onto the rungs the registry entry declares, so `xhigh` and
`ultra` land on `max`, while `medium` and `minimal` land on `low`. An absent effort stays absent
so the upstream default applies, and undocumented `thinking` is stripped. Z.ai
Coding uses its own `glm-thinking` profile. These named routes advertise a
1,000,000-token window, compact at the directly proved conservative 400,000
threshold, and preserve forced `tool_choice: "required"`.

That 400,000 threshold belongs to the **model**, not to one reseller. Every
checked-in GLM-5.3-Flash route carries it, including `commandcode/glm-5.3-flash`
and the Ollama Cloud candidate, because the empty completions came from the
model's own large multimodal histories rather than from a provider's serving
stack, and each of these routes advertises the same 1M window over the same
upstream id. `nousresearch/glm-5.3-flash` was dropped for compacting at 943,000
against this rule; `commandcode/glm-5.3-flash` shipped at 900,000 for two weeks
because that is the Command Code house value for a 1M window — the entry was
written fresh in a bulk catalog pin, took the provider default, and no commit
message, comment, or research note ever argued for it. A per-provider exception
here is a claim about that provider's serving stack, so it needs its own
evidence in the entry or in this file; a provider's boilerplate ratio is not
that evidence.

`commandcode/glm-5.3-flash` needed that clamp for the same reason and shipped
without it. The profile chain in `src/api-forwarder.mjs` is keyed entirely on
`requestProfile`, so a route that declares none forwards `reasoning_effort`
verbatim — and this entry declares the model's `low`/`high`/`max` ladder, which
is exactly the ladder whose top rung a pre-0.143 Codex cannot spell. Command
Code documents no effort vocabulary of its own (which is why
`commandcode/muse-spark-1.3` ships `high` alone), so the clamp is not a claim
about that reseller's serving stack: it only guarantees the router sends a rung
the entry itself advertises. Note that the clamp governs the Provider API path
only. The `/alpha/generate` plan fallback in `src/commandcode-generate.mjs`
builds its own schema-strict params and carries no effort at all, so on a
coding-plan account the three rungs in the picker reach nothing either way.
Other Command Code entries — `glm-5.3`, `glm-5.2`, the DeepSeek V4 routes, the
GPT-5.x routes, and the `commandcode-messages` Claude routes — publish `max` or
`xhigh` rungs with no clamp of their own and are in the same unproven position;
none of them has a measured Command Code effort vocabulary behind it.

`ollama-cloud/glm-5.3-flash` is checked in as candidate registry metadata with a
model-scoped request profile that clamps both flat and nested reasoning effort
onto the same `low`/`high`/`max` ladder. It must not be called certified until
the public slug passes the router-level exact-route suite for basic, streaming,
forced-tool, stateless tool-result, and compact requests with failover disabled.

`ollama-cloud/glm-5.3` is also checked in as candidate registry metadata on the
same low/high/max ladder and the sibling `ollama-cloud-glm-5-3` clamp profile,
advertising 1,000,000 context and an 880,000 conservative compact threshold
matching the existing Ollama Cloud GLM-5.2 policy. It requires its own run of
the router-level exact-route suite before it is called certified. That
threshold is not a provider-measured boundary. It is text-only: GLM-5.3's
multimodal variant is GLM-5.3-Flash, so the full-size route declares `text`
modality instead of inheriting Flash's image path.

Every GLM-5.3-Flash route therefore declares `["text", "image"]`, and the
exceptions were the mistake. Z.ai files this model under its vision-language
guides and gives its input modality as `Video / Image / Text / File`, documents
the `image_url` content block for it, and says it is fully available on the GLM
Coding Plan; OpenRouter's own catalog publishes `["text","image","video"]` for
`z-ai/glm-5.3-flash`. Three routes nevertheless shipped text-only — the two
Z.ai ones and OpenRouter's — because each entry was written fresh when the
withdrawn Ox Alpha preset was replaced and took the conservative default rather
than the preset's measured modality set, with no note saying otherwise (#756).
A text-only declaration is not inert: `bridgeVisionInput` in `src/router.mjs`
reads exactly this field, so it spent a second model's quota transcribing every
pasted screenshot for a model that could read it directly, and the catalog told
Codex the route was text-only. Two things about the Coding Plan endpoint are
worth keeping straight, because they look like counter-evidence and are not.
Z.ai's Vision MCP Server is an addition for Coding Plan users, not a substitute
for a modality the endpoint lacks — its own page says a pasted image bypasses
it because the client "will by default transcode the image and call the model
interface directly". And the `Uncheck Support Images` line in the Cline and
tool-integration guides is written against `glm-5.2`, which is text-only; those
pages do not mention GLM-5.3-Flash at all. Z.ai publishes no modality table for
`api/coding/paas/v4` in either direction, so the endpoint's acceptance of an
image is documented only at the model level. A route that claims a modality it
cannot serve trades a bridged read for a 400 on the whole turn, and it becomes
a bridge **engine** for other text-only models as well, so a future Flash route
on a new reseller is sourced from that reseller's own catalog rather than
inherited from this paragraph.

## Union Alpha on OpenCode Go Messages must compact above the tool floor

OpenCode publishes Union Alpha (`union-alpha` on `/zen/go/v1/messages`) with a
262,144-token window and a 131,072-token output. Compact-at-window-minus-output
is 131,072. Console Go also tokenizes independently of Codex and 400s when the
prompt plus completion does not fit any backend (`Prompt too long … including
the completion`, later `about 434983 tokens estimated` against 262,144). That
is not quota and not a truncated tool-call repair. Do not classify it as
`out_of_usage`. Do not invent effort rungs: OpenCode documents reasoning but
publishes `reasoning_options=[]`, so the stored ladder stays the conservative
single `high`.

Do not compact below the unavoidable Desktop prefix. Live Union Alpha turns
report ~88–108k cached input tokens from the tool list alone. Compact-at-80,000
therefore fired after every skill read, kcr2 kept a 1,024-byte source excerpt,
and the model re-read ImageGen in a loop. The checked-in route keeps the
advertised 262,144 window and compacts at 180,000, above that floor. The
Messages hop always sends `max_tokens` / `max_output_tokens` at 32,768 —
OpenCode's own completion reserve — including when Codex omitted the field,
so a compact request cannot re-reserve the model's advertised 131,072 output.
The catalog publishes that same 32,768 as `maxOutputTokens` (OpenCode client
`limit.output`) so a local `rendered + output > window` check cannot refuse a
prompt the hop would have accepted. Do not copy that cap onto OpenRouter or
Cline Union Alpha routes without their own evidence.

OpenCode's tokenizer can still count a thread above 262,144 when Codex reports
~90–120k. Compact overflow may retry a larger-window model, including a
same-family OpenCode Go 1M route such as `opencode-go/glm-5.3-flash`, without
recording a provider cooldown. Compact failures are translated to
`context_length_exceeded` rather than echoing LiteLLM's model-group wrapper.
Ordinary turns still never swap on HTTP 400. If nothing configured can hold
the prompt, start a new Codex task. Do not copy this hop onto turn failover.

Console Go also 400s when a single `messages[N].content` exceeds 2,500,000
characters. A live ImageGen function_call_output (1536×1024 PNG, 2.03 MiB,
2,707,238-character data URL) was stored by Codex, then the next Union Alpha
turn failed with `messages[9].content exceeds maximum length of 2500000`.
The Chat Completions image hoist keeps those bytes and still overflows. The
OpenCode hop replaces an oversized image payload with a labeled stub so the
turn can finish; it does not invent image bytes and does not copy this cap
onto OpenRouter or Cline. This is not `context_length_exceeded` and is not
quota.
