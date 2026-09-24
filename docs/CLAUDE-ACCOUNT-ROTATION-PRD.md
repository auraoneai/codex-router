# PRD: Claude Subscription Account Pool & Rotation for codex-router

**File:** `docs/CLAUDE-ACCOUNT-ROTATION-PRD.md`
**Status:** Draft — awaiting operator approval
**Date:** 2026-09-24
**Related:** `docs/CHATGPT-ACCOUNT-ROTATION.md` (the pattern this ports), `docs/CHATGPT-ACCOUNT-MODES.md`

---

## 0. One-paragraph summary

Give codex-router the same multi-account pooling for **Claude subscription accounts** that it already has for ChatGPT/Codex accounts: register several Claude OAuth logins, let the router pick the eligible account per request, rotate on quota exhaustion before the client ever sees a 429, and track each account's 5-hour/weekly windows passively from Anthropic's own rate-limit headers. This is **not** generic API-key pooling (that already exists as `provider-api-key-pool`); it is subscription-account pooling, deliberately modeled on the proven `chatgpt-account-pool` / `chatgpt-rotation` machinery.

---

## 1. Background & research findings

### 1.1 What the external tools do (verified from source, not READMEs)

| Concern | claude-swap (realiti4) | teamclaude (KarpelesLab) | Relevance to us |
|---|---|---|---|
| Shape | CLI switcher: rewrites the *active* credential in the Claude Code credential store; `cswap run N` gives one parallel session per terminal | Local proxy between Claude Code and api.anthropic.com; injects the chosen account's OAuth token per request | We are already a proxy — teamclaude's per-request injection matches our architecture; claude-swap's switcher does not |
| Credential source | Reads Claude Code's own `claudeAiOauth` blob (accessToken, refreshToken, expiresAt, optional refreshTokenExpiresAt) | Same blob via `teamclaude import` or its own browser OAuth | We import from Claude Code — zero new OAuth plumbing |
| Token refresh | POST platform.claude.com/v1/oauth/token, JSON body with grant_type/refresh_token/client_id; rotates refreshToken when the response includes one; classifies invalid_grant/invalid_client as permanent, all else transient | Same endpoint; refreshes tokens within 5 min of expiry and persists them | Constants in §4.2 |
| Quota telemetry | Polls GET api.anthropic.com/api/oauth/usage with anthropic-beta: oauth-2025-04-20; adaptive polling, 429 backoff | **Passive**: reads response headers anthropic-ratelimit-unified-* on every real response; persists to state; probe optional | Passive-first matches our rate-limit-headers.mjs philosophy |
| Rotation trigger | 5h/7d utilization crossing a threshold (default ~90%), hysteresis margin, cooldown | Threshold 98% default; quota-429 (unified status rejected) → switch; per-minute rate-limit 429 → **pace, do not rotate** (rotating kills prompt cache and throttles the sibling); headerless 429 → one hop + one 2s retry | Port both the trigger table and the 429 taxonomy |
| Selection | most-quota-left / consume-first (soonest weekly reset) strategies | lowest priority number, then soonest weekly reset; per-model weekly buckets (Fable 7d_oi) ranked separately | Our affinity + purpose-pin ranking is already richer; keep ours, add two-window quota ranking |

Exact unified header names (from teamclaude account-manager.js, updateQuota):

- `anthropic-ratelimit-unified-5h-utilization` (0–1 fraction)
- `anthropic-ratelimit-unified-7d-utilization`
- `anthropic-ratelimit-unified-5h-reset` (epoch **seconds**)
- `anthropic-ratelimit-unified-7d-reset`
- `anthropic-ratelimit-unified-7d_oi-utilization` / `-reset` (Fable weekly, "7-day overage-included"; rides Fable responses only; can exceed 1.0 in overage)
- `anthropic-ratelimit-unified-status` = allowed | allowed_warning | rejected, plus per-window `-5h-status` / `-7d-status` / `-7d_oi-status`
- Classic API-key windows `anthropic-ratelimit-tokens-*` / `anthropic-ratelimit-requests-*` are already parsed today

Key behavioral findings worth porting:

