import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  engineeringLeadInput,
  engineeringRoleInput,
  engineeringToggleArgs,
  engineeringToggleInputArgs,
} from "../electron/ipc.mjs";

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

  await api.setEngineeringRole(
    "reviewer",
    [{ model: "gpt-5.6-sol", effort: "low" }],
    [{ model: "kiro-prism/claude-opus-5", effort: "max" }],
    8,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ["router-control:setEngineeringRole", {
    role: "reviewer",
    candidates: [{ model: "gpt-5.6-sol", effort: "low" }],
    optionalCandidates: [{ model: "kiro-prism/claude-opus-5", effort: "max" }],
    revision: 8,
    reset: false,
  }]);
  await api.setEngineeringLead("gpt-6-astra", "low", 9);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), ["router-control:setEngineeringLead", {
    model: "gpt-6-astra", effort: "low", revision: 9,
  }]);
});

test("engineering role and lead editors validate exact routes, efforts, ordering, and revisions", () => {
  assert.deepEqual(engineeringRoleInput({
    role: "integrator",
    candidates: [
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "kiro-prism/claude-sonnet-5", effort: "max" },
    ],
    optionalCandidates: [],
    revision: 4,
    reset: false,
  }).candidates.map(({ model, effort }) => [model, effort]), [
    ["gpt-5.6-sol", "low"],
    ["kiro-prism/claude-sonnet-5", "max"],
  ]);
  assert.deepEqual(
    engineeringRoleInput({ role: "integrator", candidates: [], optionalCandidates: [], revision: 5, reset: true }),
    { role: "integrator", revision: 5, reset: true },
  );
  assert.deepEqual(engineeringLeadInput({ model: "gpt-6-astra", effort: "low", revision: 6 }), {
    model: "gpt-6-astra", effort: "low", revision: 6,
  });
  assert.throws(() => engineeringRoleInput({
    role: "integrator",
    candidates: [{ model: "gpt-5.6-sol", effort: "low" }, { model: "gpt-5.6-sol", effort: "high" }],
    optionalCandidates: [],
    revision: 4,
  }), /must be unique/u);
  assert.throws(() => engineeringLeadInput({ model: "gpt-6-astra", effort: "impossible", revision: 6 }), /must be one of/u);
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

test("settings exposes editable models, efforts, ordered fallbacks, reset, and usage confidence", async () => {
  const [settings, types, messages] = await Promise.all([
    readFile(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /engineering\?\.activePreset/u);
  assert.match(settings, /role\.candidates/u);
  assert.match(settings, /role\.optionalCandidates/u);
  assert.match(settings, /settings\.engineering\.role\.fallbacks/u);
  assert.match(settings, /api\.setEngineeringRole/u);
  assert.match(settings, /api\.setEngineeringLead/u);
  assert.match(settings, /moveCandidate/u);
  assert.match(settings, /settings\.engineering\.editor\.reset/u);
  assert.match(settings, /total\.measured/u);
  assert.match(settings, /total\.estimated/u);
  assert.match(settings, /total\.unknown/u);
  assert.match(types, /engineering\?: EngineeringPolicySnapshot/u);
  assert.doesNotMatch(types, /policy\?: EngineeringPolicyDocument/u);
  assert.match(messages, /"settings\.engineering\.usage\.measured": "Measured"/u);
  assert.match(messages, /"settings\.engineering\.usage\.estimated": "Estimated"/u);
  assert.match(messages, /"settings\.engineering\.usage\.unknown": "Unknown"/u);
  assert.match(messages, /"settings\.engineering\.effort\.defaultResolved"/u);
});
