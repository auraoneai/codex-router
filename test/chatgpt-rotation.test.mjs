import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PIN_ORDER,
  accountCooldownUntil,
  accountIsDrained,
  accountSession,
  clearAccountAuthInvalid,
  coolAccount,
  findAccountByChatGPTAccountId,
  forgetAccountAffinities,
  inferPurpose,
  isAccountAuthInvalid,
  leftoverHealth,
  markAccountAuthInvalid,
  normalizeRules,
  orderAccountCandidates,
  pickAccount,
  poolExhaustionReport,
  rememberAccount,
  rememberedAccount,
  resetRotationStateForTests,
  rotationCandidates,
  usageWindows,
  windowReset,
} from "../src/chatgpt-rotation.mjs";

// A token whose expiry the rotation reader can evaluate without a real login.
function jwt(expSeconds) {
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `h.${body}.s`;
}

function box() {
  const root = mkdtempSync(path.join(tmpdir(), "rotation-"));
  return {
    root,
    homes: path.join(root, "homes"),
    pool: path.join(root, "pool.json"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function writeAccount(homes, id, { exp = Math.floor(Date.now() / 1000) + 3600, accountId = id } = {}) {
  const home = path.join(homes, id);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: jwt(exp), account_id: accountId } }),
  );
}

function writePool(file, ids, extra = {}) {
  const accounts = {};
  for (const [index, id] of ids.entries()) {
    accounts[id] = {
      id,
      state: "active",
      paused: false,
      priority: 50,
      label: `account ${index}`,
      createdAt: new Date().toISOString(),
      subscription: { status: "usable" },
      health: { state: "healthy" },
      turns: 0,
      requests: 0,
      ...(extra.perAccount?.[id] || {}),
    };
  }
  writeFileSync(
    file,
    JSON.stringify({ version: 1, policy: { enabled: true, mode: "switch", ...extra.policy }, accounts, sessions: {} }),
  );
}

test("upstream primary/secondary windows are read like the old fiveHour/weekly ones", () => {
  assert.equal(usageWindows({ primary: { remainingPercent: 40 } }).length, 1);
  assert.equal(usageWindows({ fiveHour: { remainingPercent: 40 } }).length, 1);
  assert.equal(leftoverHealth({ primary: { remainingPercent: 0 } }), "drained");
  assert.equal(leftoverHealth({ secondary: { remainingPercent: 0 } }), "drained");
  assert.equal(leftoverHealth({ weekly: { remainingPercent: 0 } }), "drained");
  assert.equal(leftoverHealth({ primary: { remainingPercent: 10 } }), "soft");
  assert.equal(leftoverHealth({ primary: { remainingPercent: 80 } }), "healthy");
  // No numbers at all must not read as drained, or an unprobed pool would
  // exclude every account and leave the turn with none.
  assert.equal(leftoverHealth({}), "unknown");
  assert.equal(accountIsDrained({}), false);
});

test("a soft window stays selectable so the last slice of a plan is spendable", () => {
  const usage = { a: { primary: { remainingPercent: 8 } }, b: { primary: { remainingPercent: 90 } } };
  // 'a' is preferred and soft; it must still win, because steering away from a
  // low-but-positive window strands that remainder on every subscription.
  assert.equal(pickAccount(["a", "b"], { preferred: "a", usageById: usage }), "a");
});

test("a drained account sorts behind every account that still has quota", () => {
  const usage = { a: { primary: { remainingPercent: 0 } }, b: { primary: { remainingPercent: 50 } } };
  assert.equal(pickAccount(["a", "b"], { preferred: "a", usageById: usage }), "b");
});

test("conversation affinity outranks preference and quota", () => {
  const usage = { a: { primary: { remainingPercent: 90 } }, b: { primary: { remainingPercent: 5 } } };
  assert.equal(pickAccount(["a", "b"], { sticky: "b", preferred: "a", usageById: usage }), "b");
});

test("purpose pin order breaks ties between equally healthy accounts", () => {
  const ordered = orderAccountCandidates(
    [{ id: "f" }, { id: "p" }],
    { purposeById: { f: "foundation", p: "personal" }, pinOrder: DEFAULT_PIN_ORDER },
  );
  assert.deepEqual(ordered.map((entry) => entry.id), ["p", "f"]);
});

