# Vision bridge

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Vision bridge for text-only models

The router can let a text-only model answer about a pasted image: the routed
request path sends each image part to a vision-capable model the operator has
already enabled and credentialed, and substitutes the returned transcript into
the turn as text. Treat it as a router capability, never as a model capability.

1. It is **on by default** and off only when the operator says so
   (`bin/control vision-bridge off`, protected state in `vision-bridge.json`).
   Reading a pasted screenshot is the one thing people expect to work without
   finding a toggle, and everything it needs is already installed: an install
   with nothing to read images with resolves no engine and degrades exactly as
   it did before the bridge existed, so the default costs an unequipped machine
   nothing.
   - The line between "never configured" and "configured off" is **structural,
     not a sentinel**: no state file means nobody has answered and the current
     default applies; a readable file's `enabled` is the operator's own answer
     and is taken verbatim forever. A stored `false` must never be re-enabled by
     a change of default. A file that exists but this build cannot parse falls
     back to **off**, not to the default — somebody was here and we cannot tell
     what they chose, so it must not start spending quota.
   - `version` stays `1` on purpose. A bump would have to guess what an older
     `false` meant, and there is nothing to guess with; file presence already
     answers it, and `visionBridgeConfigured()` has gated exactly that
     distinction since the bridge shipped. Do not add a migration that replaces
     that fact with an inference.
   - The installer writes no bridge state at all. It used to auto-enable once
     when a vision-capable provider happened to be selected, which made the
     file's presence mean "the installer ran" and left every other install
     needing a command nobody knew about. It now only reports. Never write
     bridge state from an install or update path; a routed image spends the
     engine provider's quota, so the only writers are the operator's own
     commands.
   - Because it is on by default, a surface that would nag an unconfigured
     install checks `visionBridgeConfigured()` first. `doctor` warns about "no
     resolvable engine" only for an operator who actually asked; for a
     default-on install it reports `ok`, since nothing was lost.
2. The registry keeps declaring what each model itself reads. `inputModalities`
   is never edited to add `image` for a bridge, and `visionBridge` accepts only
   `false`, as a per-model opt-out. The registry loader rejects `true` so the
   file can never assert a capability the model lacks.
3. The catalog advertises image input on a bridged model only while an engine
   actually resolves from the selected, credentialed, listed set. When the
   bridge is off, or the pinned engine disappears, the advertisement goes with
   it — Codex gates the paste on `input_modalities`, so a stale advertisement
   would leave a paste that nothing can serve. Rebuild the catalog after every
   change and tell the user to fully quit and reopen Codex.
   `resolveVisionEngine` takes that set as a **function**, never as an array,
   and rejects an array outright. Assembling it means probing every provider's
   credential synchronously — on macOS one `/usr/bin/security` spawn per
   provider per keychain service, ~250ms with the event loop stopped — while two
   of the three answers (bridge off, engine pinned to `local`) never look at a
   candidate. On the request path that cost was paid per pasted image and
   blocked every other in-flight request. Deferring narrows nothing: what gets
   ranked is still exactly the selected, credentialed, listed set. A lazy list
   that skips the credential check is a security regression, not a speedup.
