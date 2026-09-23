# Autonomous ChatGPT Multi-Account Rotation, Failover & Self-Healing

Codex Router autonomously manages a multi-account pool of ChatGPT/Codex subscriptions. It selects an eligible account for each native turn, transparently fails over on rate limits (429) or revoked credentials (401), monitors quota resets, and automatically re-admits recovered accounts without service restarts or manual profile switching.

---

## 1. Architecture & Mechanics

### Per-Turn Credential Injection
Unlike legacy or switch-only modes that copy credentials into `~/.codex/auth.json`, autonomous rotation operates on the HTTP wire:
- Each account in `chatgpt-account-pool.json` has an isolated saved login under `~/.codex/codex-router/chatgpt-accounts/<account-id>/auth.json`. For the account currently signed into Codex desktop, rotation reads the live `~/.codex/auth.json` after checking its account identity. Other accounts use their isolated homes.
- For each native OpenAI request (e.g. `gpt-6-sol`, `gpt-6-luna`), `rotatedNativeHeaders()` selects an eligible candidate from the pool and replaces the `Authorization: Bearer <token>` and `chatgpt-account-id` headers.
- The active desktop/CLI profile on disk is never overwritten.

Background usage probes avoid starting another Codex auth manager when an access token is within ten minutes of expiry. The desktop owns refresh for its live login; the pool does not refresh the selected account's saved copy. A background quota reading may briefly be unavailable while that login refreshes.

---

## 2. Account Lifecycle & Ranking

Every account in the pool exists in one of the following states:

1. **`healthy`**: Account has confirmed quota (`remainingPercent > 15%`). Remains eligible.
2. **`soft` (soft drain)**: Confirmed quota is between `0.5%` and `15%`. Stays eligible so the remainder of a paid window can be consumed before switching.
3. **`unknown`**: No quota telemetry available (e.g. initial launch before probe completes). Tried after accounts with confirmed quota, but kept eligible so the pool remains usable.
4. **`cooling`**: Transient `429 Too Many Requests`. The account is put on a 5-minute backoff (`COOLDOWN_MS`). Its conversation affinity is cleared. It is temporarily passed over until cooldown expiry or until next healthy probe.
5. **`drained` (quota exhausted)**: Confirmed quota `<= 0.5%` (or 100% used). Completely excluded from candidate rotation.
6. **`auth_invalid`**: Received a `401 Unauthorized` or `token_revoked` response. Tracked by `tokenFingerprint` (SHA-256 of access token). Completely excluded from candidate rotation.

### Candidate Ordering
1. **Conversation Affinity**: An in-flight conversation continues on its account while that account is neither drained, auth-invalid, nor cooling. A conversation already on Pro can therefore stay on Pro until its affinity expires or the account becomes unavailable.
2. **Confirmed Quota**: Accounts with confirmed remaining quota precede those with no quota telemetry. Among confirmed accounts, the usage probe's plan type orders **Plus first, unknown or other plan second, Pro third**. A Plus account with a soft but positive window is chosen before a healthy Pro account, including when Pro is the selected desktop profile.
3. **Within a plan**: The operator-selected preferred account wins when it has confirmed quota, followed by healthy then soft accounts, purpose pin order, and registration order. Accounts without quota telemetry follow after confirmed accounts, with the preferred account first.

This spends Plus capacity before Pro for new turns while retaining health and conversation safeguards. Plan type comes from the usage probe; it is never guessed from an account label.

The selector does not use round robin. Continuing conversations keep their assigned account while it is eligible. The historical soft-quota switch was removed because it could leave the last 1–15% of a subscription unused before its window reset.

---

## 3. In-Flight Native Failover

If an upstream request encounters a `429` (rate limit / quota exhausted) or `401` (invalid/revoked token):
1. **Account Cooled/Invalidated**: The failing account is immediately put into cooldown (or marked `auth_invalid`), and conversation affinity is forgotten.
2. **In-Flight Retry Loop**: If response headers/chunks have not yet streamed to the client (`nothingRelayed(response)`), the router automatically retrieves the next candidate from the pool.
3. **Relay Before Streaming**: The turn is re-dispatched upstream using the identical materialized body and the next candidate's credentials when no response bytes have reached the client. A desktop sign-out or account switch can still interrupt Codex's own authenticated session; HTTP failover cannot repair that local login state.
4. **Emergency Depletion Probe**: If all candidate accounts fail or become exhausted, an immediate probe is triggered in the background to detect any newly replenished quota.

