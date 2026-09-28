import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

// Upstream discovery endpoints disagree with the limits providers actually
// enforce -- Kiro Prism's /v1/models advertises 1M for GPT-5.6 while its own
// request budget is 272K, and Nous advertises 1,048,576 for Anthropic models
// whose window is 1,000,000. The registry is therefore checked against these
// documented limits rather than against any /v1/models response. A registry
// entry may declare less (a conservative default) but never more.
const AUTHORITY = [
  {
    // https://platform.claude.com/docs/en/about-claude/models
    name: "Anthropic 1M-context Claude models",
    matches: (m) => /claude-(opus-(5([.-]5)?|4[.-][678])|fable-5([.-]1)?|sonnet-(5|4[.-]6))\b/.test(String(m.upstreamModel)),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    name: "Claude Haiku 4.5",
    matches: (m) => /claude-haiku-4[.-]5/.test(String(m.upstreamModel)),
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  {
    // https://developers.cloudflare.com/workers-ai/models/glm-5.3/ (and -flash)
    name: "Cloudflare GLM-5.3 family",
    matches: (m) => m.provider === "cloudflare-workers-ai" && /glm-5\.3/.test(String(m.upstreamModel)),
    contextWindow: 1_310_720,
  },
  {
    // Gemini API models.get: inputTokenLimit / outputTokenLimit
    name: "Gemini 3.8 Flash (Gemini API)",
    matches: (m) => m.provider === "gemini-api" && /gemini-3\.8-flash$/.test(String(m.upstreamModel)),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    // kiro-prism kiro_prism/context_budget.py: (272_000, 272_000, 128_000);
    // LLM.md: Sol/Terra/Luna auto-compact at 220k.
    name: "Kiro Prism GPT-5.6",
    matches: (m) => m.provider === "kiro-prism" && /^gpt-5\.6-/.test(String(m.upstreamModel)),
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    maxAutoCompact: 220_000,
  },
  {
    // kiro-prism LLM.md: Opus/Sonnet auto-compact at 650k of a 1M window.
    name: "Kiro Prism Claude",
    matches: (m) => m.provider === "kiro-prism" && /^claude-/.test(String(m.upstreamModel)),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxAutoCompact: 650_000,
  },
  {
    // https://models.dev/api.json -> opencode-go.models["mimo-v2.6-flash"].limit
    name: "MiMo-V2.6-Flash (opencode Go)",
    matches: (m) => m.provider === "opencode-go" && m.upstreamModel === "mimo-v2.6-flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  },
];

test("no registry model declares more context or output than its documented limit", () => {
  const checked = [];
  for (const model of MODEL_BY_SLUG.values()) {
    for (const rule of AUTHORITY) {
      if (!rule.matches(model)) continue;
      checked.push(model.slug);
      assert.ok(
        model.contextWindow <= rule.contextWindow,
        `${model.slug} declares ${model.contextWindow} tokens; ${rule.name} allows ${rule.contextWindow}`,
      );
      if (rule.maxOutputTokens !== undefined && model.maxOutputTokens !== undefined) {
        assert.ok(
          model.maxOutputTokens <= rule.maxOutputTokens,
          `${model.slug} declares ${model.maxOutputTokens} output tokens; ${rule.name} allows ${rule.maxOutputTokens}`,
        );
      }
      if (rule.maxAutoCompact !== undefined) {
        assert.ok(
          model.autoCompact <= rule.maxAutoCompact,
          `${model.slug} compacts at ${model.autoCompact}; ${rule.name} budgets ${rule.maxAutoCompact}`,
        );
      }
    }
  }
  assert.ok(checked.length >= 20, `expected the authority table to cover the Claude, Prism, GLM and Gemini routes (${checked.length})`);
});

test("every listed model compacts before its declared window", () => {
  for (const model of MODEL_BY_SLUG.values()) {
    if (!model.listed || !Number.isInteger(model.autoCompact)) continue;
    assert.ok(
      model.autoCompact < model.contextWindow,
      `${model.slug} compacts at ${model.autoCompact}, at or past its ${model.contextWindow}-token window`,
    );
  }
});
