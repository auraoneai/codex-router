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

test("confirmed Plus quota is spent before Pro, even when Pro is preferred and Plus is soft", () => {
  const usage = {
    pro: { planType: "pro", primary: { remainingPercent: 90 } },
    plus: { planType: " Plus ", primary: { remainingPercent: 2 } },
  };
  assert.equal(pickAccount(["pro", "plus"], { preferred: "pro", usageById: usage }), "plus");
  assert.deepEqual(
    orderAccountCandidates([{ id: "pro" }, { id: "plus" }], { preferred: "pro", usageById: usage })
      .map((candidate) => candidate.id),
    ["plus", "pro"],
  );
});

test("confirmed Plus accounts precede Pro accounts while keeping same-tier preference", () => {
  const usage = {
    pro: { planType: "pro", primary: { remainingPercent: 90 } },
    plusA: { planType: "plus", primary: { remainingPercent: 90 } },
    plusB: { planType: "plus", primary: { remainingPercent: 3 } },
  };
  assert.deepEqual(
    orderAccountCandidates([{ id: "pro" }, { id: "plusA" }, { id: "plusB" }], {
      preferred: "plusB", usageById: usage,
    }).map((candidate) => candidate.id),
    ["plusB", "plusA", "pro"],
  );
});

test("confirmed quota outranks an unprobed Plus account", () => {
  const usage = {
    plus: { planType: "plus" },
    pro: { planType: "pro", primary: { remainingPercent: 80 } },
  };
  assert.equal(pickAccount(["plus", "pro"], { usageById: usage }), "pro");
});

test("an existing Pro conversation keeps affinity while new conversations choose Plus", () => {
  const usage = {
    plus: { planType: "plus", primary: { remainingPercent: 50 } },
    pro: { planType: "pro", primary: { remainingPercent: 50 } },
  };
  assert.equal(pickAccount(["plus", "pro"], { usageById: usage }), "plus");
  assert.equal(pickAccount(["plus", "pro"], { sticky: "pro", usageById: usage }), "pro");
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

test("the pool uses Plus first, then Pro when Plus drains or cools", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    const plusId = "acct_plusplus";
    const proId = "acct_propropro";
    writeAccount(b.homes, plusId, { accountId: "ident-plus" });
    writeAccount(b.homes, proId, { accountId: "ident-pro" });
    writePool(b.pool, [proId, plusId], { policy: { selectedAccountId: proId } });
    const usage = {
      [plusId]: { planType: "plus", primary: { remainingPercent: 2 } },
      [proId]: { planType: "pro", primary: { remainingPercent: 95 } },
    };
    const ids = (rows) => rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: rows })
      .map((entry) => entry.id);
    assert.deepEqual(ids(usage), [plusId, proId]);

    usage[plusId].primary.remainingPercent = 0;
    assert.deepEqual(ids(usage), [proId], "a drained Plus account leaves the candidate pool");

    usage[plusId].primary.remainingPercent = 2;
    coolAccount(plusId, Date.now() + 60_000);
    assert.deepEqual(ids(usage), [proId], "a cooling Plus account yields to Pro");
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

test("a spent window whose reset has passed no longer keeps the account out", () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  // Upstream reports resetsAt in epoch seconds.
  const reset = { primary: { remainingPercent: 0, resetsAt: nowSec - 60 } };
  const pending = { primary: { remainingPercent: 0, resetsAt: nowSec + 3600 } };
  assert.equal(leftoverHealth(reset, undefined, undefined, now), "unknown",
    "a failed probe that kept the old 0% must not strand the account past its reset");
  assert.equal(accountIsDrained(pending, undefined, undefined, now), true);
  // A weekly window still spent outranks a 5h window that already reset.
  assert.equal(accountIsDrained({
    primary: { remainingPercent: 0, resetsAt: nowSec - 60 },
    secondary: { remainingPercent: 0, resetsAt: nowSec + 86_400 },
  }, undefined, undefined, now), true);
});

test("pool exhaustion names when a spent account is back, not the earliest unrelated reset", () => {
  const b = box();
  try {
    writeAccount(b.homes, "acct_spentone1");
    writeAccount(b.homes, "acct_spenttwo2");
    writePool(b.pool, ["acct_spentone1", "acct_spenttwo2"]);
    const nowSec = Math.floor(Date.now() / 1000);
    const usageById = {
      // 5h still has room and resets soon; the weekly window is the spent one.
      acct_spentone1: {
        primary: { remainingPercent: 60, resetsAt: nowSec + 600 },
        secondary: { remainingPercent: 0, resetsAt: nowSec + 7200 },
      },
      acct_spenttwo2: { primary: { remainingPercent: 0, resetsAt: nowSec + 3600 } },
    };
    const report = poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById });
    assert.equal(report.exhausted, true);
    assert.equal(report.nextResetAt, (nowSec + 3600) * 1000,
      "the 5h reset at +10m frees nothing; the first account back is the other one at +1h");
  } finally {
    b.cleanup();
  }
});

test("a revoked verdict from before the stored login changed does not hold a re-signed-in account out", () => {
  const b = box();
  try {
    writeAccount(b.homes, "acct_relogged1");
    writeAccount(b.homes, "acct_steadytwo");
    writePool(b.pool, ["acct_relogged1", "acct_steadytwo"]);
    const probedBefore = new Date(Date.now() - 60_000).toISOString();
    const ids = (fetchedAt) => rotationCandidates({
      poolPath: b.pool,
      homesDir: b.homes,
      usageById: { acct_relogged1: { authInvalid: true, fetchedAt } },
    }).map((candidate) => candidate.id);
    assert.ok(ids(probedBefore).includes("acct_relogged1"),
      "the probe read the login this sign-in replaced");
    assert.ok(!ids(new Date(Date.now() + 60_000).toISOString()).includes("acct_relogged1"),
      "a verdict about the current login still applies");
  } finally {
    b.cleanup();
  }
});

