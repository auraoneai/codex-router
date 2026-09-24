import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeRotationWiring, nativeUsageProbeWiring } from "../scripts/verify-custom-features.mjs";

const router = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");

test("native rotation verifier accepts the active cooldown and detached probes", () => {
  assert.equal(nativeRotationWiring(router).ok, true);
  assert.equal(nativeUsageProbeWiring(router).ok, true);
});

for (const headers of ["headers", "nextHeaders"]) {
  test(`native rotation verifier rejects missing ${headers} cooldown despite legacy wrapper`, () => {
    const mutated = router.replace(`coolNativeAccount(${headers}, upstream.status);`, "/* removed */");
    assert.notEqual(mutated, router);
    assert.equal(nativeRotationWiring(mutated).ok, false);
  });
}

test("probe verifier rejects a probe awaited in native header selection", () => {
  const mutated = router.replace("function nativeHeaders(request) {", `async function nativeHeaders(request) {
    const { probeChatGPTAccountUsage: refreshUsage } = await import("./chatgpt-usage-probe.mjs");
    await refreshUsage();`);
  assert.notEqual(mutated, router);
  assert.equal(nativeUsageProbeWiring(mutated).ok, false);
});

test("probe verifier rejects emergency refresh becoming awaitable", () => {
  const mutated = router.replace('  import("./chatgpt-usage-probe.mjs").then', '  return import("./chatgpt-usage-probe.mjs").then');
  assert.notEqual(mutated, router);
  assert.equal(nativeUsageProbeWiring(mutated).ok, false);
});

test("probe verifier rejects cache reader disconnected from rotation", () => {
  const mutated = router.replaceAll("usageById: cachedAccountUsageById()", "usageById: new Map()");
  assert.notEqual(mutated, router);
  assert.equal(nativeUsageProbeWiring(mutated).ok, false);
});
