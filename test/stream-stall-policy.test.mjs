import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROUTED_STREAM_STALL_MS,
  providerStreamStallMs,
  routedStreamStallMs,
} from "../src/stream-stall-policy.mjs";

// Prism families reason between events, so post-prologue silence is ordinary
// generation rather than evidence of a broken stream. Before this, releasing the
// prologue left them with only the 30s prelude budget as a stall bound.
test("Prism families get an allowance that outlasts the prelude budget", () => {
  for (const provider of ["kiro-prism", "free-prism"]) {
    const stall = providerStreamStallMs(provider, { preludeMs: 30_000, environment: {} });
    assert.equal(stall, DEFAULT_ROUTED_STREAM_STALL_MS);
    assert.ok(stall > 30_000, `${provider} must outlast the prelude budget`);
  }
});

// Undefined, not a number: the caller keeps its own default, so this module
// never has to know what that default is.
test("an unlisted provider gets no opinion", () => {
  assert.equal(providerStreamStallMs("openrouter", { preludeMs: 30_000 }), undefined);
  assert.equal(providerStreamStallMs("grok-oauth", { preludeMs: 30_000 }), undefined);
  assert.equal(providerStreamStallMs(undefined, { preludeMs: 30_000 }), undefined);
});

// A stall allowance below the pre-release budget would mean releasing the
// prologue *reduced* the time a stream has, which no caller could intend.
test("the prelude budget is a floor", () => {
  const stall = providerStreamStallMs("kiro-prism", {
    preludeMs: 600_000,
    environment: { CODEX_ROUTER_ROUTED_STREAM_STALL_MS: "1000" },
  });
  assert.equal(stall, 600_000);
});

test("the override is honored when it is a usable positive number", () => {
  assert.equal(
    routedStreamStallMs({ CODEX_ROUTER_ROUTED_STREAM_STALL_MS: "45000" }),
    45_000,
  );
});

// A timer delay above Node's signed-32-bit ceiling is clamped to 1ms, which
// would end a turn at its first event: the opposite of an allowance.
test("unusable overrides fall back to the default", () => {
  for (const value of ["0", "-1", "abc", "", "99999999999999"]) {
    assert.equal(
      routedStreamStallMs({ CODEX_ROUTER_ROUTED_STREAM_STALL_MS: value }),
      DEFAULT_ROUTED_STREAM_STALL_MS,
      `override ${JSON.stringify(value)} must not be trusted`,
    );
  }
});

test("an absent override uses the default", () => {
  assert.equal(routedStreamStallMs({}), DEFAULT_ROUTED_STREAM_STALL_MS);
});
