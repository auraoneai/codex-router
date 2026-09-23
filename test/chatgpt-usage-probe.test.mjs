import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nextKnownResetAt, probeChatGPTAccountUsage } from "../src/chatgpt-usage-probe.mjs";
import { privateFileIsProtected } from "../src/file-security.mjs";
import { isAccountAuthInvalid, markAccountAuthInvalid, resetRotationStateForTests } from "../src/chatgpt-rotation.mjs";

function box() {
  const root = mkdtempSync(path.join(tmpdir(), "usage-probe-"));
  const homes = path.join(root, "homes");
  mkdirSync(homes, { recursive: true });
  return {
    root,
    homes,
    pool: path.join(root, "pool.json"),
    cache: path.join(root, "usage.json"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function writePool(file, ids, { selectedAccountId, perAccount = {} } = {}) {
  const accounts = {};
  for (const id of ids) {
    accounts[id] = {
      id,
      state: "active",
      paused: false,
      priority: 50,
      label: `${id} label`,
      createdAt: new Date().toISOString(),
      subscription: { status: "usable", usable: true },
      health: { state: "healthy" },
      turns: 0,
      requests: 0,
      ...(perAccount[id] || {}),
    };
  }
  writeFileSync(file, JSON.stringify({
    version: 1,
    policy: { enabled: true, mode: "switch", ...(selectedAccountId ? { selectedAccountId } : {}) },
    accounts,
    sessions: {},
  }));
}

test("the snapshot records each account's windows under the upstream names", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_firstfirst", "acct_secondsecond"], { selectedAccountId: "acct_firstfirst" });
    const seen = [];
    const snapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async ({ codexHome }) => {
        seen.push(path.basename(codexHome));
        return {
          fetchedAt: new Date().toISOString(),
          planType: "pro",
          primary: { remainingPercent: 55, windowDurationMins: 300, resetsAt: 123 },
          secondary: { remainingPercent: 12, windowDurationMins: 10080, resetsAt: 456 },
          resetCredits: { availableCount: 2 },
        };
      },
    });
    assert.equal(snapshot.accounts.length, 2);
    // Each account is probed in its OWN home; probing one home twice would
    // report the same subscription under two ids.
    assert.deepEqual(seen.sort(), ["acct_firstfirst", "acct_secondsecond"]);
    const first = snapshot.accounts.find((a) => a.id === "acct_firstfirst");
    assert.equal(first.primary.remainingPercent, 55);
    assert.equal(first.secondary.remainingPercent, 12);
    assert.equal(first.planType, "pro");
    assert.deepEqual(first.resetCredits, { availableCount: 2 });
    assert.equal(first.preferred, true);

    const written = JSON.parse(readFileSync(b.cache, "utf8"));
    assert.equal(written.accounts.length, 2);
    assert.ok(written.fetchedAt);
    // The document sits beside the credential store and is held to the same bound.
    assert.equal(privateFileIsProtected(b.cache), true);
  } finally { b.cleanup(); }
});

test("a probe failure is recorded as absent readings, never as a healthy account", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_brokenbroken"]);
    const snapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => { throw new Error("app-server unavailable"); },
    });
    const row = snapshot.accounts[0];
    assert.equal(row.primary, null);
    assert.equal(row.secondary, null);
    assert.match(row.error, /app-server unavailable/);
  } finally { b.cleanup(); }
});

test("the switched-in account is probed even when the limit truncates the run", async () => {
  const b = box();
  try {
    const ids = ["acct_aaaaaaaaaa", "acct_bbbbbbbbbb", "acct_selectedone"];
    writePool(b.pool, ids, { selectedAccountId: "acct_selectedone" });
    const snapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      probeLimit: 1,
      readUsage: async () => ({
        fetchedAt: new Date().toISOString(),
        planType: "plus",
        primary: { remainingPercent: 90, windowDurationMins: 300 },
        secondary: null,
      }),
    });
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].id, "acct_selectedone");
  } finally { b.cleanup(); }
});

test("paused accounts are not probed and a missing pool yields an empty snapshot", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_activeactive", "acct_pausedpaused"], {
      perAccount: { acct_pausedpaused: { paused: true } },
    });
    let calls = 0;
    const snapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), planType: null, primary: null, secondary: null };
      },
    });
    assert.equal(calls, 1);
    assert.equal(snapshot.accounts[0].id, "acct_activeactive");

    const absent = await probeChatGPTAccountUsage({
      poolPath: path.join(b.root, "no-pool.json"),
      homesDir: b.homes,
      cachePath: b.cache,
      write: false,
      readUsage: async () => { throw new Error("must not be called"); },
    });
    assert.deepEqual(absent.accounts, []);
  } finally { b.cleanup(); }
});

test("nextKnownResetAt finds the earliest upcoming reset timestamp across accounts", () => {
  const now = 1700000000000;
  const accounts = [
    { id: "acct_1", primary: { resetsAt: 1700005000000 }, secondary: { resetsAt: 1700050000000 } },
    { id: "acct_2", primary: { resetsAt: 1700002000000 }, secondary: null },
    { id: "acct_3", primary: { resetsAt: 1699999000000 } }, // past, should be ignored
  ];
  const earliest = nextKnownResetAt(accounts, { now });
  assert.equal(earliest, 1700002000000);

  // Works on Map too
  const map = new Map(accounts.map((a) => [a.id, a]));
  assert.equal(nextKnownResetAt(map, { now }), 1700002000000);
});

