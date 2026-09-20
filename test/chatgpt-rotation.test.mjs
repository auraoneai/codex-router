import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PIN_ORDER,
  accountIsDrained,
  accountSession,
  coolAccount,
  forgetAccountAffinities,
  inferPurpose,
  leftoverHealth,
  normalizeRules,
  orderAccountCandidates,
  pickAccount,
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