4. A registry engine's call goes through the same gateway, credential, and
   request profile as any other routed turn. Do not add a second upstream path,
   a separate vision API key, or an external CLI dependency for a hosted engine.
   The one sanctioned exception is the local engine (`vision-bridge local`): a
   vision model the operator runs themselves (Ollama, LM Studio, llama.cpp). It
   lives outside the registry, so the request path calls its
   `/v1/chat/completions` endpoint directly with no credential, and it is used
   only when explicitly pinned — auto mode never routes images to `localhost`,
   since an unreachable server would fail every paste. The rule is about the
   address, not about that one engine: a **keyless registry provider** (`local`,
   and the loader guarantees keyless means a loopback `baseUrl`) is the same
   hazard wearing a registry slug, so `resolveVisionEngine` excludes every
   loopback-served candidate from auto and admits it only by explicit pin. It
   stays listed in the picker, because choosing it carries the knowledge that
   the server has to be up. Auto mode is the only default an unattended machine
   gets, so it may only nominate an engine that is reachable without the
   operator having started something. This is what lets a
   text-only-only install enable the bridge with no paid vision model. The
   `vision-bridge setup` command and probe target Ollama for auto-download
   because it is a managed daemon with a stable model registry — the only
   runtime where "install once and it keeps working" holds. llama.cpp and LM
   Studio remain first-class manual engines (the probe detects both, and
   `vision-bridge local <model> <baseUrl>` pins either); the installer never
   installs a runtime or pulls a multi-gigabyte model without explicit consent
   (`setup` requires `--yes` before any download). A model download runs
   detached (`src/vision-download.mjs` streams Ollama's `/api/pull` and records
   progress in `vision-download.json`): `pull` returns at once and `pull-status`
   reports the percentage, because a synchronous multi-gigabyte pull freezes
   the tray and reads as a crash. The worker pins the model only after it is on
   disk, so a failed or interrupted download never repoints the bridge at a
   model that is not there.
5. The second sanctioned exception is a **native engine**: a vision model from
   the operator's own signed-in ChatGPT plan, reached over the native path the
   router already owns (`NATIVE_BASE`) with the caller's own session headers.
   It is permitted because it introduces nothing — no stored credential, no
   separate vision API key, no external CLI, no install step, nothing to
   download — and because it spends a plan the operator already pays for, on a
   backend the router already talks to on every native turn. That is the whole
   justification. These conditions are what keep it from widening into
   something else, and each one is load-bearing:
   - **No new credential, ever.** A native engine carries the caller's session
     and nothing else: the fixed `FORWARD_HEADERS` allowlist, copied from the
     request in hand and sent only to the hardcoded `NATIVE_BASE`. The router
     must never store, cache, mint, or read a credential for this path, and the
     gateway's internal key must never travel to that backend. An engine that
     would need a key the router does not already hold is not this exception.
   - **Fail closed when there is no caller session.** No session on the request
     means no native engine: not a candidate, and a pin naming one does not
     resolve. Never fall back to the gateway for a native slug — it holds no
     credential for one — and never accept an on-disk capture as evidence that
     the session is still good. `native-models.json` and `merged-models.json`
     are both reused deliberately when a fresh probe fails, so a sign-out leaves
     them naming an engine that can no longer be called. Signing out has to stop
     the engine resolving on the very next paste, not at the next catalog
     rebuild. Cached transcripts are part of this: a native transcript is keyed
     to the account that bought it, because a cache hit skips the call and with
     it every check that this session may still spend that model.
   - **This is not a general bypass.** It licenses one destination and one
     credential: the router's own native path, on the caller's own session. It
     is not a precedent that any hosted engine may skip the gateway once its
     credential story sounds tidy. Item 4 stands unchanged for every registry
     engine — a hosted engine that would bring a second upstream, a separate
     vision key, or an external dependency goes through the gateway or does not
     ship.

   Known gap: **plan quota and limits** spent this way are still not surfaced.
   Every bridged read now records a usage event through the shared pipeline
   (model, provider, status, duration — no token counts, because the request
   path receives the transcript rather than the envelope) and logs one
   never-quieted line, so the operator can tell a vision call happened and
   against what. What is still missing is the other half of what "Ship a new
   provider to every installer" requires of everyone else: the ChatGPT plan's
   remaining quota does not move in the tray when a screenshot is transcribed,
   and no surface renders routed usage events at all. It is being closed
   separately. Do not read it as settled, do not weaken this section to
   accommodate it, and do not extend the exception to another engine while it is
   still open.
6. Substituted transcripts are untrusted user data. Keep them fenced and
   labelled as quoted image content, never log a transcript or a gateway error
   body, and keep the per-image failure path degrading to a stated failure
   rather than a failed turn. A stream that fails partway through is a failure,
   not a short transcript: deltas already in hand are discarded rather than
   returned, because a plausible truncated transcript is quoted downstream as
   though it were the whole image.