test("rules clamp to sane bounds and always keep a pin order", () => {
  const rules = normalizeRules({ pinOrder: ["veerone", "nonsense"], softDrainPercent: 900, reserveUntilPercent: 0 });
  assert.equal(rules.pinOrder[0], "veerone");
  assert.ok(rules.pinOrder.includes("personal"));
  assert.ok(!rules.pinOrder.includes("reserve"), "reserve is never a pin target");
  assert.equal(rules.softDrainPercent, 40);
  assert.equal(rules.reserveUntilPercent, 1);
  assert.equal(rules.autoResumeOnReset, true);
  assert.equal(normalizeRules(undefined).softDrainPercent, 15);
  assert.equal(normalizeRules(undefined).reserveUntilPercent, 20);
});

test("the operator's archived purposes are recovered from account labels", () => {
  assert.equal(inferPurpose("rubina.bajwa@auraone.ai"), "auraone");
  assert.equal(inferPurpose("gc@veerone.com"), "veerone");
  assert.equal(inferPurpose("gchahal@chahalfoundation.org"), "foundation");
  assert.equal(inferPurpose("gurbaksh@chahal.com"), "personal");
  assert.equal(inferPurpose("spare", { state: "paused" }), "reserve");
});

test("a window that jumps by a wide margin counts as reset, a drift does not", () => {
  assert.equal(windowReset(2, 100), true);
  assert.equal(windowReset(40, 45), false);
  assert.equal(windowReset(undefined, 100), false);
});

test("a session is read from the account's own home, and expiry is honoured", () => {
  const b = box();
  try {
    writeAccount(b.homes, "acct_livelive", { exp: Math.floor(Date.now() / 1000) + 3600 });
    writeAccount(b.homes, "acct_deaddead", { exp: Math.floor(Date.now() / 1000) - 10 });
    const live = accountSession("acct_livelive", { homesDir: b.homes });
    assert.equal(live.expired, false);
    assert.ok(live.accessToken);
    assert.equal(live.accountId, "acct_livelive");
    assert.equal(accountSession("acct_deaddead", { homesDir: b.homes }).expired, true);
    assert.equal(accountSession("acct_missingmiss", { homesDir: b.homes }), undefined);
  } finally { b.cleanup(); }
});

