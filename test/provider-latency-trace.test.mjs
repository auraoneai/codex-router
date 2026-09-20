import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("provider latency traces keep content-free correlated attempts", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-latency-"));
  const previous = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const telemetry = await import(`../src/provider-latency-trace.mjs?test=${Date.now()}`);
    const trace = telemetry.createProviderLatencyTrace({ requestedModel: "asked-model" });
    const finishParse = trace.startLocalhostParse();
    finishParse();
    trace.setResolvedModel("resolved-model");
    const finishRouteSelection = trace.startRouteSelection();
    finishRouteSelection();
    const callbacks = trace.fetchCallbacks({ provider: "openrouter", model: "resolved-model" });
    callbacks.onAttemptStart({ attempt: 1 });
    callbacks.onAttemptFinish({ attempt: 1, response: { status: 503 } });
    callbacks.onAttemptStart({ attempt: 2 });
    callbacks.onAttemptFinish({ attempt: 2, response: { status: 200 } });
    trace.markSemantic();
    trace.setReturnedModel("returned-model");
    trace.finish({ statusCode: 200 });

    const record = JSON.parse(readFileSync(telemetry.PROVIDER_LATENCY_TRACES_PATH, "utf8"));
    assert.match(
      record.logicalRequestId,
      /^router-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(record.requestedModel, "asked-model");
    assert.equal(record.resolvedModel, "resolved-model");
    assert.equal(record.returnedModel, "returned-model");
    assert.ok(Number.isInteger(record.localhostParseMs));
    assert.ok(Number.isInteger(record.routeSelectionMs));
    assert.equal(record.contextEstimationAuthority, "prism");
    assert.equal(record.routerAuthoritativeContextEstimate, false);
    assert.deepEqual(telemetry.CONTEXT_ESTIMATION_BOUNDARY, {
      authority: "prism",
      routerPerformsAuthoritativeEstimate: false,
    });
    assert.deepEqual(record.attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
    assert.deepEqual(record.attempts.map((attempt) => attempt.status), ["http_503", "http_200"]);
    assert.ok(Number.isInteger(record.attempts[1].firstSemanticEventMs));
    assert.equal("prompt" in record, false);
    assert.equal("headers" in record, false);
    assert.deepEqual(trace.correlationHeaders(), {
      "X-Codex-Router-Request-Id": record.logicalRequestId,
    });
    const inherited = telemetry.createProviderLatencyTrace({
      logicalRequestId: record.logicalRequestId,
    });
    assert.equal(inherited.logicalRequestId, record.logicalRequestId);
    const rejected = telemetry.createProviderLatencyTrace({
      logicalRequestId: "attacker-controlled",
    });
    assert.notEqual(rejected.logicalRequestId, "attacker-controlled");
    if (process.platform !== "win32") {
      assert.equal(statSync(telemetry.PROVIDER_LATENCY_TRACES_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Prism owns the authoritative preflight context estimate. If the router ever
// performed its own while selecting a route, the two would disagree about what
// fits and the cheaper of the two would silently win. The route-selection phase
// the trace measures is exactly that window, so it doubles as the boundary this
// asserts against.
test("Router leaves authoritative context estimation to Prism", async () => {
  const routerPath = fileURLToPath(new URL("../src/router.mjs", import.meta.url));
  const source = readFileSync(routerPath, "utf8");
  const selectionStart = source.indexOf("const finishRouteSelection = latencyTrace.startRouteSelection();");
  assert.ok(selectionStart > 0, "route-selection start is missing");
  // Scoped to start at the opening marker: unscoped, this could match a
  // `finishRouteSelection();` occurring earlier in the file and measure a
  // window that runs backwards.
  const selectionBoundary = source.indexOf("finishRouteSelection();", selectionStart + 1);
  assert.ok(selectionBoundary > selectionStart, "route-selection boundary is missing");
  assert.doesNotMatch(
    source.slice(selectionStart, selectionBoundary),
    /estimateInputTokens\s*\(/,
    "Router performed a token estimate before selecting the Prism route",
  );
});

test("the router and forwarder route every trace call through a guard", async () => {
  // A diagnostic on the hot request path must not be able to fail a turn. Both
  // modules call the trace only through their local guard, so an assertion that
  // `createProviderLatencyTrace` has exactly one call site in each file is what
  // keeps a later edit from reaching past it to the raw object.
  for (const [file, guard] of [
    ["../src/router.mjs", "guardedLatencyTrace"],
    ["../src/api-forwarder.mjs", "guardedForwarderTrace"],
  ]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const direct = source.match(/createProviderLatencyTrace\(/g) || [];
    assert.equal(direct.length, 1, `${file} must construct a trace only inside ${guard}`);
    assert.match(source, new RegExp(`function ${guard}\\(`), `${file} is missing ${guard}`);
    assert.match(
      source.slice(source.indexOf(`function ${guard}(`)),
      /try \{\s*trace = createProviderLatencyTrace/,
      `${guard} must tolerate a trace it cannot even create`,
    );
  }
});