test("an account opted into credit fallback keeps serving on credits after every plan window is spent", async () => {
  const { setChatGPTSubscriptionAccountCreditFallback, readChatGPTAccountPoolState } = await import("../src/chatgpt-account-pool.mjs");
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_creditone", { accountId: "ident-credit" });
    writeAccount(b.homes, "acct_planplan1", { accountId: "ident-plan" });
    writePool(b.pool, ["acct_creditone", "acct_planplan1"], {
      perAccount: { acct_creditone: { identity: { accountId: "ident-credit", email: "Owner@Example.com" } } },
    });
    const usage = {
      acct_creditone: { secondary: { remainingPercent: 0 }, credits: { hasCredits: true, unlimited: false, balance: "40" } },
      acct_planplan1: { secondary: { remainingPercent: 30 } },
    };
    const ids = () => rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage }).map((entry) => entry.id);
    assert.deepEqual(ids(), ["acct_planplan1"], "credits stay untouched until the operator opts in");

    const account = setChatGPTSubscriptionAccountCreditFallback("owner@example.com", true, { filePath: b.pool });
    assert.equal(account.creditFallback, true);
    assert.equal(readChatGPTAccountPoolState(b.pool).accounts.acct_creditone.creditFallback, true);
    assert.deepEqual(ids(), ["acct_planplan1", "acct_creditone"], "plan quota is spent before credits");

    usage.acct_planplan1.secondary.remainingPercent = 0;
    const candidates = rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: usage });
    assert.deepEqual(candidates.map((entry) => entry.id), ["acct_creditone"]);
    assert.equal(candidates[0].spendsCredits, true);
    assert.equal(poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage }), null,
      "a pool with spendable credits is not exhausted");

    usage.acct_creditone.credits = { hasCredits: false, unlimited: false, balance: "0" };
    assert.deepEqual(ids(), [], "a confirmed empty balance drops the account");
    assert.equal(poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage })?.exhausted, true);

    usage.acct_creditone.credits = { hasCredits: true, unlimited: false };
    coolAccount("acct_creditone", Date.now() + 60_000);
    assert.equal(poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: usage })?.exhausted, true,
      "a credit account that just answered 429 is cooling, not available");
    resetRotationStateForTests();

    setChatGPTSubscriptionAccountCreditFallback("acct_creditone", false, { filePath: b.pool });
    assert.equal(readChatGPTAccountPoolState(b.pool).accounts.acct_creditone.creditFallback, undefined);
    assert.deepEqual(ids(), []);
    assert.throws(() => setChatGPTSubscriptionAccountCreditFallback("nobody@example.com", true, { filePath: b.pool }), /No registered/);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});

function writeCatalog(homes, id, slugs, { fetchedAt = new Date().toISOString() } = {}) {
  writeFileSync(
    path.join(homes, id, "models_cache.json"),
    JSON.stringify({ fetched_at: fetchedAt, models: slugs.map((slug) => ({ slug, visibility: "list" })) }),
  );
}

test("rotation skips an account whose own catalog does not offer the requested model", () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writeAccount(b.homes, "acct_freefree1", { accountId: "ident-free" });
    writeAccount(b.homes, "acct_propro111", { accountId: "ident-pro" });
    writeAccount(b.homes, "acct_nocatalog", { accountId: "ident-none" });
    writePool(b.pool, ["acct_freefree1", "acct_propro111", "acct_nocatalog"]);
    writeCatalog(b.homes, "acct_freefree1", ["gpt-6-luna", "gpt-5.6-luna"]);
    writeCatalog(b.homes, "acct_propro111", ["gpt-6-sol", "gpt-6-luna"]);
    const usage = {
      acct_freefree1: { planType: "free", primary: { remainingPercent: 100 } },
      acct_propro111: { planType: "pro", primary: { remainingPercent: 0 } },
      acct_nocatalog: { planType: "plus", primary: { remainingPercent: 50 } },
    };
    const ids = (model, rows = usage) => rotationCandidates({ poolPath: b.pool, homesDir: b.homes, usageById: rows, model })
      .map((entry) => entry.id);

    assert.ok(ids("gpt-6-luna").includes("acct_freefree1"), "Free serves the models it lists");
    assert.ok(!ids("gpt-6-sol").includes("acct_freefree1"), "Free never receives Sol");
    assert.ok(ids("gpt-6-sol").includes("acct_nocatalog"), "a missing catalog is unknown, not unsupported");
    assert.ok(ids(undefined).includes("acct_freefree1"), "no model keeps rotation model-blind");
    assert.ok(ids("gpt-image-2").includes("acct_freefree1"), "a slug no catalog lists filters nothing");

    // A Free account with quota left is no capacity for a Sol turn.
    const soloPro = { ...usage, acct_nocatalog: { primary: { remainingPercent: 0 } } };
    assert.equal(poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: soloPro, model: "gpt-6-sol" })?.exhausted, true);
    assert.equal(poolExhaustionReport({ poolPath: b.pool, homesDir: b.homes, usageById: soloPro, model: "gpt-6-luna" }), null);

    // A catalog that stopped being refreshed no longer vouches for a gap.
    writeCatalog(b.homes, "acct_freefree1", ["gpt-6-luna"], { fetchedAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() });
    assert.ok(ids("gpt-6-sol").includes("acct_freefree1"));
  } finally { b.cleanup(); resetRotationStateForTests(); }
});