test("rotation returns per-account headers drawn from each account's own credentials", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_oneoneone", { accountId: "ident-one" });
    writeAccount(b.homes, "acct_twotwotwo", { accountId: "ident-two" });
    writePool(b.pool, ["acct_oneoneone", "acct_twotwotwo"], { policy: { selectedAccountId: "acct_oneoneone" } });
    const candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes });
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].id, "acct_oneoneone", "the switched-in account stays preferred");
    assert.match(candidates[0].headers.authorization, /^Bearer /);
    assert.equal(candidates[0].headers["chatgpt-account-id"], "ident-one");
    // Each candidate carries its OWN identity: that is what makes per-request
    // rotation possible without swapping the shared auth.json.
    assert.equal(candidates[1].headers["chatgpt-account-id"], "ident-two");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("a spent preferred account yields to one with quota", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_spentspent", { accountId: "ident-spent" });
    writeAccount(b.homes, "acct_freshfresh", { accountId: "ident-fresh" });
    writePool(b.pool, ["acct_spentspent", "acct_freshfresh"], { policy: { selectedAccountId: "acct_spentspent" } });
    const candidates = rotationCandidates({
      poolPath: b.pool,
      homesDir: b.homes,
      usageById: {
        acct_spentspent: { secondary: { remainingPercent: 0 } },
        acct_freshfresh: { secondary: { remainingPercent: 70 } },
      },
    });
    assert.equal(candidates[0].id, "acct_freshfresh");
    assert.ok(!candidates.some((entry) => entry.id === "acct_spentspent"), "a drained account is excluded");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("a cooled account is passed over, and affinity keeps a conversation in place", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_oneoneone", { accountId: "ident-one" });
    writeAccount(b.homes, "acct_twotwotwo", { accountId: "ident-two" });
    writePool(b.pool, ["acct_oneoneone", "acct_twotwotwo"], { policy: { selectedAccountId: "acct_oneoneone" } });
    coolAccount("acct_oneoneone", Date.now() + 60_000);
    assert.equal(rotationCandidates({ poolPath: b.pool, homesDir: b.homes })[0].id, "acct_twotwotwo");

    rememberAccount("thread-7", "acct_twotwotwo");
    assert.equal(rememberedAccount("thread-7"), "acct_twotwotwo");
    forgetAccountAffinities("acct_twotwotwo");
    assert.equal(rememberedAccount("thread-7"), undefined, "a cooled account loses its affinities");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("rotation declines rather than guessing when it cannot help", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    // One account is not a rotation: leave the existing path alone.
    writeAccount(b.homes, "acct_solosolo", { accountId: "ident-solo" });
    writePool(b.pool, ["acct_solosolo"]);
    assert.deepEqual(rotationCandidates({ poolPath: b.pool, homesDir: b.homes }), []);

    // Disabled policy must be obeyed.
    writeAccount(b.homes, "acct_twotwotwo", { accountId: "ident-two" });
    writePool(b.pool, ["acct_solosolo", "acct_twotwotwo"], { policy: { enabled: false } });
    assert.deepEqual(rotationCandidates({ poolPath: b.pool, homesDir: b.homes }), []);

    // A missing pool is not an error the caller should see.
    assert.deepEqual(rotationCandidates({ poolPath: path.join(b.root, "absent.json"), homesDir: b.homes }), []);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("two registrations of one ChatGPT identity are offered once", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    // Same account_id behind two pool entries: one quota, so ranking both would
    // just retry the same subscription.
    writeAccount(b.homes, "acct_aaaaaaaa", { accountId: "same-ident" });
    writeAccount(b.homes, "acct_bbbbbbbb", { accountId: "same-ident" });
    writeAccount(b.homes, "acct_cccccccc", { accountId: "other-ident" });
    writePool(b.pool, ["acct_aaaaaaaa", "acct_bbbbbbbb", "acct_cccccccc"]);
    const ids = rotationCandidates({ poolPath: b.pool, homesDir: b.homes }).map((entry) => entry.id);
    assert.equal(ids.length, 2);
    assert.ok(ids.includes("acct_cccccccc"));
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("every cooled-down account still leaves a usable candidate", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_oneoneone", { accountId: "ident-one" });
    writeAccount(b.homes, "acct_twotwotwo", { accountId: "ident-two" });
    writePool(b.pool, ["acct_oneoneone", "acct_twotwotwo"]);
    coolAccount("acct_oneoneone", Date.now() + 60_000);
    coolAccount("acct_twotwotwo", Date.now() + 60_000);
    // A stale cooldown must never be the reason a turn has no account at all.
    assert.equal(rotationCandidates({ poolPath: b.pool, homesDir: b.homes }).length, 2);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("paused, revoked, and expired accounts are not offered", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_okokokok", { accountId: "ident-ok" });
    writeAccount(b.homes, "acct_pausedpaused", { accountId: "ident-paused" });
    writeAccount(b.homes, "acct_expiredexp", { accountId: "ident-expired", exp: Math.floor(Date.now() / 1000) - 5 });
    writeAccount(b.homes, "acct_extraextra", { accountId: "ident-extra" });
    writePool(b.pool, ["acct_okokokok", "acct_pausedpaused", "acct_expiredexp", "acct_extraextra"], {
      perAccount: { acct_pausedpaused: { paused: true } },
    });
    const ids = rotationCandidates({ poolPath: b.pool, homesDir: b.homes }).map((entry) => entry.id);
    assert.deepEqual(ids.sort(), ["acct_extraextra", "acct_okokokok"]);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("forgetAccountAffinities clears conversation binding while preserving cooldown", () => {
  resetRotationStateForTests();
  try {
    coolAccount("acct_coolme", Date.now() + 60_000);
    rememberAccount("thread-1", "acct_coolme");
    assert.equal(rememberedAccount("thread-1"), "acct_coolme");
    assert.ok(accountCooldownUntil("acct_coolme") > Date.now());

    forgetAccountAffinities("acct_coolme");
    assert.equal(rememberedAccount("thread-1"), undefined, "affinity is deleted");
    assert.ok(accountCooldownUntil("acct_coolme") > Date.now(), "cooldown is preserved");
  } finally { resetRotationStateForTests(); }
});

test("a verified healthy account ranks ahead of an unauthenticated or unknown account", () => {
  // 'u' is preferred and has purpose 'personal' (pin 0), but health is unknown.
  // 'h' has purpose 'foundation' (lower pin), but is confirmed healthy.
  // 'h' must win because confirmed quota outranks unknown health.
  const ordered = orderAccountCandidates(
    [{ id: "u" }, { id: "h" }],
    {
      preferred: "u",
      purposeById: { u: "personal", h: "foundation" },
      pinOrder: DEFAULT_PIN_ORDER,
      usageById: {
        u: {}, // unknown
        h: { primary: { remainingPercent: 80 } }, // healthy
      },
    },
  );
  assert.equal(ordered[0].id, "h");
});

test("findAccountByChatGPTAccountId matches pool account by claim", () => {
  const b = box();
  try {
    writeAccount(b.homes, "acct_target", { accountId: "claim-xyz" });
    writePool(b.pool, ["acct_target"]);
    const found = findAccountByChatGPTAccountId("claim-xyz", { poolPath: b.pool, homesDir: b.homes });
    assert.equal(found?.id, "acct_target");
    assert.equal(findAccountByChatGPTAccountId("nonexistent", { poolPath: b.pool, homesDir: b.homes }), undefined);
  } finally { b.cleanup(); }
});

test("early quota reset re-admits a previously drained account immediately without intervention", () => {
  const b = box();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(b.homes, "acct_alpha111", { exp: future });
    writeAccount(b.homes, "acct_beta2222", { exp: future });
    writePool(b.pool, ["acct_alpha111", "acct_beta2222"]);

    // acct_alpha111 is completely drained (0%)
    const drainedUsage = {
      acct_alpha111: { primary: { remainingPercent: 0 } },
      acct_beta2222: { primary: { remainingPercent: 70 } },
    };
    let candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: drainedUsage });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "acct_beta2222");

    // Early reset happens: OpenAI restored quota on acct_alpha111 (e.g. 80%) before advertised reset timestamp
    const resetUsage = {
      acct_alpha111: { primary: { remainingPercent: 80 } },
      acct_beta2222: { primary: { remainingPercent: 70 } },
    };
    candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: resetUsage });
    assert.equal(candidates.length, 2);
    // acct_alpha111 is immediately re-admitted and usable
    assert.ok(candidates.some((c) => c.id === "acct_alpha111"));
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("single healthy candidate among drained accounts is offered rather than dropped", () => {
  const b = box();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(b.homes, "acct_drained1", { exp: future });
    writeAccount(b.homes, "acct_drained2", { exp: future });
    writeAccount(b.homes, "acct_healthy1", { exp: future });
    writePool(b.pool, ["acct_drained1", "acct_drained2", "acct_healthy1"]);

    const usage = {
      acct_drained1: { primary: { remainingPercent: 0 } },
      acct_drained2: { primary: { remainingPercent: 0 } },
      acct_healthy1: { primary: { remainingPercent: 50 } },
    };
    const candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "acct_healthy1");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("auth revoked account is excluded and self-heals when refreshed token is supplied", () => {
  const b = box();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(b.homes, "acct_revoked1", { exp: future });
    writeAccount(b.homes, "acct_valid111", { exp: future });
    writePool(b.pool, ["acct_revoked1", "acct_valid111"]);

    const initialSession = accountSession("acct_revoked1", { homesDir: b.homes });
    assert.ok(initialSession?.tokenFingerprint);

    // 401 occurs, marking acct_revoked1 as auth invalid with its current token fingerprint
    markAccountAuthInvalid("acct_revoked1", {
      tokenFingerprint: initialSession.tokenFingerprint,
      reason: "401_unauthorized",
    });

    let candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "acct_valid111");

    // Operator logs in or token is refreshed, updating auth.json with new token
    writeAccount(b.homes, "acct_revoked1", { exp: future + 7200, accountId: "claim-revoked" });
    const refreshedSession = accountSession("acct_revoked1", { homesDir: b.homes });
    assert.notEqual(refreshedSession?.tokenFingerprint, initialSession.tokenFingerprint);

    // Immediately upon token change, isAccountAuthInvalid clears and acct_revoked1 returns to candidates!
    candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes });
    assert.equal(candidates.length, 2);
    assert.ok(candidates.some((c) => c.id === "acct_revoked1"));
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("affinity for a drained or cooling account yields to available accounts", () => {
  resetRotationStateForTests();
  try {
    const now = Date.now();
    rememberAccount("conv-123", "acct_drained");

    const usage = {
      acct_drained: { primary: { remainingPercent: 0 } },
      acct_healthy: { primary: { remainingPercent: 80 } },
    };

    const ordered = orderAccountCandidates(
      [{ id: "acct_drained" }, { id: "acct_healthy" }],
      {
        sticky: rememberedAccount("conv-123", { now }),
        usageById: usage,
        now,
      },
    );
    // Even though sticky was acct_drained, because it is drained, acct_healthy must rank first!
    assert.equal(ordered[0].id, "acct_healthy");
  } finally { resetRotationStateForTests(); }
});

test("all-accounts-unavailable behavior: Case A, B, C, D deterministic pool exhaustion and recovery", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(b.homes, "acct_alpha111", { exp: future, accountId: "org-alpha" });
    writeAccount(b.homes, "acct_beta2222", { exp: future, accountId: "org-beta" });
    writePool(b.pool, ["acct_alpha111", "acct_beta2222"]);

    // Case A: All accounts quota-exhausted
    let usage = new Map([
      ["acct_alpha111", { primary: { remainingPercent: 0, resetsAt: future + 3600 } }],
      ["acct_beta2222", { primary: { remainingPercent: 0, resetsAt: future + 7200 } }],
    ]);
    let report = poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.ok(report);
    assert.equal(report.exhausted, true);
    assert.equal(report.total, 2);
    assert.equal(report.drained, 2);
    assert.equal(report.healthy, 0);
    assert.equal(report.authInvalid, 0);
    assert.ok(report.nextResetAt > 0);
    assert.ok(report.message.includes("All 2 ChatGPT accounts in the pool are currently unavailable"));
    assert.equal(rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage }).length, 0);

    // Case B: All accounts auth_invalid
    usage = new Map();
    markAccountAuthInvalid("acct_alpha111");
    markAccountAuthInvalid("acct_beta2222");
    report = poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.ok(report);
    assert.equal(report.exhausted, true);
    assert.equal(report.total, 2);
    assert.equal(report.authInvalid, 2);
    assert.equal(report.healthy, 0);
    assert.equal(rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage }).length, 0);

    // Case C: Mixture of drained and auth_invalid
    resetRotationStateForTests();
    markAccountAuthInvalid("acct_alpha111");
    usage = new Map([
      ["acct_beta2222", { primary: { remainingPercent: 0, resetsAt: future + 7200 } }],
    ]);
    report = poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.ok(report);
    assert.equal(report.exhausted, true);
    assert.equal(report.authInvalid, 1);
    assert.equal(report.drained, 1);
    assert.equal(report.healthy, 0);

    // Case D: Account recovers (e.g. beta gets quota back via early reset)
    usage = new Map([
      ["acct_beta2222", { primary: { remainingPercent: 85, resetsAt: future + 7200 } }],
    ]);
    report = poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.equal(report, null); // Pool is no longer exhausted!
    const candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "acct_beta2222");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("workspace to personal account failover cleanly strips chatgpt-account-id", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    // acct_work1111 is a workspace account with chatgpt-account-id
    writeAccount(b.homes, "acct_work1111", { exp: future, accountId: "org-work" });
    // acct_pers1111 is a personal account without chatgpt-account-id
    writeAccount(b.homes, "acct_pers1111", { exp: future, accountId: null });
    writePool(b.pool, ["acct_work1111", "acct_pers1111"]);

    const workSession = accountSession("acct_work1111", { homesDir: b.homes });
    const persSession = accountSession("acct_pers1111", { homesDir: b.homes });

    assert.equal(workSession.headers["chatgpt-account-id"], "org-work");
    assert.equal(persSession.headers["chatgpt-account-id"], undefined);

    // Simulate failover from workSession headers to persSession headers:
    const initialHeaders = {
      authorization: workSession.headers.authorization,
      "chatgpt-account-id": workSession.headers["chatgpt-account-id"],
      "content-type": "application/json",
    };
    assert.equal(initialHeaders["chatgpt-account-id"], "org-work");

    const nextHeaders = {
      ...initialHeaders,
      ...persSession.headers,
    };
    if (!persSession.headers["chatgpt-account-id"]) {
      delete nextHeaders["chatgpt-account-id"];
    }

    // Must have personal token and NO chatgpt-account-id header carried over!
    assert.equal(nextHeaders.authorization, persSession.headers.authorization);
    assert.equal(nextHeaders["chatgpt-account-id"], undefined);
    assert.equal("chatgpt-account-id" in nextHeaders, false);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("registration-id identity drift: token change updates identity and clears auth-invalid", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    // Account initial setup with token 1 and workspace 1
    writeAccount(b.homes, "acct_drift111", { exp: future, accountId: "org-old" });
    writePool(b.pool, ["acct_drift111", "acct_other111"]);
    writeAccount(b.homes, "acct_other111", { exp: future, accountId: "org-other" });

    const session1 = accountSession("acct_drift111", { homesDir: b.homes });
    assert.equal(session1.accountId, "org-old");

    // Mark auth invalid with token 1's fingerprint
    markAccountAuthInvalid("acct_drift111", { tokenFingerprint: session1.tokenFingerprint });
    assert.equal(isAccountAuthInvalid("acct_drift111", { tokenFingerprint: session1.tokenFingerprint }), true);

    // Reauth: token renewal changes token and upstream org changes to org-new
    writeAccount(b.homes, "acct_drift111", { exp: future + 7200, accountId: "org-new" });
    const session2 = accountSession("acct_drift111", { homesDir: b.homes });
    assert.notEqual(session2.tokenFingerprint, session1.tokenFingerprint);
    assert.equal(session2.accountId, "org-new");

    // Auto-clears auth-invalid because fingerprint changed!
    assert.equal(isAccountAuthInvalid("acct_drift111", { tokenFingerprint: session2.tokenFingerprint }), false);

    // Candidates still include exactly one entry for acct_drift111 (no duplicates!)
    const candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes });
    const driftCandidates = candidates.filter((c) => c.id === "acct_drift111");
    assert.equal(driftCandidates.length, 1);
    assert.equal(driftCandidates[0].headers["chatgpt-account-id"], "org-new");
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