test("transient network probe error preserves previous known reset and quota windows", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_transient1"]);

    // First probe succeeds
    await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => ({
        fetchedAt: new Date().toISOString(),
        planType: "pro",
        primary: { remainingPercent: 40, resetsAt: 1800000000000 },
        secondary: { remainingPercent: 10, resetsAt: 1850000000000 },
      }),
    });

    // Second probe encounters a transient network timeout
    const secondSnapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => {
        throw new Error("ETIMEDOUT network socket hangup");
      },
    });

    const acct = secondSnapshot.accounts[0];
    // Previous quota and reset window are preserved rather than destroyed
    assert.equal(acct.primary?.remainingPercent, 40);
    assert.equal(acct.primary?.resetsAt, 1800000000000);
    assert.equal(acct.planType, "pro");
    assert.equal(acct.resetCredits, null);
    assert.match(acct.error, /ETIMEDOUT/);
  } finally { b.cleanup(); }
});

test("a partial rate-limit reply keeps the last verified plan tier", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_partialplan"]);
    await probeChatGPTAccountUsage({
      poolPath: b.pool, homesDir: b.homes, cachePath: b.cache,
      readUsage: async () => ({ planType: "plus", primary: { remainingPercent: 20 } }),
    });
    const partial = await probeChatGPTAccountUsage({
      poolPath: b.pool, homesDir: b.homes, cachePath: b.cache,
      readUsage: async () => ({ planType: null, primary: null, rateLimitError: "limits temporarily unavailable" }),
    });
    assert.equal(partial.accounts[0].planType, "plus");
  } finally { b.cleanup(); }
});

test("post-reset refresh waits for an older poll then starts a new quota read", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_freshafter"]);
    let release;
    let reads = 0;
    const slow = probeChatGPTAccountUsage({
      poolPath: b.pool, homesDir: b.homes, cachePath: b.cache,
      readUsage: async () => {
        reads += 1;
        await new Promise((resolve) => { release = resolve; });
        return { planType: "plus", resetCredits: { availableCount: 1 } };
      },
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const fresh = probeChatGPTAccountUsage({
      poolPath: b.pool, homesDir: b.homes, cachePath: b.cache,
      freshAfterInFlight: true,
      readUsage: async () => {
        reads += 1;
        return { planType: "plus", resetCredits: { availableCount: 0 } };
      },
    });
    release();
    await slow;
    const result = await fresh;
    assert.equal(reads, 2);
    assert.deepEqual(result.accounts[0].resetCredits, { availableCount: 0 });
  } finally { b.cleanup(); }
});

test("concurrent probe requests are deduplicated to a single in-flight execution", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_dedup1111", "acct_dedup2222"]);
    let readCount = 0;
    const slowReadUsage = async () => {
      readCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        fetchedAt: new Date().toISOString(),
        planType: "plus",
        primary: { remainingPercent: 80, resetsAt: Date.now() + 3600000 },
        secondary: null,
      };
    };

    // Fire 3 simultaneous probe calls
    const [snap1, snap2, snap3] = await Promise.all([
      probeChatGPTAccountUsage({ poolPath: b.pool, homesDir: b.homes, cachePath: b.cache, readUsage: slowReadUsage }),
      probeChatGPTAccountUsage({ poolPath: b.pool, homesDir: b.homes, cachePath: b.cache, readUsage: slowReadUsage }),
      probeChatGPTAccountUsage({ poolPath: b.pool, homesDir: b.homes, cachePath: b.cache, readUsage: slowReadUsage }),
    ]);

    // Exactly 2 read calls occurred (1 for each of the 2 accounts in the single run), NOT 6!
    assert.equal(readCount, 2);
    assert.equal(snap1.fetchedAt, snap2.fetchedAt);
    assert.equal(snap2.fetchedAt, snap3.fetchedAt);
  } finally { b.cleanup(); }
});

test("cache corruption resilience: truncated or invalid JSON is handled safely and overwritten atomically", async () => {
  const b = box();
  try {
    writePool(b.pool, ["acct_resilient1"]);

    // Write corrupted truncated JSON into cache file
    writeFileSync(b.cache, '{"accounts": [ {"id": "acct_resilient1", "primary": {');

    // Probing should NOT crash with JSON parse error; it should proceed and atomically replace it
    const snapshot = await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => ({
        fetchedAt: new Date().toISOString(),
        planType: "team",
        primary: { remainingPercent: 95, resetsAt: Date.now() + 10000 },
        secondary: null,
      }),
    });

    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].primary.remainingPercent, 95);

    // Verify cache file was atomically written as valid JSON
    const repairedCache = JSON.parse(readFileSync(b.cache, "utf8"));
    assert.equal(repairedCache.accounts[0].id, "acct_resilient1");
    assert.equal(repairedCache.accounts[0].primary.remainingPercent, 95);
  } finally { b.cleanup(); }
});

test("probe-driven auth healing (Path B): successful probe clears auth-invalid state", async () => {
  const b = box();
  resetRotationStateForTests();
  try {
    writePool(b.pool, ["acct_healauth1"]);

    // Mark account auth-invalid prior to probe
    markAccountAuthInvalid("acct_healauth1");
    assert.equal(isAccountAuthInvalid("acct_healauth1"), true);

    // Run usage probe that succeeds
    await probeChatGPTAccountUsage({
      poolPath: b.pool,
      homesDir: b.homes,
      cachePath: b.cache,
      readUsage: async () => ({
        fetchedAt: new Date().toISOString(),
        planType: "pro",
        primary: { remainingPercent: 50, resetsAt: Date.now() + 3600000 },
        secondary: null,
      }),
    });

    // Probe cleared the auth-invalid exclusion!
    assert.equal(isAccountAuthInvalid("acct_healauth1"), false);
  } finally { b.cleanup(); resetRotationStateForTests(); }
});
