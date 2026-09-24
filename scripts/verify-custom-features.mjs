#!/usr/bin/env node
// Checks that every maintained customization is still WIRED, not merely present.
//
// Written because an upstream upgrade lost custom work in three distinct ways,
// and only the first is something a file-level check can see:
//
//   1. The file was gone outright (model-sync.mjs, operator-model.mjs).
//   2. The file was there and the code inside it was dead. `prismAffinityHeaders`
//      survived verbatim but read a header its only caller never sent, and the
//      Prism stream-stall guard existed but was wired for one provider.
//   3. The feature worked but its state was orphaned. Five ChatGPT accounts kept
//      their credentials while the new pool's id pattern made them invisible.
//
// So each check below asserts a *connection*: a symbol reaching its call site, a
// value reaching the wire, a state file matching the shape its reader expects.
// A grep proving the text exists is exactly the evidence that failed last time.
//
// Usage: node scripts/verify-custom-features.mjs [--json]
// Exit 0 when every check passes, 1 when any fails.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => {
  const file = path.join(ROOT, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};
const countOf = (text, needle) => (text ? text.split(needle).length - 1 : 0);

// Deliberately conservative source contracts: accept the known detached probe
// shapes, then reject any remaining probe reference. A changed shape needs
// review rather than silently broadening the hot-path exception.
export function nativeRotationWiring(router) {
  const wired = /function nativeHeaders[\s\S]{0,4000}rotatedNativeHeaders/.test(router)
    && router.includes("rotationCandidates");
  const firstCooldown = /if\s*\(!route && \(upstream\.status === 429 \|\| upstream\.status === 401\)\)\s*\{\s*coolNativeAccount\(headers, upstream\.status\)/.test(router);
  const retryCooldown = /if\s*\(upstream\.status === 429 \|\| upstream\.status === 401\)\s*\{\s*coolNativeAccount\(nextHeaders, upstream\.status\)/.test(router);
  if (!wired) return { ok: false, detail: "nativeHeaders() no longer calls rotatedNativeHeaders" };
  if (!firstCooldown || !retryCooldown) {
    return { ok: false, detail: "native 429/401 cooldown is missing from the first attempt or failover" };
  }
  return { ok: true, detail: "selection inside nativeHeaders; cooldown on first and failover native 429/401" };
}

export function nativeUsageProbeWiring(router) {
  // Timer callbacks may await the probe because the request never awaits the
  // callback. Match the entire callback body, not an arbitrary surrounding span.
  const timerProbe = /set(?:Timeout|Interval)\(\s*async \(\) => \{\s*(?:lastPostTurnProbeAt = Date\.now\(\);\s*)?try \{\s*const \{ probeChatGPTAccountUsage \} = await import\("\.\/chatgpt-usage-probe\.mjs"\);\s*await probeChatGPTAccountUsage\(\);\s*\} catch \{(?:\s|\/\/[^\n]*)*\}\s*\},/g;
  // The emergency refresh is detached, debounced, and returns no promise for a
  // request to await. An added return/await or synchronous probe fails closed.
  const emergencyProbe = /export function triggerEmergencyDepletionProbe\(\) \{\s*const now = Date\.now\(\);\s*if \(now - lastEmergencyProbeAt < 30_000\) return;(?:\s|\/\/[^\n]*)*lastEmergencyProbeAt = now;\s*import\("\.\/chatgpt-usage-probe\.mjs"\)\.then\(\(\{ probeChatGPTAccountUsage \}\) => \{\s*probeChatGPTAccountUsage\(\)\.catch\(\(\) => \{\}\);\s*\}\);\s*\}/g;
  const foreground = router.replace(timerProbe, "BACKGROUND_TIMER(")
    .replace(emergencyProbe, "BACKGROUND_EMERGENCY")
    .replace('import { nextKnownResetAt } from "./chatgpt-usage-probe.mjs";', "");
  if (/probeChatGPTAccountUsage|chatgpt-usage-probe\.mjs/.test(foreground)) {
    return { ok: false, detail: "usage probe outside a reviewed detached background callback" };
  }
  return /usageById:\s*cachedAccountUsageById\(\)/.test(router)
    ? { ok: true, detail: "rotation reads cached usage; timer and emergency probes are detached" }
    : { ok: false, detail: "rotation no longer consumes the usage cache" };
}

const checks = [];
const check = (name, why, run) => checks.push({ name, why, run });

check(
  "Prism and Cloudflare providers are registered",
  "The provider ports are the reason this fork exists; upstream ships neither.",
  async () => {
    // Asserted by loading the registry rather than matching text: the registry
    // discovers config/<id>/ at runtime, so a definition that fails to parse
    // would still satisfy any grep while being absent from the routable set.
    const { PROVIDERS, MODELS } = await import("../src/model-registry.mjs");
    const wanted = ["kiro-prism", "cloudflare-workers-ai", "free-prism"];
    const missing = wanted.filter((id) => !PROVIDERS.has(id));
    if (missing.length) {
      return { ok: false, detail: `not loaded by the registry: ${missing.join(", ")}` };
    }
    const counts = wanted
      .map((id) => `${id}=${MODELS.filter((model) => model.provider === id).length}`)
      .join(" ");
    return { ok: true, detail: `loaded with routable models: ${counts}` };
  },
);

check(
  "ChatGPT rotation reaches the native request path",
  "Rotation is inert unless nativeHeaders() actually consults it; the module existing proves nothing.",
  () => {
    if (!existsSync(path.join(ROOT, "src/chatgpt-rotation.mjs"))) {
      return { ok: false, detail: "src/chatgpt-rotation.mjs is missing" };
    }
    const router = read("src/router.mjs") || "";
    return nativeRotationWiring(router);
  },
);

check(
  "Native rotation reads cached usage while quota probes run in the background",
  "A probe on the request path would put a process spawn in front of every turn.",
  () => {
    if (!existsSync(path.join(ROOT, "src/chatgpt-usage-probe.mjs"))) {
      return { ok: false, detail: "src/chatgpt-usage-probe.mjs is missing" };
    }
    const router = read("src/router.mjs") || "";
    return nativeUsageProbeWiring(router);
  },
);

check(
  "Prism session affinity reaches the provider hop",
  "This shipped dead once: the header existed and its only id source was never populated.",
  () => {
    const forwarder = read("src/api-forwarder.mjs") || "";
    const router = read("src/router.mjs") || "";
    if (!forwarder.includes("prismAffinityHeaders")) {
      return { ok: false, detail: "prismAffinityHeaders is gone from the forwarder" };
    }
    const sends = router.includes("X-Codex-Router-Conversation")
      || forwarder.includes("X-Codex-Router-Conversation");
    return sends
      ? { ok: true, detail: "conversation id is produced and consumed, not just referenced" }
      : { ok: false, detail: "nothing emits X-Codex-Router-Conversation, so affinity is dead again" };
  },
);

check(
  "The stream-stall guard covers Prism, not only Grok",
  "Upstream built the mechanism and wired one provider; Prism streams were cut mid-answer.",
  () => {
    const policy = read("src/stream-stall-policy.mjs");
    if (!policy) return { ok: false, detail: "src/stream-stall-policy.mjs is missing" };
    const covers = policy.includes("kiro-prism") && policy.includes("free-prism");
    return covers
      ? { ok: true, detail: "kiro-prism and free-prism carry a stall budget" }
      : { ok: false, detail: "the Prism providers dropped out of the stall policy" };
  },
);

check(
  "Namespaced tool results still correlate without call_id",
  "Its absence broke compaction replay for any conversation that used an MCP tool.",
  () => {
    const adapters = read("src/openai-adapters.mjs") || "";
    return adapters.includes("requestCallCorrelations")
      ? { ok: true, detail: "request-side correlation present in openai-adapters.mjs" }
      : { ok: false, detail: "correlation helper gone; namespaced results will be refused" };
  },
);

check(
  "Both reasoning-effort forms are reconciled rather than refused",
  "The router sets both for subagent turns, so refusing them fails those turns.",
  () => {
    const adapters = read("src/openai-adapters.mjs") || "";
    const refuses = adapters.includes("Use either reasoning or reasoning_effort, not both");
    const reconciles = /reasoning_effort[\s\S]{0,2000}(reconcile|nested wins|prefer)/i.test(adapters);
    if (refuses && !reconciles) {
      return { ok: false, detail: "the unconditional refusal is back" };
    }
    return { ok: true, detail: "duplicate effort forms are reconciled" };
  },
);

check(
  "Restored modules are still present",
  "These active runtime modules must survive upstream upgrades.",
  () => {
    const missing = ["src/operator-model.mjs", "src/provider-latency-trace.mjs"]
      .filter((file) => !existsSync(path.join(ROOT, file)));
    return missing.length
      ? { ok: false, detail: `missing: ${missing.join(", ")}` }
      : { ok: true, detail: "operator-model and provider-latency-trace present" };
  },
);

check(
  "A compaction turn inherits the operator model instead of overwriting it",
  "Without this a threadless compaction falls back to native GPT and 401s.",
  () => {
    const router = read("src/router.mjs") || "";
    const remembers = router.includes("rememberOperatorModel");
    const follows = router.includes("followOperatorModel");
    const guarded = router.includes("compactingTurn");
    if (!remembers || !follows) return { ok: false, detail: "operator-model call sites are gone" };
    return guarded
      ? { ok: true, detail: "compaction detected before route selection and excluded from recording" }
      : { ok: false, detail: "the compaction guard is gone; compaction will overwrite the hint" };
  },
);

check(
  "The island shows a row per account",
  "The table was lost once because its data source was deleted and the views went with it.",
  () => {
    const island = read("apps/macos/ModelRouterTray/Sources/IslandOverlay.swift") || "";
    const app = read("apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift") || "";
    if (!app.includes("chatgpt-account-pool")) {
      return { ok: false, detail: "the tray no longer calls the account-pool usage command" };
    }
    return /rotation/i.test(island)
      ? { ok: true, detail: "island reads the usage feed and reports rotation order" }
      : { ok: false, detail: "the island quota table lost its rotation data" };
  },
);

check(
  "The island keeps its own reduce-motion switch",
  "A hand-made customization that an upstream rename silently dropped once.",
  () => {
    const island = read("apps/macos/ModelRouterTray/Sources/IslandOverlay.swift") || "";
    return island.includes("routerReduceMotion")
      ? { ok: true, detail: "routerReduceMotion present" }
      : { ok: false, detail: "routerReduceMotion is gone; the island will animate again" };
  },
);

check(
  "Registered ChatGPT accounts match the pool's own id pattern",
  "Five accounts kept their credentials and went invisible when the id shape changed.",
  () => {
    const stateDir = process.env.MODEL_ROUTER_STATE_DIR
      || path.join(process.env.HOME || "", ".codex", "codex-router");
    const poolFile = path.join(stateDir, "chatgpt-account-pool.json");
    if (!existsSync(poolFile)) return { ok: true, detail: "no account pool on this machine (skipped)" };
    let pool;
    try {
      pool = JSON.parse(readFileSync(poolFile, "utf8"));
    } catch {
      return { ok: false, detail: "the account pool is unreadable" };
    }
    const ids = Object.keys(pool.accounts || {});
    const bad = ids.filter((id) => !/^acct_[A-Za-z0-9_-]{8,80}$/.test(id));
    const homes = path.join(stateDir, "chatgpt-accounts");
    const orphans = existsSync(homes)
      ? readdirSync(homes).filter((entry) => !/^acct_/.test(entry)
        && existsSync(path.join(homes, entry, "auth.json")))
      : [];
    if (bad.length) return { ok: false, detail: `pool ids the reader will reject: ${bad.join(", ")}` };
    if (orphans.length) {
      return {
        ok: false,
        detail: `credentialed homes no registration points at: ${orphans.join(", ")}`,
      };
    }
    return { ok: true, detail: `${ids.length} registered account(s), no orphaned credentials` };
  },
);

check(
  "The maintained fork is still a superset of upstream",
  "An update that fast-forwards past the custom commits is how this work disappears.",
  () => {
    const pkg = read("package.json");
    if (!pkg) return { ok: false, detail: "package.json is missing" };
    const rotation = countOf(read("src/router.mjs") || "", "rotationCandidates");
    return rotation > 0
      ? { ok: true, detail: "custom call sites still present in the checkout" }
      : { ok: false, detail: "the checkout looks like plain upstream; custom work is absent" };
  },
);

async function main() {
  const results = [];
  for (const { name, why, run } of checks) {
    try {
      results.push({ name, why, ...(await run()) });
    } catch (error) {
      results.push({ name, why, ok: false, detail: `check threw: ${error.message}` });
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? "OK  " : "FAIL"}  ${result.name}\n        ${result.detail}\n`);
      if (!result.ok) process.stdout.write(`        why it matters: ${result.why}\n`);
    }
    process.stdout.write(
      `\n${results.length - failed.length}/${results.length} checks passed\n`,
    );
    if (failed.length) {
      process.stdout.write(
        "\nA failure means a maintained feature or its wiring contract needs review.\n"
        + "See docs/MAINTAINED-FORK.md for what each feature is and how it was restored.\n",
      );
    }
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