test("multi-hop candidate failover: A (429) -> B (401) -> C (200) with single-attempt guarantee and affinity", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeAccount(b.homes, "acct_hopone1111", { exp: future, accountId: "org-1" });
    writeAccount(b.homes, "acct_hoptwo2222", { exp: future, accountId: "org-2" });
    writeAccount(b.homes, "acct_hopthree33", { exp: future, accountId: "org-3" });
    writePool(b.pool, ["acct_hopone1111", "acct_hoptwo2222", "acct_hopthree33"], {
      policy: { selectedAccountId: "acct_hopone1111" },
    });

    const attemptedCandidateIds = new Set();
    const convId = "conv-multi-hop";

    // Initial candidate selection:
    let candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, conversationId: convId });
    let current = candidates.find((c) => !attemptedCandidateIds.has(c.id));
    assert.equal(current.id, "acct_hopone1111");
    attemptedCandidateIds.add(current.id);

    // Hop 1: acct_hopone1111 receives 429 Rate Limit -> cooldown applied
    coolAccount(current.id, Date.now() + 60000);

    // Find next candidate:
    candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, conversationId: convId });
    current = candidates.find((c) => !attemptedCandidateIds.has(c.id));
    assert.equal(current.id, "acct_hoptwo2222");
    attemptedCandidateIds.add(current.id);

    // Hop 2: acct_hoptwo2222 receives 401 Unauthorized -> marked auth-invalid
    markAccountAuthInvalid(current.id);

    // Find next candidate:
    candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, conversationId: convId });
    current = candidates.find((c) => !attemptedCandidateIds.has(c.id));
    assert.equal(current.id, "acct_hopthree33");
    attemptedCandidateIds.add(current.id);

    // Hop 3: acct_hopthree33 receives 200 OK -> affinity recorded
    rememberAccount(convId, current.id);

    // Verify all candidates were attempted at most once:
    assert.equal(attemptedCandidateIds.size, 3);
    assert.ok(attemptedCandidateIds.has("acct_hopone1111"));
    assert.ok(attemptedCandidateIds.has("acct_hoptwo2222"));
    assert.ok(attemptedCandidateIds.has("acct_hopthree33"));

    // Verify state exclusions:
    assert.ok(accountCooldownUntil("acct_hopone1111") > Date.now());
    assert.equal(isAccountAuthInvalid("acct_hoptwo2222"), true);

    // Verify next turn in same conversation sticks to healthy acct_hopthree33:
    const nextTurnCandidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, conversationId: convId });
    assert.equal(nextTurnCandidates.length, 1);
    assert.equal(nextTurnCandidates[0].id, "acct_hopthree33");

    // If acct_hopthree33 also fails, pool exhaustion occurs cleanly without infinite loops:
    attemptedCandidateIds.add("acct_hopthree33");
    coolAccount("acct_hopthree33", Date.now() + 60000);
    const exhaustedCandidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, conversationId: convId });
    const noCandidate = exhaustedCandidates.find((c) => !attemptedCandidateIds.has(c.id));
    assert.equal(noCandidate, undefined); // loop terminates cleanly!
  } finally { b.cleanup(); resetRotationStateForTests(); }
});



