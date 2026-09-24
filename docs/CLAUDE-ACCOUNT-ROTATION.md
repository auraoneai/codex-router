# Autonomous Claude Subscription Multi-Account Rotation, Failover & Self-Healing

Codex Router autonomously manages a multi-account pool of Claude subscription accounts (imported from Claude Code OAuth logins). It selects an eligible account for each request routed to Anthropic, transparently fails over on rate limits (429) or revoked credentials (401), tracks 5-hour and weekly quota windows passively from Anthropic's own headers, and automatically re-admits recovered accounts without service restarts or manual profile switching.

---

## 1. Architecture & Mechanics

### Per-Request Credential Injection
Unlike single-account setups that rely on a single static API key or active CLI session, Claude subscription account rotation operates at the request forwarding layer:
- Pool configuration is maintained in `claude-account-pool.json` (`CLAUDE_ACCOUNT_POOL_PATH`).
- Each registered account has an isolated credential home under `~/.codex/codex-router/claude-accounts/<account-id>/credentials.json` (`CLAUDE_ACCOUNT_HOMES_DIR`).
- Account IDs use the `clacct_` prefix followed by 16 base62 characters (distinct from ChatGPT's `acct_` prefix so pools cannot be confused).
- When a request targets a model served by the `anthropic-api` provider (or arrives via Claude Code's `/anthropic` surface), the router selects an eligible candidate from the pool and injects outbound OAuth headers:
  ```http
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  anthropic-version: 2023-06-01
  ```
- **Strictly no `x-api-key`**: An OAuth request must never send `x-api-key`, and API-key routes must never send the OAuth beta header. The two authorization modes never mix.
- Claude Code itself points to the local router via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (the local caller capability); the router transparently supplies the pooled Anthropic subscription credentials upstream.

### Token Lifecycle & Refresh
- The router owns token refresh for every registered account in the pool (Claude Code refreshes only its own currently active login).
- Refresh endpoint: `POST https://platform.claude.com/v1/oauth/token` with client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
- Proactive refresh margin: tokens within 5 minutes of expiry (`EXPIRY_BUFFER_MS`) are automatically refreshed and atomically persisted back to the account home.
- Refresh error classification:
  - Permanent: HTTP 400/401/403 with `invalid_grant` marks the account `reauth-required` (excluded from rotation until re-imported).
  - Systemic: `invalid_client` is logged but does not penalize the account.
  - Transient: network failures or 5xx responses preserve the account as eligible with its current token while scheduling a backoff retry.

---

## 2. Account Lifecycle & Ranking

### Account States

1. **Administrative States** (in pool state):
   - `active`: Account is enabled and eligible for rotation.
   - `paused`: Account is temporarily withheld from candidate rotation by the operator (`control claude-account-pool disable <id>`).
   - `revoked`: Account is permanently removed.

2. **Health & Quota States** (computed from usage telemetry and runtime signals):
   - **`healthy`**: Account has confirmed remaining quota (`remainingPercent > 15%`). Fully eligible.
   - **`soft` (soft drain)**: Confirmed remaining quota is between `0.5%` and `15%`. Stays eligible so the remainder of a paid window is consumed before switching.
   - **`unknown`**: No quota telemetry observed yet (e.g. before first turn). Eligible after accounts with confirmed quota.
   - **`cooling`**: Transient rate limit or burst throttle. The account is put on a 5-minute backoff (`COOLDOWN_MS`). Conversation affinity is cleared. The account is skipped until cooldown expiry or healthy probe.
   - **`drained` (quota exhausted)**: Confirmed remaining quota `<= 0.5%` (or 100% used, or `anthropic-ratelimit-unified-status: rejected`). Completely excluded from candidate rotation until reset.
   - **`reauth-required` / `auth_invalid`**: Received a `401 Unauthorized` or token refresh `invalid_grant`. Tracked by `tokenFingerprint` (SHA-256 of token material). Excluded until credentials are renewed.

### Ranking Hierarchy
When selecting an account for a request, candidates are ranked using the following strict priority:

1. **Conversation Affinity**: An in-flight conversation continues on its assigned account while that account is neither drained, auth-invalid, nor cooling (`AFFINITY_MAX_AGE_MS = 24h`, up to 200 entries).
2. **Confirmed Quota**: Accounts with confirmed remaining quota precede accounts without quota telemetry (`healthy` -> `soft` -> `unknown`).
3. **Subscription Tier Weights**: Spends smaller confirmed capacity first so larger reserve subscriptions are not stranded:
   - `pro` (weight 1)
   - `unknown` plan (weight 3)
   - `max5` (weight 5)
   - `max20` (weight 20)
   - `team` (weight 50)
4. **Operator Preference & Purpose Pins**:
   - The operator-selected preferred account (`control claude-account-pool select <id>`) wins within the same tier/quota band.
   - Purpose pin ordering: `personal` -> `auraone` -> `veerone` -> `foundation` -> `reserve`.
   - Registration order breaks remaining ties.

---

## 3. In-Flight Failover & Error Handling

If an upstream request encounters an error before bytes stream to the client:

1. **Quota Rejection (`unified status: rejected` or 429 with unified headers)**:
   - The account is marked drained / cooled, its affinity is cleared, and the turn is immediately retried on the next eligible candidate in the pool.
2. **Per-Minute Burst Throttle (429 with `retry-after`, no unified rejection)**:
   - **Paced inline, not rotated**: Rotating would discard Anthropic prompt caching and needlessly throttle sibling accounts. The router absorbs the delay inline (up to 60s) or surfaces the retry-after.
3. **Headerless 429**:
   - Request-scoped: one hop to an idle sibling account, one 2s retry, then surfaced to the client.
4. **Authentication Failure (401)**:
   - Account is marked `auth_invalid` with its token fingerprint, excluded from candidate rotation, and retried on the next eligible account.
5. **Entitlement Quarantine (403 `oauth_not_allowed_for_organization`)**:
   - Account is quarantined for 5 minutes (organization policy restriction), and the request fails over to another account. Other 403 errors fail over immediately without quarantine.
6. **Pool Exhaustion**:
   - If all accounts are exhausted, cooling, or invalid, the router returns HTTP 429 with error type `claude_account_pool_exhausted` and a structured report containing the earliest quota reset timestamp.
   - The Claude Code surface (`/anthropic`) cleanly translates this to Claude Code format with `type: "rate_limit_error"` while preserving the exhaustion report and earliest reset timestamp.

---

## 4. Passive Quota Learning

The router does not rely on aggressive active polling that consumes API quota. Instead, it observes Anthropic's unified rate-limit headers on every response:

- `anthropic-ratelimit-unified-5h-utilization` (0.0–1.0 fraction)
- `anthropic-ratelimit-unified-5h-reset` (epoch seconds -> converted to ms)
- `anthropic-ratelimit-unified-5h-status` (`allowed`, `allowed_warning`, `rejected`)
- `anthropic-ratelimit-unified-7d-utilization`
- `anthropic-ratelimit-unified-7d-reset`
- `anthropic-ratelimit-unified-7d-status`
- `anthropic-ratelimit-unified-7d_oi-utilization` / `-reset` / `-status` (7-day overage-included window for models such as Fable)
- `anthropic-ratelimit-unified-status`

Parsed telemetry is persisted per account in `claude-account-usage.json` (`CLAUDE_ACCOUNT_USAGE_CACHE_PATH`) after response streaming completes, surviving router restarts.

---

## 5. Autonomous Recovery & Re-Entry

### Quota Reset Discovery
- Reset timestamps reported by Anthropic are parsed and stored per account (`resetsAtMs`).
- When a 5-hour or 7-day reset window passes (`Date.now() >= resetsAtMs`), or when incoming headers indicate restored capacity (`remainingPercent > 0.5%`), the account's drained status is cleared.
- The account **immediately returns to rotation** on the very next request without requiring restarts or operator intervention.

### Token Renewal Self-Healing
- When an account returns 401, its SHA-256 token fingerprint is recorded in `authInvalidAccounts`.
- When the user logs in via Claude Code (`claude login`) and re-imports the account, or when token refresh succeeds with a new token, the router computes the new token fingerprint.
- The change in fingerprint automatically clears the invalidation and restores the account to full eligibility.

---

## 6. Control & Telemetry Commands

Manage and inspect the Claude account pool using `./bin/control`:

```bash
# View pool status, health, and cached quota
./bin/control claude-account-pool status

# Import an account from the local Claude Code login
./bin/control claude-account-pool add "Personal Pro"

# View cached usage and rotation order
./bin/control claude-account-pool usage cached

# Trigger a usage probe across accounts
./bin/control claude-account-pool usage

# Select preferred account for default turns
./bin/control claude-account-pool select clacct_01ABCDEF23456789

# Temporarily pause an account from rotation
./bin/control claude-account-pool disable clacct_01ABCDEF23456789

# Re-enable a paused account
./bin/control claude-account-pool enable clacct_01ABCDEF23456789

# Remove an account and delete its isolated credentials
./bin/control claude-account-pool remove clacct_01ABCDEF23456789
```

Example `status` output:
```json
{
  "version": 1,
  "policy": {
    "enabled": true,
    "mode": "switch",
    "selectedAccountId": "clacct_w4K8v1P9mQ2xL7zA"
  },
  "accounts": {
    "clacct_w4K8v1P9mQ2xL7zA": {
      "id": "clacct_w4K8v1P9mQ2xL7zA",
      "label": "user@example.com",
      "state": "active",
      "paused": false,
      "priority": 50,
      "purpose": "personal",
      "subscription": { "status": "usable", "plan": "pro" },
      "health": { "state": "healthy" },
      "usage": {
        "fiveHour": { "remainingPercent": 84, "resetsAtMs": 1758758400000 },
        "weekly": { "remainingPercent": 92, "resetsAtMs": 1759276800000 }
      }
    }
  }
}
```

---

## 7. Compliance & Privacy Guarantees

- **Local-only execution**: All account metadata and credentials reside exclusively on the operator's local machine under `~/.codex/codex-router/`.
- **Owner-only file permissions**: Pool state and credential files are created with `0600` permissions (or current-user Windows ACLs).
- **Strict redaction**: Access tokens and refresh tokens are never printed to stdout, stderr, logs, support bundles, or status payloads. Status endpoints report presence, IDs, emails, and fingerprints only.
- **Operator-owned credentials**: The pool is designed for an operator or team's own legitimate subscriptions. No third-party token harvesting or unauthorized credential sharing occurs.
