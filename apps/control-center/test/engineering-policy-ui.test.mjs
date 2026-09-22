import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { engineeringToggleArgs, engineeringToggleInputArgs } from "../electron/ipc.mjs";

test("engineering toggle arguments are exact and revision guarded", () => {
  assert.deepEqual(engineeringToggleArgs(true, 0), ["engineering", "on", "--revision", "0"]);
  assert.deepEqual(engineeringToggleArgs(false, 42), ["engineering", "off", "--revision", "42"]);

  for (const [enabled, revision] of [
    ["true", 1],
    [true, -1],
    [false, 1.5],
    [false, Number.MAX_SAFE_INTEGER + 1],
    [false, undefined],
  ]) {
    assert.throws(
      () => engineeringToggleArgs(enabled, revision),
      /enabled must be boolean|non-negative safe integer/u,
    );
  }

  assert.deepEqual(
    engineeringToggleInputArgs({ enabled: true, revision: 9 }),
    ["engineering", "on", "--revision", "9"],
  );
  for (const input of [
    null,
    [],
    { enabled: true },
    { enabled: true, revision: 1, command: "status" },
  ]) {
    assert.throws(
      () => engineeringToggleInputArgs(input),
      /must be an object|must contain only enabled and revision/u,
    );
  }
});

test("preload sends only the engineering choice and observed revision", async () => {
  const source = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const calls = [];
  let api;
  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: {
          invoke: async (channel, input) => calls.push([channel, input]),
          on() {},
          send() {},
          removeListener() {},
        },
      };
    },
  });

  await api.setEngineeringEnabled(true, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "router-control:setEngineeringEnabled");
  assert.equal(calls[0][1].enabled, true);
  assert.equal(calls[0][1].revision, 7);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["enabled", "revision"]);
});

test("settings fail closed for absent or degraded engineering snapshots", async () => {
  const source = await readFile(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /engineering\.fresh === true/u);
  assert.match(source, /engineering\.degraded !== true/u);
  assert.match(source, /Number\.isSafeInteger\(engineering\.revision\)/u);
  assert.match(source, /engineeringKnownFresh \? \(/u);
  assert.match(source, /settings\.engineering\.status\.degraded/u);
  assert.match(source, /api\.setEngineeringEnabled\(enabled, revision\)/u);
  assert.match(source, /optimisticToggles\.mutate\(/u);
});

test("settings preview exposes preset routes, efforts, fallbacks, and usage confidence", async () => {
  const [settings, types, messages] = await Promise.all([
    readFile(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /engineering\?\.activePreset/u);
  assert.match(settings, /role\.candidates/u);
  assert.match(settings, /role\.optionalCandidates/u);
  assert.match(settings, /settings\.engineering\.role\.fallbacks/u);
  assert.match(settings, /total\.measured/u);
  assert.match(settings, /total\.estimated/u);
  assert.match(settings, /total\.unknown/u);
  assert.match(types, /engineering\?: EngineeringPolicySnapshot/u);
  assert.doesNotMatch(types, /policy\?: EngineeringPolicyDocument/u);
  assert.match(messages, /"settings\.engineering\.usage\.measured": "Measured"/u);
  assert.match(messages, /"settings\.engineering\.usage\.estimated": "Estimated"/u);
  assert.match(messages, /"settings\.engineering\.usage\.unknown": "Unknown"/u);
});