---

## 4. Autonomous Recovery & Re-Entry

### Early Quota Reset Discovery
OpenAI reported reset timestamps are **hints**, not hard exclusion locks:
- If an account reports a reset timestamp days in the future, but OpenAI replenishes capacity early, the router will not wait for the reset date.
- Periodic background probes (every 2 minutes), startup probes, and probes after successful native turns detect early replenishment.
- When `remainingPercent > 0.5%` is detected, `accountIsDrained()` returns false, and the account **immediately returns to the rotation pool** on the very next turn.

### Reset-Aware Scheduling (`nextKnownResetAt`)
- The router calculates the minimum upcoming reset timestamp across all accounts (`nextKnownResetAt()`).
- It schedules an automatic background probe for `resetsAt + 5s` (capped at 24h).
- Obsolete or past reset timers are automatically refreshed.

### Token Renewal Self-Healing
- When an account returns `401`, its current access token fingerprint is recorded in `authInvalidAccounts`.
- When the user or CLI logs in, refreshes, or updates `auth.json`, the router computes the new token fingerprint.
- Because the fingerprint changed, `isAccountAuthInvalid()` clears the exclusion and restores the account to rotation automatically.

---

## 5. Control & Telemetry Commands

Inspect pool and rotation state at any time:

```bash
# View active rotation order and cached quota
./bin/control chatgpt-account-pool usage cached

# Trigger an immediate live probe across all accounts (~2s)
./bin/control chatgpt-account-pool usage

# Check overall router service health
./bin/control status
./bin/model-router codex doctor
```

### Banked rate-limit resets

The Island shows each account's server-reported banked reset count. A reset becomes clickable when a five-hour or weekly limit is at least 90% used. Clicking opens an account-specific confirmation; only confirming spends one credit. This is separate from the scheduled quota reset countdown and never happens automatically during rotation.

The equivalent explicit command is `./bin/control chatgpt-account-pool reset-credit <acct_id>`. It verifies the account's login and account identity before using Codex's account reset method. The selected account uses its live desktop login when the identity matches; inactive accounts use their isolated logins. An uncertain response retains the same private idempotency key for a retry. A confirmed result is replayed for ten minutes to protect against rapid duplicate clicks while quota readings catch up. The router refreshes account quota after a confirmed redemption.

Example `usage cached` output:
```json
{
  "fetchedAt": "2026-09-22T13:23:57.790Z",
  "rotation": [
    "acct_3K7NY-l07KZq_jTq",
    "acct_Gfgs0A6MIJDFFDQ6",
    "acct_-O25s-kGab1AWitC"
  ],
  "accounts": [
    { "id": "acct_sDOpZfM-qEnyrsIM", "label": "gchahal.ceo@gmail.com", "health": "drained", "primaryRemainingPercent": 0 },
    { "id": "acct_ITrjHwzqNRfqT9Ja", "label": "gurbaksh@chahal.com", "health": "unknown", "authInvalid": true },
    { "id": "acct_Gfgs0A6MIJDFFDQ6", "label": "gc@veerone.com", "health": "healthy", "primaryRemainingPercent": 100 },
    { "id": "acct_-O25s-kGab1AWitC", "label": "gchahal@chahalfoundation.org", "health": "healthy", "primaryRemainingPercent": 99 },
    { "id": "acct_3K7NY-l07KZq_jTq", "label": "rubina.bajwa@auraone.ai", "health": "healthy", "primaryRemainingPercent": 90 }
  ]
}
```

---

## 6. Troubleshooting

1. **"You've hit your usage limit" in Codex CLI / App**:
   - Check if the terminal launched Codex with a custom profile (e.g. `codex -p profile-name`).
   - Verify that `openai_base_url` in that profile points to `http://127.0.0.1:4202/v1` rather than directly to `https://chatgpt.com/backend-api/codex`.
2. **Account Stays Drained**:
   - Run `./bin/control chatgpt-account-pool usage` to trigger a fresh probe. If the account truly has 0% quota on upstream OpenAI, it will remain excluded until its quota resets.
3. **Account Shows Auth Invalid**:
   - Run `codex login` or update the account's credentials in its isolated pool directory (`~/.codex/codex-router/chatgpt-accounts/<id>/auth.json`). The router will automatically detect the new token fingerprint and restore the account.