1. **Two kinds of 429** (teamclaude docs/routing.md): a *quota rejection* (unified status rejected; spent 5h/7d bucket) switches accounts; a *rate-limit 429* (per-minute throttle with retry-after) pauses the account briefly and retries the same account — rotating would move the burst and discard the prompt cache. A *headerless 429* (no retry-after, no anthropic-ratelimit-* at all) is request-scoped: one hop to an idle sibling, one 2s retry, then surface to the client.
2. **Self-sealing family buckets**: 7d_oi headers ride only Fable responses. A spent Fable reading must be trusted for a bounded staleness window (teamclaude: 30 min) then dropped, so a reset is rediscovered instead of stranding the account forever. The optional probe sidesteps this entirely.
3. **Entitlement denials**: a 403 whose structured error code is oauth_not_allowed_for_organization fails the request over to another account and quarantines the account for 5 minutes (org policy, not a dead token). Other 403s fail over without quarantine.
4. **claude-swap's refresh error taxonomy** (oauth.py): permanent = HTTP 400/401/403 **with** a top-level JSON error of invalid_grant or invalid_client; everything else (network, 5xx, unparseable) is transient. invalid_client is systemic (our client id blocked) and must not strike the account.
5. **Identity**: GET api.anthropic.com/api/oauth/profile with the access token returns account.uuid / email / organization.uuid — used to label accounts and de-duplicate registrations of one identity.
6. **Keychain precedence on macOS** (teamclaude oauth.js readKeychainCredentials): security find-generic-password -s "Claude Code-credentials" — try -a (current username) first, then service-only; skip items whose payload lacks a token (Claude Code leaves a stray acct="unknown" item carrying only mcpOAuth). On Linux/Windows the file is ~/.claude/.credentials.json.

### 1.2 What codex-router already has (the template)