7. Evidence, not impressions. The instruction set asks for a transcript, a
   layout list, readable data values, and an explicit uncertainty list, so the
   downstream model quotes rather than guesses. Preserve the uncertainty
   section in any rewrite.
   - `## Identification` is the **one** section where inference is allowed, and
     it exists because a pure transcription contract cannot answer "what is
     this?" — which is the most common thing anyone asks about a pasted image.
     Without it the reader described a photo it plainly recognized, and the
     routed model went looking on the internet, uploading the operator's
     screenshot to a public host on the way. Keep it separate from `## Text`,
     keep it required, and keep `(unrecognized)` as the answer when nothing is
     recognizable. Inference belongs in one labelled place, never spread
     through the sections that claim to be a reading.
8. The reader is asked what the operator wants to know, and asked **again when
   that changes**. Pinning the question to the image's own message kept the
   cache still and made an image's reading a snapshot of the first thing ever
   asked about it. The newest image follows the newest question instead. Three
   properties keep that affordable, and all three are load-bearing:
   - Bought once per *question*, never per turn: a question already asked is
     served from the record, so Codex resending the conversation is free.
   - Only the **newest** image follows the conversation. Older images keep the
     question they were read for, so a chat holding ten screenshots cannot turn
     one new question into ten new reads.
   - The record accumulates, so an earlier answer survives a later question.
   The question itself is the operator's words only: Codex's `<image …>` wrapper,
   its `# Files mentioned by the user:` preamble, and its context blocks
   (`<environment_context>`, `<recommended_plugins>`) are bookkeeping, and
   sending them produced transcripts written about a filename.
9. Resolving an engine and **reaching** it are different questions. The reader
   is a short list — the operator's choice first, then the other credentialed,
   non-loopback vision models — and an image is offered to the next one when the
   first cannot be reached. A 401 from a lapsed session and a 503 from a
   provider outage both turned every paste into "could not be read" while the
   engine still resolved perfectly. What the fallback must not become:
   - **Silent.** The evidence header names the engine that actually read the
     image, and the per-turn log line records `fellBack`.
   - **A way around a pin.** A pin that does not *resolve* is still an
     operator-visible problem, never a quiet switch to another model, and a
     pinned **local** engine never falls back onto a provider's quota nobody
     chose to spend.
   - **Expensive.** The list is capped, the candidate set is still built at most
     once per turn, and a second engine is only ever called after the first has
     failed — so a working engine costs exactly what it did before. Another
     provider is tried before another *attempt* at a broken one: retries are
     spent only on the last engine in the list, because waiting out a retry
     ladder against a dead endpoint while a working engine sits behind it is
     how a fallback that works becomes a paste that takes half a minute.
10. A read that fails **transiently** is asked again — twice, at 250ms and 1s.
   The engine is a rate-limited account across a network, and losing an image
   for the whole turn to a 429 that would have cleared in a second is the
   opposite of what the bridge is for. What is not retried is equally
   deliberate: 4xx refusals buy the identical refusal, and a timeout is reported
   rather than retried because the per-attempt budget is already two minutes. A
   transport failure keeps the transport's own wording ("fetch failed"), which
   is how an operator learns their own loopback engine is down.
   - A reading that came back **incomplete** says so in its own header. The
     downstream model cannot otherwise tell "the image does not show that" from
     "the transcript does not mention it", and it answers the first with
     confidence either way. `## Data` is optional by contract and its absence is
     not a bad read. The two causes are reported differently on purpose: a read
     cut off at the size cap left a large image genuinely unread, so it is the
     one case that invites a second look; missing sections mean the engine does
     not follow the format at all -- a small local model answering in prose --
     and reading again returns the same shape, so an invitation there buys a
     loop rather than an answer. Never advertise a second look on every image.
