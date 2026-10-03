import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-status-client-"));
const codexHome = mkdtempSync(path.join(os.tmpdir(), "router-status-client-home-"));

let requests = 0;
let mode = "ok";
const server = http.createServer((req, res) => {
  requests += 1;
  if (mode === "unauthorized") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "authentication_error" } }));
    return;
  }
  if (mode === "malformed") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not json{{{");
    return;
  }
  if (mode === "oversized") {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(9 * 1024 * 1024),
    });
    res.end(JSON.stringify({ ok: true, sections: {} }));
    return;
  }
  if (mode === "slow") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sections: {} }));
    }, 300).unref?.();
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const names = (url.searchParams.get("sections") || "").split(",");
  const sections = {};
  for (const name of names) {
    if (name === "overview") sections[name] = { data: { targets: {} }, stale: mode === "stale" };
    else if (name === "account") sections[name] = { data: { ok: true }, stale: mode === "stale" };
    else sections[name] = { error: "snapshot_unavailable" };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, sections }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;
process.env.MODEL_ROUTER_PORT = String(port);

const { CALLER_SECRET_PATH } = await import("../src/paths.mjs");
const { fetchRouterStatusSections, fetchSectionData, routerStatusHttpEnabled } = await import(
  "../src/router-status-client.mjs"
);

const SECRET = "test-caller-secret-with-sufficient-length-01";
writeFileSync(CALLER_SECRET_PATH, `${SECRET}\n`);

test.after(() => {
  server.close();
});

test("reads the enabled switch the same way the probes do", () => {
  assert.equal(routerStatusHttpEnabled({}), true);
  assert.equal(routerStatusHttpEnabled({ MODEL_ROUTER_STATUS_HTTP: "0" }), false);
  assert.equal(routerStatusHttpEnabled({ MODEL_ROUTER_STATUS_HTTP: "off" }), false);
});

test("fetches sections over HTTP", async () => {
  mode = "ok";
  const served = await fetchRouterStatusSections(["overview", "account"]);
  assert.equal(served.ok, true);
  assert.deepEqual(served.sections.overview, { data: { targets: {} }, stale: false });
  assert.deepEqual(served.sections.account, { data: { ok: true }, stale: false });
});

test("serves data and lets stale cheap sections through", async () => {
  mode = "ok";
  assert.deepEqual(await fetchSectionData("overview"), { targets: {} });
  mode = "stale";
  assert.deepEqual(await fetchSectionData("account"), { ok: true });
});

test("a stale overview falls back so control rewarm the file", async () => {
  mode = "stale";
  assert.equal(await fetchSectionData("overview"), undefined);
});

test("section errors fall back to local computation", async () => {
  mode = "ok";
  assert.equal(await fetchSectionData("providers"), undefined);
});

test("transport failures fail open", async () => {
  mode = "unauthorized";
  assert.equal((await fetchRouterStatusSections(["account"])).ok, false);
  mode = "malformed";
  assert.equal((await fetchRouterStatusSections(["account"])).ok, false);
  mode = "oversized";
  assert.equal((await fetchRouterStatusSections(["account"])).ok, false);
  mode = "slow";
  assert.equal((await fetchRouterStatusSections(["account"], { timeoutMs: 25 })).ok, false);
});

test("a disabled switch skips the network", async () => {
  process.env.MODEL_ROUTER_STATUS_HTTP = "0";
  try {
    requests = 0;
    mode = "ok";
    assert.equal((await fetchRouterStatusSections(["account"])).ok, false);
    assert.equal(requests, 0);
  } finally {
    delete process.env.MODEL_ROUTER_STATUS_HTTP;
  }
});

test("a missing caller key skips the network", async () => {
  renameSync(CALLER_SECRET_PATH, `${CALLER_SECRET_PATH}.bak`);
  try {
    requests = 0;
    assert.equal((await fetchRouterStatusSections(["account"])).ok, false);
    assert.equal(requests, 0);
  } finally {
    renameSync(`${CALLER_SECRET_PATH}.bak`, CALLER_SECRET_PATH);
  }
});

test("--local skips the network", async () => {
  process.argv.push("--local");
  try {
    requests = 0;
    assert.equal(await fetchSectionData("account"), undefined);
    assert.equal(requests, 0);
  } finally {
    process.argv.pop();
  }
});