- `src/chatgpt-account-pool.mjs` (889 lines): locked pool state (proper-lockfile), per-account isolated homes, registration/identity/health normalization, schema versioning, sanitize* redaction for status surfaces.
- `src/chatgpt-rotation.mjs` (522 lines): rotationCandidates() per-request header injection, conversation affinity (rememberAccount / rememberedAccount, 24h TTL, 200 entries), cooldowns, markAccountAuthInvalid with token fingerprints, purpose pins (personal/auraone/veerone/foundation/reserve), orderAccountCandidates ranking (sticky → confirmed-quota → plan → preferred → purpose → registration order).
- `src/chatgpt-usage-probe.mjs` (205 lines): cached quota reads, nextKnownResetAt, reset-aware scheduling.
- `src/router.mjs`: rotatedNativeHeaders() hook (line ~1097), coolNativeAccount() (~1051), conversationKey() (~956), cachedAccountUsageById() (~1014), emergency/reset-aware probe scheduling.
- `src/claude-surface.mjs`: the /anthropic protocol leaf. Claude Code → /anthropic/v1/messages → translated to a Responses payload → re-enters this router's own /responses (router.mjs line ~6477). **The Claude-facing credential choice happens downstream in api-forwarder.mjs when the provider for the routed slug resolves.**
- `src/api-forwarder.mjs`: upstreamHeaders() (line ~1478) — the branch at ~1508 sends x-api-key + anthropic-version for provider.protocol === "anthropic". Credential selection: resolveProviderApiKeyForRequest() (~line 1839; single key today, provider-api-key-pool when configured), attempt loop runProviderApiKeyAttempts (pool) vs single-attempt path (~line 2092).
- `src/rate-limit-headers.mjs`: parses x-ratelimit-* and anthropic-ratelimit-requests-*/-tokens-* today. **Does not parse the unified windows yet.**
- `src/claude-code-launcher.mjs` + `src/claude-code-config-manager.mjs`: Claude Code points at the router via ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN; nothing about accounts needs to change there.
- Provider: `config/anthropic/anthropic.json` defines anthropic-api (kind openai-compatible, protocol anthropic, baseUrl https://api.anthropic.com/v1, credential file anthropic-api-key.secret, keychain service codex-router-anthropic-api). One curated model today: anthropic-api/claude-opus-4.8 (request profile anthropic-reasoning).

### 1.3 The one real wire difference

| | ChatGPT native rotation | Claude subscription rotation |
|---|---|---|
| Auth headers | Authorization: Bearer (access) + chatgpt-account-id | Authorization: Bearer (OAuth access) + anthropic-beta: oauth-2025-04-20; x-api-key must be absent |
| Credential per account | home/auth.json → tokens.access_token | home/credentials.json → claudeAiOauth.accessToken |
| Quota headers | x-ratelimit-* (OpenAI) | anthropic-ratelimit-unified-* (subscription) |
| Quota probe | Codex app-server usage probe | GET /api/oauth/usage (optional phase 2) |
| Refresh | Codex desktop owns refresh for its live login; pool leaves it alone | **The router owns refresh for every pooled account** (Claude Code refreshes only its own active login) |
| Account identity claim | tokens.account_id | OAuth profile account.uuid (+ email, org) |

---

## 2. Goals / Non-goals

### Goals
1. Register N Claude accounts; each keeps an isolated credential home; nothing under ~/.claude is ever written by the router.
2. Per-request account selection on the anthropic-api provider path with the same semantics as ChatGPT rotation: conversation affinity, purpose pins, drain/cooldown/auth-invalid handling, and rotation that never fails a request (every error falls back to the credential the router had without it).
3. Passive quota learning from anthropic-ratelimit-unified-* on every real response; persisted; survives restarts.
4. Automatic token refresh (5-minute expiry margin) per account, persisted back to the account home; refresh-token rotation honored; permanent-vs-transient classification per §1.1(4).
5. In-flight failover on quota rejection so the client never sees a 429 while any sibling has headroom (same nothing-relayed-yet contract as the native path).
6. Control surface: control claude-account-pool status|add|remove|select|enable|disable|usage — JSON output, redacted (presence, ids, emails only; never token material).
7. Tray parity: the anthropic-api card shows pooled accounts and per-account "% left" per the AGENTS.md ship-provider checklist.

### Non-goals
- No own OAuth login flow (Claude Code remains the login tool; we import).
- No MITM/forward-proxy catch of hardcoded api.anthropic.com clients (teamclaude feature; out of scope).
- No per-model route pins, advisor routing, adaptive session spreading, burn-rate learners, or hold-on-exhaustion (teamclaude fleet features) in v1 — affinity already covers single-operator use.
- No changes to the ChatGPT pool, the generic API-key pool, or any other provider.
- No claude-swap-style parallel session launching — the router serves all clients already.

---

## 3. Architecture

```
Claude Code ──/anthropic/v1/messages──▶ claude-surface (translate)
                                            │ re-enter /responses (unchanged)
                                            ▼
                                     router /responses ──▶ api-forwarder
                                                              │ model resolves to provider anthropic-api
                                            ┌─────────────────┴──────────────────┐
                                            ▼                                    ▼
                            claude-account-rotation.mjs            legacy single API-key path
                            (picks account, returns headers)       (unchanged fallback)
                                            │
                                            ▼
                             upstreamHeaders() OAuth branch:
                             Authorization: Bearer (access)
                             anthropic-beta: oauth-2025-04-20
                                            │
                                            ▼
                              api.anthropic.com/v1/messages
                                            │
                                            ▼
                          response headers → claude unified quota learner
                          (rate-limit-headers.mjs + claude-account-usage.mjs)
```

Integration point decision: rotation is wired **inside api-forwarder.mjs** where the provider is already resolved (the same place resolveProviderApiKeyForRequest runs), *not* in router.mjs's native path (that one is ChatGPT-specific and keyed on the inbound authorization + chatgpt-account-id passthrough). Claude Code calls the router with the router's caller key; there is no native Anthropic credential on the inbound request to rotate around — the router supplies it.

### 3.1 New state files (under ~/.codex/codex-router/, mirroring the ChatGPT pool)

| Path | Contents |
|---|---|
| claude-account-pool.json | version:1, policy (enabled, mode "switch", selectedAccountId?), accounts map |
| claude-accounts/(accountId)/credentials.json | the full imported claudeAiOauth document (private file, 0600) |
| claude-account-usage.json | fetchedAt + per-account fiveHour/weekly/fable windows, authInvalid, plan, email — same cache-shape convention as chatgpt-account-usage.json |

Account id format: clacct_ + 16 base62 chars (distinct prefix from ChatGPT's acct_ so the two pools can never be confused).

### 3.2 Pool account record schema

```jsonc
{
  "id": "clacct_...",
  "state": "active",            // active | paused | revoked
  "paused": false,
  "priority": 50,
  "label": "me@example.com",    // from OAuth profile; operator-editable
  "purpose": null,              // same vocabulary as chatgpt: personal|auraone|veerone|foundation|reserve
  "createdAt": "ISO",
  "identity": { "accountId": "(oauth uuid)", "email": "...", "organizationUuid": "..." },
  "subscription": { "status": "pending|usable|expired|invalid", "plan": "pro|max5|max20|team|unknown" },
  "health": {
    "state": "healthy|cooldown|reauth-required|failed",
    "cooldownUntil": "ISO", "lastSuccessAt": "ISO", "lastErrorAt": "ISO",
    "lastStatus": 429, "lastError": "..."
  },
  "turns": 0, "requests": 0
}
```

---

## 4. Wire-level specification

### 4.1 Outbound auth (the upstreamHeaders() change)

When the resolved credential carries authKind === "claude-oauth":

```
Authorization: Bearer (accessToken)
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

When it carries an API key (today's path): unchanged x-api-key + anthropic-version. The two must never mix: an OAuth account must not send x-api-key, and the API-key path must not gain the beta header.

### 4.2 Token refresh

- Endpoint: POST https://platform.claude.com/v1/oauth/token
- Body: grant_type "refresh_token", refresh_token, client_id "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
- On success: replace accessToken; expiresAt = now + expires_in*1000; replace refreshToken when the response supplies one; store scopes when supplied; persist the whole document atomically (writePrivateJsonAsync semantics) into the account home.
- Failure classification (claude-swap taxonomy): HTTP 400/401/403 **and** top-level error in the JSON body → invalid_grant marks the account reauth-required (excluded from rotation until re-imported); invalid_client is systemic — log, do not strike the account; anything else (network, 5xx, unparseable) → transient: retry with backoff, account stays eligible with its current (possibly stale) access token.

### 4.3 Identity resolution

GET https://api.anthropic.com/api/oauth/profile (Bearer token). Usable only when account.uuid is a non-empty string; email/org optional; any other shape = unresolved (advisory only, never blocks import).

### 4.4 Passive quota learner

Extend rate-limit-headers.mjs with parseClaudeUnifiedHeaders(headers) returning:

```js
{
  fiveHour: { usedPercent, remainingPercent, resetsAtMs },   // -5h-utilization / -5h-reset
  weekly:   { usedPercent, remainingPercent, resetsAtMs },   // -7d-*
  fable:    { usedPercent, remainingPercent, resetsAtMs, seenAt }, // -7d_oi-*, Fable responses only
  status:   "allowed|allowed_warning|rejected",              // -unified-status
  windowStatuses: { fiveHour, weekly, fable }                // per-window -status values
}
```

Rules ported from teamclaude:
- reset headers are **epoch seconds** → ms; non-positive/NaN → absent, never stored (a NaN reset would park an account forever).
- An overall rejected status with 5h-status/7d-status both present and non-rejected is downgraded to allowed (the family bucket rejected, not the shared window).
- Spent family (fable) readings are trusted for FAMILY_STALE_MS = 30 min then dropped (§5.4 note).
- Persistence keyed by **account id**, not provider: the provider-wide rate-limit state keyed by cooldownScope(provider.id) is wrong for a pool (N accounts, one provider id). New per-account store claude-account-usage.json, written from the forwarder after the body streams (same "never in time-to-first-byte" rule as recordUpstreamLimits).

### 4.5 Optional usage probe (phase 2)

GET https://api.anthropic.com/api/oauth/usage with Bearer + anthropic-beta: oauth-2025-04-20. Read-only; does not consume message quota. Fills unknown windows, refreshes family buckets (sidestepping self-sealing), detects early resets. Adapt the ChatGPT probe's debounce/scheduling shape (scheduleResetAwareProbe, triggerEmergencyDepletionProbe, schedulePostTurnUsageProbe) rather than a fixed timer.

---

## 5. Detailed task list (build order)

Sizes are rough. Every task lists files touched and acceptance evidence. Order keeps the repo green (npm run check + npm test) after each phase.

### Phase 0 — Groundwork (no behavior change)

**[x] T0.1 Paths & constants** (~0.5h) — `src/paths.mjs`
- Add CLAUDE_ACCOUNT_POOL_PATH, CLAUDE_ACCOUNT_HOMES_DIR, CLAUDE_ACCOUNT_USAGE_CACHE_PATH beside their CHATGPT_* siblings.
- Accept: exports exist; no behavior change; npm test green.

**[x] T0.2 Unified header parser** (~2h) — `src/rate-limit-headers.mjs`, new `test/claude-unified-headers.test.mjs`
- Add parseClaudeUnifiedHeaders() per §4.4 (pure function, no persistence).
- Accept: unit tests pin the exact header names from §1.1, epoch-seconds reset parsing, NaN→absent, shared-vs-family rejection downgrade, 7d_oi above 1.0 tolerated.

**[x] T0.3 Provider registry annotation** (~0.5h) — `config/anthropic/anthropic.json`, `src/model-registry.mjs`
- Add a subscriptionCredential declaration (kind claudeAiOauth, file credentials.json) to the anthropic-api provider; extend the registry validator's field allowlist for it.
- Accept: registry loads; negative test proves an unknown extra field on another provider still fails.

### Phase 1 — Pool & credentials (no routing change yet)

**[x] T1.1 claude-account-pool.mjs** (~1 day) — new file
- Mirror of chatgpt-account-pool.mjs: withClaudeAccountPoolLock (proper-lockfile), schema version 1, strict normalize* validators (assertAllowedKeys discipline), readClaudeAccountPoolState / writeClaudeAccountPoolState / sanitizeClaudeAccountPool, createClaudeSubscriptionAccount, claudeSubscriptionAccountHome/credentialsPath, removeClaudeSubscriptionAccount, MAX_ACCOUNTS = 64.
- Discovery guard: every reader consults discoveryDisabled() first and reports "nothing found" (AGENTS.md Discovery-disabled rule 1).
- Accept: test/claude-account-pool.test.mjs (structure-copy chatgpt-account-pool.test.mjs, 674 lines): schema-validation negatives, lock contention, sanitize redaction (no token fields ever in status shapes), remove-with-live-cooldowns.

**[x] T1.2 claude-oauth-credentials.mjs (import + read)** (~1 day) — new file
- readClaudeCodeCredentials(): macOS → Keychain "Claude Code-credentials" via security find-generic-password, -a (user)-then-service-only order, token-bearing-item filter (§1.1(6)); other platforms → ~/.claude/.credentials.json. Never logs contents; parse errors classified.
- importClaudeAccount(label): capture blob → create account home (writePrivateJson) → resolve identity via /api/oauth/profile → write pool record. Re-import of an existing identity (uuid or refresh-token fingerprint) **updates in place** (claude-swap behavior) instead of duplicating.
- credentialFingerprint: sha256 of refreshToken when present (lineage identity that survives access-token rotation), else full-content hash — same idea as claude-swap.
- Accept: test/claude-oauth-credentials.test.mjs with a fake security binary and fixture files: keychain-then-file precedence, token-less stray-item skip, no-secret-leak in errors, update-not-duplicate, discovery-disabled no-op.

**[x] T1.3 claude-oauth-session.mjs (refresh + expiry)** (~1 day) — new file
- claudeOAuthSession(accountId) → { accessToken, expiresAtMs, expired, headers } (shape mirrors accountSession() in chatgpt-rotation.mjs).
- ensureFreshClaudeOAuthToken(accountId, force?) implementing §4.2 with a 5-min expiry margin, single-flight per account (in-process promise map + pool lock cross-process), transient backoff, permanent classification, atomic persistence.
- Accept: test/claude-oauth-session.test.mjs with a stubbed token endpoint: success persists rotated refresh token; invalid_grant → reauth-required; invalid_client → no strike; transient → stays eligible with stale token; expiry margin honored; two concurrent callers share one refresh (single-flight assert).

**[x] T1.4 Control surface** (~0.5 day) — `src/control.mjs` (dispatch near line 4020), new `src/claude-account-control.mjs`
- control claude-account-pool status (sanitized snapshot: accounts, health, cached quota, selected account) | add [label] | remove (id) | select (id) | enable/disable (id) | usage [cached].
- add fails with clear guidance when Claude Code is logged out.
- Accept: test/claude-account-control.test.mjs mirroring chatgpt-account-control.test.mjs; exact usage-string assertions like control.mjs:3904.

### Phase 2 — Rotation & forwarder wiring (the behavior change)

**[x] T2.1 claude-account-rotation.mjs** (~1.5 days) — new file
- Port of chatgpt-rotation.mjs semantics:
  - claudeAccountSession(accountId) — reads the home credentials.json via claudeOAuthSession; returns { accountId (uuid), accessToken, tokenFingerprint, headers { authorization, anthropic-beta } }.
  - claudeRotationCandidates(conversationId, usageById) — same filter chain: active + unpaused → session exists & not expired → identity matches pool record → not auth-invalid (token fingerprint) → de-dup by identity fingerprint (two registrations of one OAuth lineage are one quota). Own affinity maps (rememberClaudeAccount / rememberedClaudeAccount) — must not share the ChatGPT ones.
  - orderClaudeAccountCandidates — keep the ranking skeleton (sticky → confirmed-quota → preferred → purpose → registration) but replace the ChatGPT plan rank with **subscription tier weight** (pro=1, max5=5, max20=20, team tiers per §1.1; unknown between): spend the *smallest* confirmed capacity first so the big reserve is not stranded (the Claude-side mirror of "spend Plus before Pro"). Carry over DRAINED_LEFTOVER_PERCENT 0.5, SOFT_DRAIN_PERCENT 15, RESERVE_UNTIL_PERCENT 20, RESET_JUMP_PERCENT 25, COOLDOWN_MS 5min, AFFINITY_* unchanged.
  - coolClaudeAccount(id, until), markClaudeAccountAuthInvalid(id, tokenFingerprint, reason), forgetClaudeAccountAffinities(id), claudePoolExhaustionReport() for the all-drained message + earliest reset.
- Accept: test/claude-account-rotation.test.mjs (structure-copy chatgpt-rotation.test.mjs, 699 lines): affinity stickiness, drain re-admission on reset jump, auth-invalid by fingerprint, fingerprint de-dup, purpose pins, exhaustion report.

**[x] T2.2 Forwarder: credential resolution + OAuth header branch** (~1.5 days) — `src/api-forwarder.mjs` — *the core diff*
- Resolution at line ~1839: when provider anthropic-api has a configured **Claude account pool** (new claudeAccountPoolConfigured() authority check, analogous to providerApiKeyPoolStatus().configured), the pool is authoritative and the legacy single key is not used (fail-closed, same contract as resolveProviderApiKeyForRequest).
- upstreamHeaders() (~line 1478): add the OAuth branch per §4.1; the x-api-key branch becomes the explicit non-OAuth case.
- Wire rotation into the attempt flow: when pooled, replace the single-attempt path (~line 2092 branch) with a runClaudeAccountAttempts() loop modeled on runProviderApiKeyAttempts (locked re-read immediately before send, isResponseCommitted guard, per-attempt outcome recording). In-flight retry contract:
  - quota-429 (unified-*-status rejected, or 429 carrying unified headers) → try the next candidate while nothing has been relayed;
  - 401 → markClaudeAccountAuthInvalid + next candidate;
  - 403 with oauth_not_allowed_for_organization → 5-minute quarantine + next candidate; other 403 → next candidate, no quarantine;
  - per-minute 429 (retry-after present, no unified rejection) → **do not rotate**: absorb inline up to 60s, else surface 429 with the upstream retry-after;
  - headerless 429 → one hop to an idle sibling, one 2s retry, then surface.
  All guarded by the same nothing-relayed-yet check the native path uses.
- After the body streams: persist per-account quota (parseClaudeUnifiedHeaders) to claude-account-usage.json; on failure statuses record cooldowns/invalidations via coolClaudeAccount (the mirror of coolNativeAccount).
- Accept: test/api-forwarder-claude-rotation.test.mjs with a local stub upstream: header shape per auth kind (never both x-api-key and the OAuth beta header), rotation on quota-429 with a fresh candidate, no rotation on rate-limit 429 + inline absorb, 401 invalidation, quota persistence after stream, fail-closed when the pool is configured but unusable, legacy key path untouched when no pool.

**[x] T2.3 Claude surface passthrough** (~2h) — `src/claude-surface.mjs`
- No protocol change; verify count_tokens and model listing keep working when pool-served (they never touch credentials). One addition: when the pool is exhausted, the translated error carries the claudePoolExhaustionReport message (earliest reset) instead of a bare 429 — matching docs/CHATGPT-ACCOUNT-ROTATION.md §4 behavior.
- Accept: extend test/claude-surface.test.mjs (179 lines today) with the exhaustion-shape case.

**[x] T2.4 Provider-wide cooldown guard** (~2h) — `src/api-forwarder.mjs` (recordUpstreamLimits, ~line 1640)
- When a Claude pool is configured, suppress the provider-wide cooldown recording for one account's quota rejection (per-account state is authoritative; one drained account must not cool the whole provider). Per-minute provider-wide behavior stays for the API-key path.
- Accept: covered in the T2.2 test file (provider stays routable after one account's 429).

### Phase 3 — Quota learning & probe

**[x] T3.1 Per-account usage cache** (~0.5 day) — new `src/claude-account-usage.mjs`
- Write path called from the forwarder; read path for rotation + control; cachedClaudeAccountUsageById() mirroring cachedAccountUsageById() (30s in-memory TTL, 20min disk freshness, retain drained/auth-invalid rows when stale).
- Accept: test/claude-account-usage.test.mjs — stale-cache retention of drained rows, atomic write, redaction.

**[x] T3.2 Usage probe (recommended)** (~1 day) — new `src/claude-usage-probe.mjs`
- nextKnownResetAt equivalent + reset-aware / emergency / post-turn probes (§4.5). Off by default; control claude-account-pool usage without "cached" triggers a one-shot probe (read-only endpoint, but still network — documented).
- Accept: test/claude-usage-probe.test.mjs with a stubbed endpoint; debounce assertions.

### Phase 4 — Surfaces & ship-provider checklist (AGENTS.md "Ship a new provider to every installer")

**[x] T4.1 Tray & doctor** (~1 day) — `src/provider-onboarding.mjs` (pool status card for anthropic-api), `src/doctor.mjs` (pool readability check; warn-not-fail when empty), `src/support-bundle.mjs` (sanitized pool snapshot only).
- Accept: doctor test extension; manual tray smoke per DEVELOPMENT.md.

**[x] T4.2 Usage in tray** (~0.5 day) — `src/provider-account-usage.mjs` (anthropic-api branch at line ~929)
- Pool-aware metrics: per-account 5h/7d remaining from the cache; falls back to today's "showing router traffic" localOnly when the pool is empty.
- Accept: extend the provider-account-usage tests.

**[x] T4.3 Documentation** (~0.5 day)
- New docs/CLAUDE-ACCOUNT-ROTATION.md (operator doc, structure-copy of CHATGPT-ACCOUNT-ROTATION.md): lifecycle states, ranking, wire behavior, control commands, compliance note pointer.
- Update docs/HOW-IT-WORKS.md and docs/MAINTAINED-FORK.md feature list.
- AGENTS.md: add the Claude pool to the credential-reader enumeration (it is another credential reader) — one sentence, no rule changes.

---

## 6. Test & verification checklist

- [x] npm run check green after every phase
- [x] npm test green (371 test files today; +7 new files, ~2.5k new test lines expected)
- [x] git diff --check clean
- [x] **Header-shape proof** (T2.2): stub upstream asserts Authorization Bearer + anthropic-beta oauth-2025-04-20 present and x-api-key **absent** on pool requests; inverse on API-key requests
- [x] **No-secret-leak sweep**: grep the new modules' status/error paths for token material; sanitize shapes contain only fingerprints/emails/ids
- [x] **Discovery-disabled proof**: with CODEX_ROUTER_NO_DISCOVERY=1, import/status/rotation all no-op with "nothing found" (extend the test/discovery-mode.test.mjs pattern)
- [x] **Fail-closed proof**: pool configured + all credentials unreadable → 503 pool-unavailable error naming the pool, **not** a silent fallback to the legacy API key
- [x] **Rotation-never-fails-a-turn proof**: a throwing rotation dependency leaves the request completing on the legacy credential (mirror of rotatedNativeHeaders' try/catch contract)
- [x] **Rate-limit-429 no-rotate proof** (the teamclaude lesson): a burst throttle does not burn the sibling or the prompt cache
- [ ] **Live smoke** (explicit quota approval, after tests): register 2 accounts, run Claude Code through the router, exhaust one account (or force cooldown), observe automatic switch; control claude-account-pool usage shows windows learned from headers
- [x] Repo-maintainer analyzer rerun on the final diff; impact map reconciled (provider, credentials, routing, control, tray, docs surfaces all covered)

---

## 7. Rollout

1. Phases 0–1 merge with zero behavior change (no pool → no difference; legacy path byte-identical).
2. Phase 2 behind the natural gate: the pool is authoritative **only when the operator adds an account**. Existing installs with just anthropic-api-key.secret see nothing.
3. Operator onboarding: log into Claude Code with account A → control claude-account-pool add; switch account in Claude Code → add again; repeat; then select the preferred account. First turns learn windows passively; probe optional.
4. Watch router.log for the first week: rotation decisions, cooldowns, refresh events (log lines name account ids/emails only).

---

## 8. Risks & open questions

| Risk | Mitigation |
|---|---|
| ToS gray area for multi-subscription rotation (the same question ChatGPT pooling already carries) | Local-only, own credentials, no credential sharing; document next to the ChatGPT equivalent; mirror teamclaude's compliance-doc pointer without legal claims |
| Anthropic changes unified header names or the OAuth client id | Constants isolated in claude-oauth-session.mjs + the parser; parser tolerates absence (rotation degrades to order-only, exactly like the ChatGPT pool without usage data) |
| Keychain prompt fatigue on macOS | Read only at import and refresh; cache sessions in memory; port claude-swap's sticky backend-usable cache |
| Refresh storms across router restarts | Single-flight per account + a lastRefreshAttemptAt margin copied from the ChatGPT pool (ACCOUNT_REFRESH_MARGIN_MS, 24h) |
| Two router instances (desktop tray + CLI) racing the same pool | proper-lockfile on the pool state (same as the ChatGPT pool); usage cache writes atomic-rename |
| platform.claude.com vs claude.ai token endpoint drift | Pin the URL in one constant with a comment; verify both in live smoke |
| **Open:** does /v1/messages accept the OAuth token for every model your subscriptions cover (e.g. Opus on Pro)? | Live smoke with one account per plan tier before broad enablement; the entitlement-403 quarantine is the runtime safety net either way |
| **Open:** prompt-cache interaction — Anthropic caches are org-scoped; frequent rotation may reduce cache hits | Affinity already minimizes per-conversation account churn; no further v1 work |

---

## Appendix A — Constants (verbatim)

```
OAUTH_TOKEN_URL      = https://platform.claude.com/v1/oauth/token
OAUTH_CLIENT_ID      = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
OAUTH_BETA_HEADER    = oauth-2025-04-20
PROFILE_URL          = https://api.anthropic.com/api/oauth/profile
USAGE_URL            = https://api.anthropic.com/api/oauth/usage        (phase 2)
KEYCHAIN_SERVICE     = Claude Code-credentials
CREDENTIALS_FILE     = ~/.claude/.credentials.json
EXPIRY_BUFFER_MS     = 5 * 60 * 1000
COOLDOWN_MS          = 5 * 60 * 1000        (quota 429)
AUTH_COOLDOWN_MS     = 15 * 60 * 1000       (401)
ENTITLEMENT_COOLDOWN = 5 * 60               (org-policy 403, seconds)
FAMILY_STALE_MS      = 30 * 60 * 1000       (spent 7d_oi trust window)
USAGE_CACHE_MAX_AGE  = 20 * 60 * 1000
DRAINED_LEFTOVER     = 0.5%
SOFT_DRAIN           = 15%
RESET_JUMP           = 25%
AFFINITY_MAX_AGE     = 24h; AFFINITY_LIMIT  = 200
MAX_ACCOUNTS         = 64
```

## Appendix B — Header names (exact)

```
anthropic-ratelimit-unified-5h-utilization
anthropic-ratelimit-unified-5h-reset
anthropic-ratelimit-unified-5h-status
anthropic-ratelimit-unified-7d-utilization
anthropic-ratelimit-unified-7d-reset
anthropic-ratelimit-unified-7d-status
anthropic-ratelimit-unified-7d_oi-utilization
anthropic-ratelimit-unified-7d_oi-reset
anthropic-ratelimit-unified-7d_oi-status
anthropic-ratelimit-unified-status
```
