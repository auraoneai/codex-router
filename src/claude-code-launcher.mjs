import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, claudeBaseUrl } from "./caller-auth.mjs";
import { CLAUDE_MODEL_PREFIX } from "./claude-model-id.mjs";
import {
  CALLER_SECRET_PATH,
  CLAUDE_CATALOG_PATH,
  CLAUDE_SETTINGS_PATH,
  PORTS,
} from "./paths.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

function readJson(target) {
  if (!existsSync(target)) return undefined;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch { return undefined; }
}

function explicitModel(args) {
  return args.some((value, index) => value === "--model" || value.startsWith("--model=") ||
    (index > 0 && args[index - 1] === "--model"));
}

function explicitModelValue(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value.startsWith("--model=")) return value.slice("--model=".length);
    if (value === "--model") return String(args[index + 1] ?? "");
  }
  return "";
}

// Only gateway-discovered ids are served; anything else reaches the router as
// an id it cannot route.
function routedModel(value) {
  const model = String(value ?? "");
  return model.startsWith(CLAUDE_MODEL_PREFIX) ? model : "";
}

// Claude Code resolves agent and background models through these names rather
// than through the session model. Left alone they fall back to literal
// Anthropic ids (claude-opus-5) the router does not serve, which surfaces as
// HTTP 404 model_not_found inside every spawned agent while the main loop
// keeps working. Built-in agents (Explore, Plan, ...) and user agents whose
// frontmatter pins `model: opus` take the default-tier aliases, not
// CLAUDE_CODE_SUBAGENT_MODEL, so all five have to point at a served model.
const AGENT_MODEL_VARIABLES = [
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function claudeRouterEnvironment({
  environment = process.env,
  args = [],
  secret,
  catalog = readJson(CLAUDE_CATALOG_PATH),
  settings = readJson(CLAUDE_SETTINGS_PATH),
} = {}) {
  const env = {
    ...environment,
    ANTHROPIC_BASE_URL: claudeBaseUrl(PORTS.router, secret),
    ANTHROPIC_AUTH_TOKEN: secret,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Routed model ids are intentionally gateway-owned rather than names from
    // Claude Code's built-in Anthropic catalog. Let the gateway report their
    // real limits instead of imposing Claude Code's unknown-model 200k cap.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    // Claude Code's attribution header changes the system prompt. A gateway
    // that translates protocols must opt out so provider prompt caching and
    // the router's request transforms see stable instructions.
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    // Deferred tool loading emits Anthropic-only tool_reference blocks. Keep
    // the ordinary concrete schemas until the canonical Responses path has a
    // proven representation for that beta feature.
    ENABLE_TOOL_SEARCH: "false",
  };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  delete env.CLAUDE_CODE_USE_MANTLE;
  // Thinking is never switched off through the router.
  delete env.CLAUDE_CODE_DISABLE_THINKING;
  if (String(env.MAX_THINKING_TOKENS ?? "").trim() === "0") delete env.MAX_THINKING_TOKENS;
  // Claude Code downgrades a settings-sourced effortLevel "max" to "high" on
  // the wire but honors CLAUDE_CODE_EFFORT_LEVEL verbatim, so export the
  // effective level unless the caller already chose one.
  const effort = typeof settings?.effortLevel === "string" ? settings.effortLevel.trim() : "";
  if (!String(env.CLAUDE_CODE_EFFORT_LEVEL ?? "").trim() && CLAUDE_EFFORT_LEVELS.has(effort)) {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  }

  const saved = typeof settings?.model === "string" ? settings.model : "";
  const routedDefault = catalog?.defaultModel ? String(catalog.defaultModel) : "";
  if (!explicitModel(args) && !saved.startsWith(CLAUDE_MODEL_PREFIX) && routedDefault) {
    // ANTHROPIC_DEFAULT_MODEL only exists in Claude Code 2.1.236+. The older
    // ANTHROPIC_MODEL works on supported versions and is still overridden by
    // an explicit `--model` argument.
    env.ANTHROPIC_MODEL = routedDefault;
  }
  // Agents belong on the model the session itself runs, in the order Claude
  // Code resolves it: `--model`, then the saved routed model, then the catalog
  // default. A caller who already pinned a served id keeps it; every other
  // value is an unserved fallback this launcher has to replace.
  const sessionModel = routedModel(explicitModelValue(args)) || routedModel(saved) || routedDefault;
  if (sessionModel) {
    for (const name of AGENT_MODEL_VARIABLES) {
      if (!routedModel(env[name])) env[name] = sessionModel;
    }
  }

  const fable = catalog?.models?.find?.((m) => m.slug === "anthropic-api/claude-fable-5.1" || m.slug?.endsWith("claude-fable-5.1"));
  if (fable && !env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = fable.id;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = "Claude Fable 5.1";
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = "Claude Fable 5.1 (Claude account pool)";
  }

  const opus = catalog?.models?.find?.((m) => m.slug === "anthropic-api/claude-opus-5.5" || m.slug?.endsWith("claude-opus-5.5"));
  if (opus && env.ANTHROPIC_DEFAULT_OPUS_MODEL === opus.id && !env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = "Claude Opus 5.5";
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = "Claude Opus 5.5 (Claude account pool)";
  }

  return env;
}

export function launchClaudeCode(args = process.argv.slice(2)) {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The router caller key is missing; run ./bin/model-router claude doctor --fix.");
  }
  if (!existsSync(CLAUDE_CATALOG_PATH)) {
    throw new Error("Claude Code has not been connected; run ./bin/model-router claude enable.");
  }
  const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  const command = process.env.CLAUDE_CODE_BIN || (process.platform === "win32" ? "claude.cmd" : "claude");
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    env: claudeRouterEnvironment({ args, secret }),
    stdio: "inherit",
    ...spawnable.options,
  });
  child.once("error", (error) => {
    console.error(`Could not start ${command}: ${error.message}. Install Claude Code first, or set CLAUDE_CODE_BIN.`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launchClaudeCode(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
