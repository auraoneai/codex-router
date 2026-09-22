import assert from "node:assert/strict";
import test from "node:test";

import { engineeringNativeModelsFromCatalog } from "../src/engineering/native-model-inventory.mjs";

test("engineering native inventory keeps listed v2 routes and their advertised metadata", () => {
  const catalog = {
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6-Sol",
        visibility: "list",
        multi_agent_version: "v2",
        default_reasoning_level: "medium",
        context_window: 272000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        slug: "gpt-6-luna",
        display_name: "GPT-6-Luna",
        visibility: "list",
        multi_agent_version: "v2",
        default_reasoning_level: "medium",
        context_window: 272000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      },
      { slug: "gpt-hidden", visibility: "hide", multi_agent_version: "v2", supported_reasoning_levels: ["low"] },
      { slug: "gpt-v1", visibility: "list", multi_agent_version: "v1", supported_reasoning_levels: ["low"] },
      { slug: "custom/gpt-6-sol", visibility: "list", multi_agent_version: "v2", supported_reasoning_levels: ["low"] },
    ],
  };

  const models = engineeringNativeModelsFromCatalog(catalog);
  assert.deepEqual(models.map((model) => model.slug), ["gpt-6-sol", "gpt-6-luna"]);
  assert.equal(models[0].native, true);
  assert.equal(models[0].multiAgentVersion, "v2");
  assert.equal(models[0].contextWindow, 272000);
  assert.equal(models[0].defaultEffort, "medium");
  assert.deepEqual(models[0].inputModalities, ["text", "image"]);
  assert.deepEqual(models[0].reasoningLevels.map(({ effort }) => effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(models[1].reasoningLevels.map(({ effort }) => effort), ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(models.every((model) => !model.reasoningLevels.some(({ effort }) => effort === "none")));
});
