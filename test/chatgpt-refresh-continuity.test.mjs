import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  redeemChatGPTSubscriptionAccountResetCredit,
  refreshChatGPTSubscriptionAccount,
  writeChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import { poolExhaustionReport, rotationCandidates } from "../src/chatgpt-rotation.mjs";
import { probeChatGPTAccountUsage } from "../src/chatgpt-usage-probe.mjs";
import { protectPrivateFile } from "../src/file-security.mjs";

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function writeAuth(file, accountId, email, marker, expiresInSeconds = 3600) {
  writeFileSync(file, JSON.stringify({
    tokens: {
      account_id: accountId,
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, marker }),
      refresh_token: `${marker}-refresh`,
      id_token: jwt({ email }),
    },
  }), { mode: 0o600 });
  protectPrivateFile(file);
}

test("selected account operations use live credentials and skip duplicate saved-profile refresh", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "account-continuity-"));
  try {
    const filePath = path.join(root, "pool.json");
    const homesDir = path.join(root, "homes");
    const primaryHome = path.join(root, "primary");
    const switchPath = path.join(root, "switch.json");
    const cachePath = path.join(root, "usage.json");
    mkdirSync(primaryHome, { mode: 0o700 });
    const selected = createChatGPTSubscriptionAccount({ filePath, homesDir });
    const other = createChatGPTSubscriptionAccount({ filePath, homesDir });
    const pool = readChatGPTAccountPoolState(filePath);
    pool.accounts[selected.id].identity = { accountId: "selected-backend", email: "selected@example.com" };
    pool.accounts[other.id].identity = { accountId: "other-backend", email: "other@example.com" };
    pool.policy.selectedAccountId = selected.id;
    writeChatGPTAccountPoolState(pool, filePath);
    writeAuth(chatGPTSubscriptionAccountAuthPath(selected.id, { homesDir }), "selected-backend", "selected@example.com", "stale-copy");
    writeAuth(chatGPTSubscriptionAccountAuthPath(other.id, { homesDir }), "other-backend", "other@example.com", "other-copy");
    writeAuth(path.join(primaryHome, "auth.json"), "selected-backend", "selected@example.com", "live-primary");
    writeFileSync(switchPath, JSON.stringify({
      version: 1, desired: selected.id, active: selected.id, pending: false, phase: "idle",
    }), { mode: 0o600 });
    protectPrivateFile(switchPath);
    const primaryBefore = readFileSync(path.join(primaryHome, "auth.json"));
    const liveToken = JSON.parse(primaryBefore).tokens.access_token;

    const candidates = rotationCandidates({ poolPath: filePath, homesDir, primaryHome, switchPath });
    assert.equal(candidates.length, 2);
    assert.equal(candidates.find((row) => row.id === selected.id).headers.authorization,
      `Bearer ${liveToken}`);
    assert.equal(candidates.find((row) => row.id === other.id).headers["chatgpt-account-id"], "other-backend");

    const probedHomes = [];
    await probeChatGPTAccountUsage({
      poolPath: filePath, homesDir, primaryHome, switchPath, cachePath,
      readUsage: async ({ codexHome }) => {
        probedHomes.push(codexHome);
        return { fetchedAt: new Date().toISOString(), planType: "plus", primary: { remainingPercent: 50 } };
      },
    });
    assert.deepEqual(new Set(probedHomes), new Set([primaryHome, path.join(homesDir, other.id)]));

    let refreshSpawned = false;
    assert.equal(await refreshChatGPTSubscriptionAccount(selected.id, {
      filePath, homesDir, primaryHome, switchPath, force: true,
      spawnImpl: () => { refreshSpawned = true; throw new Error("unexpected refresh"); },
    }), false);
    assert.equal(refreshSpawned, false);

    let redeemedHome;
    const redeemed = await redeemChatGPTSubscriptionAccountResetCredit(selected.id, {
      filePath, homesDir, primaryHome, switchPath,
      consume: async ({ codexHome }) => { redeemedHome = codexHome; return { outcome: "reset" }; },
      refreshUsage: async () => ({ accounts: [] }),
    });
    assert.equal(redeemed.redeemed, true);
    assert.equal(redeemedHome, primaryHome);
    assert.deepEqual(readFileSync(path.join(primaryHome, "auth.json")), primaryBefore);
    writeAuth(path.join(primaryHome, "auth.json"),
      "selected-backend", "selected@example.com", "near-expiry", 5 * 60);
    await assert.rejects(redeemChatGPTSubscriptionAccountResetCredit(selected.id, {
      filePath, homesDir, primaryHome, switchPath,
      consume: async () => { throw new Error("unexpected consume"); },
    }), /Wait for the desktop login to refresh/);
    writeFileSync(path.join(primaryHome, "auth.json"), primaryBefore, { mode: 0o600 });
    protectPrivateFile(path.join(primaryHome, "auth.json"));

    writeAuth(chatGPTSubscriptionAccountAuthPath(selected.id, { homesDir }),
      "selected-backend", "selected@example.com", "expired-copy", -60);
    assert.equal(poolExhaustionReport({
      poolPath: filePath, homesDir, primaryHome, switchPath,
      usageById: { [other.id]: { secondary: { remainingPercent: 0 } } },
    }), null);
    writeAuth(chatGPTSubscriptionAccountAuthPath(selected.id, { homesDir }),
      "selected-backend", "selected@example.com", "stale-copy");
    const savedToken = JSON.parse(readFileSync(chatGPTSubscriptionAccountAuthPath(selected.id, { homesDir }))).tokens.access_token;

    // A login changed outside the profile switch. Identity validation must
    // keep that other account's primary token out of this saved account.
    writeAuth(path.join(primaryHome, "auth.json"), "different-backend", "different@example.com", "different-primary");
    const afterMismatch = rotationCandidates({ poolPath: filePath, homesDir, primaryHome, switchPath });
    assert.equal(afterMismatch.find((row) => row.id === selected.id).headers.authorization,
      `Bearer ${savedToken}`);

    // Even a saved auth file replaced after registration must not borrow the
    // account's label while carrying a different ChatGPT identity.
    writeAuth(chatGPTSubscriptionAccountAuthPath(selected.id, { homesDir }),
      "different-backend", "different@example.com", "unexpected-copy");
    const afterSavedMismatch = rotationCandidates({ poolPath: filePath, homesDir, primaryHome, switchPath });
    assert.equal(afterSavedMismatch.some((row) => row.id === selected.id), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