11. Every image the router carries is read, in **both** places Codex puts one:
   parts of a user message, and the `output` of a `function_call_output`. A
   text-only model that has just been handed a transcript still sees the file's
   path in the turn and calls `view_image` on it, and that tool result holds the
   same bytes again. Missing it hands a raw data URL to a provider that rejects
   the whole conversation with an error naming no image
   (`unknown variant image_url, expected text`). Two consequences are load-bearing
   and must survive any rewrite:
   - **Say which file the transcript is of.** A pasted image takes the path from
     Codex's own `<image … path="…">` wrapper, a tool result from the
     `view_image` call that asked for it. Without that link the model pays a tool
     turn plus a full resend of the conversation to open a file it has already
     been given — far more than the read cost. That wrapper is markup, not the
     operator's words, so it is stripped from the question sent to the engine.
   - **A tool result inherits the question that led to it**, so a `view_image`
     round trip lands on the transcript the paste already bought instead of
     buying a second one. It is also the only way a *later* question gets a
     freshly focused read, since the question pinned to an image is the one in
     its own message.
12. An image's evidence is **one record per image, not one transcript per
   question**. The question still decides whether a read has to be bought;
   what gets injected is every reading the router holds for that image. Filing
   one transcript per (image, question) and injecting only the matching one made
   the evidence a snapshot of the first question ever asked, which a later
   question could not add to. Keep the record append-only, keep the first
   (general) reading undroppable when the cap bites, and keep the whole record
   inside the budget a single transcript used to have. When one turn carries the
   same image twice — the paste and the `view_image` result — only the first
   slot prints the record; the rest point at it. That pointer is keyed on the
   image, never on matching transcript text: two different screenshots can read
   identically, and "the same image" has to be a fact about the bytes.
13. One image, one purchase. The transcript cache only knows about reads that
   have **finished**, so concurrent requests — Codex sends them, and a subagent
   runs beside its parent — all missed and all bought the same transcript. Reads
   in flight are shared by image, effort, account, and question; waiters take the
   first read's outcome including its failure, and the shared read is never tied
   to one caller's `AbortSignal`, or one client's cancellation would cost a live
   request an image. Reads within a turn run concurrently under a fixed cap: the
   operator waits for all of them before the routed turn starts, but the engine
   is somebody's rate-limited account and must not receive an album as a burst.
14. Never add a local model to `LOCAL_VISION_CATALOG` with an `accuracy` claim
   that was not measured. Run `node src/vision-benchmark.mjs`, which scores a
   model against a checked-in image with known contents, and record the result
   in `measured`; anything unmeasured stays `untested`. This is not bureaucracy:
   `llava` scores 0% and `moondream` 0% on text while sounding entirely
   plausible, so a reputation-based label would route users straight to a model
   that fabricates invoice numbers. The picker sorts on this field, so an
   unearned "accurate" puts a confident-wrong reader at the top of the list.
15. Which native models may read an image is one rule in one place
   (`src/vision-engines.mjs`), not a criterion each surface re-derives. The
   catalog build, the tray, and the request path each asked it separately once,
   and the three answers disagreed — the request path applied no auth gate at
   all. The rule is shared; only the evidence for the gate differs, because just
   one caller can afford to ask Codex directly (`codexAuthStatus()` spawns a
   process) and only the request path holds the caller's live session. Every
   call site names its evidence explicitly, and the coverage below fails when
   one of them stops.
16. The bridge lives on the **routed request path only**. `src/api-forwarder.mjs`
    sits downstream of the gateway — every routed model's `api_base` points at
    it — so Codex's traffic arrives already bridged and an image reaching that
    hop came from a client talking to the gateway directly. It replaces those
    parts with the same stated failure rather than reading them: an engine call
    from there would re-enter the gateway that is holding the request open. The
    substituted part must use the protocol's own text type (`input_text` for
    Responses, `text` for chat completions and Anthropic messages), or an image
    the provider rejects is merely traded for a text part it rejects.
17. Regression coverage lives in `test/vision-bridge.test.mjs`,
    `test/vision-bridge-state.test.mjs`, the bridged-catalog case in
    `test/catalog.test.mjs`, the whole-path measurements in
    `test/vision-bridge-e2e.test.mjs`, and the router cases in
    `test/routing.test.mjs`. A change to engine ranking, caching, substitution,
    the native gate, or the advertisement rule needs a test there. The two
    properties worth stating as tests rather than prose: nothing image-shaped
    may survive into a forwarded body, and one image asked one question may be
    bought only once however many requests are in flight.
