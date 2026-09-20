import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "operator-model-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_OPERATOR_MODEL = path.join(stateDir, "operator-model.json");

const {
  followOperatorModel,
  isNativeOpenAIRoute,
  readOperatorModel,
  rememberOperatorModel,
} = await import("../src/operator-model.mjs");

test("operator model follow stays on the last routed pick", () => {
  const prism = { slug: "kiro-prism/gpt-5.6-sol", provider: "kiro-prism" };
  const grok = { slug: "kiro-prism/grok-4.6", provider: "kiro-prism" };
  const native = { slug: "gpt-6-astra", provider: "openai" };
  const modelsBySlug = new Map([[prism.slug, prism], [grok.slug, grok], [native.slug, native]]);
  const enabledProviders = ["kiro-prism", "openai"];

  rememberOperatorModel(prism);
  assert.deepEqual(readOperatorModel(), { slug: prism.slug, native: false });
  assert.equal(followOperatorModel(native, { modelsBySlug, enabledProviders }), prism);
  assert.equal(followOperatorModel(undefined, { modelsBySlug, enabledProviders }), prism);

  rememberOperatorModel(native);
  assert.equal(readOperatorModel()?.slug, prism.slug);
  assert.equal(isNativeOpenAIRoute(native), true);
  assert.equal(isNativeOpenAIRoute(prism), false);

  rememberOperatorModel(grok);
  assert.equal(followOperatorModel(native, { modelsBySlug, enabledProviders }), grok);
  assert.equal(followOperatorModel(prism, { modelsBySlug, enabledProviders }), prism);
});

test("a hidden provider, an unknown slug, and a damaged hint leave the route alone", async () => {
  const { clearOperatorModel, operatorModelSnapshot } = await import("../src/operator-model.mjs");
  const prism = { slug: "kiro-prism/gpt-5.6-sol", provider: "kiro-prism" };
  const native = { slug: "gpt-6-astra", provider: "openai" };
  const modelsBySlug = new Map([[prism.slug, prism], [native.slug, native]]);

  rememberOperatorModel(prism);
  assert.equal(operatorModelSnapshot().slug, prism.slug);
  // Following a model whose provider is hidden would trade a quota failure for
  // a routing error, which is the worse outcome on a turn nobody is watching.
  assert.equal(
    followOperatorModel(native, { modelsBySlug, enabledProviders: ["openai"] }),
    native,
  );
  // A remembered slug this build no longer routes is not a reason to fail.
  assert.equal(
    followOperatorModel(native, { modelsBySlug: new Map(), enabledProviders: ["kiro-prism"] }),
    native,
  );

  // With no hint at all, an explicit fallback still applies, and without either
  // the caller keeps exactly the route it resolved.
  clearOperatorModel();
  assert.equal(readOperatorModel(), undefined);
  assert.equal(operatorModelSnapshot().remembered, false);
  assert.equal(
    followOperatorModel(native, {
      modelsBySlug,
      enabledProviders: ["kiro-prism"],
      fallbackSlug: prism.slug,
    }),
    prism,
  );
  assert.equal(followOperatorModel(native, { modelsBySlug }), native);
});
