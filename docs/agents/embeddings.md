# Embeddings route

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Embeddings are a separate, explicitly gated route

1. **A model grants the capability, never a provider name.** `/v1/embeddings`
   accepts only a registered routed model whose `supportedEndpoints` includes
   `/embeddings`. Discovery metadata is untrusted and cannot add that field.
2. **Endpoint-only models are not chat models.** A model that omits its
   provider's conversational endpoint must be `listed: false`; otherwise the
   registry refuses it before the Codex picker can advertise a broken turn.
3. **No chat adapter and no LiteLLM hop.** The router rewrites the public slug
   to the gateway id and calls the internal API forwarder. The forwarder
   rewrites only that id to the upstream model and preserves the remaining
   embeddings JSON. Do not normalize the body as Chat Completions or Responses.
4. **The caller secret never leaves loopback.** Query parameters on the
   capability URL are dropped, only a bounded request id may cross the internal
   hop, and the API forwarder replaces internal auth with the provider's own
   credential inside its established boundary. Both the router-to-forwarder
   and forwarder-to-provider hops refuse redirects so a 307/308 cannot replay
   the POST body onto another destination.
5. **Bound and cancel both directions; never retry.** The public request and
   provider response default to 8 MiB limits, and client cancellation aborts
   both hops. A transport failure may occur after the provider billed the
   input, so automatic replay is not safe without provider-specific evidence.
6. **Every future endpoint is a new protocol review.** This slice does not
   authorize completions, moderation, media, files, or batches. Each needs its
   own capability, wire contract, limits, cancellation, idempotency, and
   retry/stream-commit evidence.
