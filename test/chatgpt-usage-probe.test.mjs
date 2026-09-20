import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { probeChatGPTAccountUsage } from "../src/chatgpt-usage-probe.mjs";

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
    assert.equal(first.preferred, true);

    const written = JSON.parse(readFileSync(b.cache, "utf8"));
    assert.equal(written.accounts.length, 2);
    assert.ok(written.fetchedAt);
    // The document sits beside the credential store and is held to the same bound.
    assert.equal(statSync(b.cache).mode & 0o777, 0o600);
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
