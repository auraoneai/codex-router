import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import {
  createLoopbackProbeDispatcher,
  DEFAULT_UPSTREAM_CONNECTIONS,
  fetchDispatcherOptions,
  installStableFetchTransport,
  loopbackProbeDispatcher,
  loopbackProbeFetch,
  proxyFetchDispatcherOptions,
} from "../src/fetch-transport.mjs";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function installFakeTransport(environment, execArgv = []) {
  const created = [];
  const installed = [];

  class FakeAgent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
      created.push(this);
    }
  }

  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.kind = "environment-proxy";
      this.options = options;
      created.push(this);
    }
  }

  const dispatcher = installStableFetchTransport({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment,
    execArgv,
    setDispatcher(value) {
      installed.push(value);
    },
  });

  return { created, dispatcher, installed };
}

test("the router disables HTTP/2 on its process-wide fetch dispatcher", () => {
  const { created, dispatcher, installed } = installFakeTransport({});

  assert.equal(created.length, 1);
  assert.equal(dispatcher.kind, "direct");
  assert.deepEqual(created[0].options, {
    allowH2: false,
    pipelining: 1,
    connections: DEFAULT_UPSTREAM_CONNECTIONS,
  });
  assert.equal(dispatcher, created[0]);
  assert.deepEqual(installed, [dispatcher]);
});

// Every outbound provider request shares this pool. Holding idle sockets
// longer than an upstream does hands the next POST a half-closed connection
// that surfaces as UND_ERR_SOCKET, and Undici will not retry it -- so the
// process-wide pool keeps Undici's own 4s default and only the loopback
// probe pool, which talks to our own server, raises it.
test("the process-wide pool does not hold idle sockets past the undici default", () => {
  const { created } = installFakeTransport({});

  assert.equal("keepAliveTimeout" in created[0].options, false);
  assert.equal(created[0].options.connections, DEFAULT_UPSTREAM_CONNECTIONS);

  const probe = createLoopbackProbeDispatcher({
    AgentClass: class {
      constructor(options) {
        this.options = options;
      }
    },
    environment: {},
  });
  assert.equal(probe.options.keepAliveTimeout, 10_000);
});

test("the router uses the environment proxy dispatcher only with explicit opt-in", () => {
  for (const environment of [
    { NODE_USE_ENV_PROXY: "1", http_proxy: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", https_proxy: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost" },
  ]) {
    const { created, dispatcher } = installFakeTransport(environment);

    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "environment-proxy");
    assert.equal(dispatcher, created[0]);
    assert.equal(dispatcher.options.allowH2, false);
    assert.equal(dispatcher.options.pipelining, 1);
    assert.equal(dispatcher.options.connections, DEFAULT_UPSTREAM_CONNECTIONS);
    assert.equal(typeof dispatcher.options.factory, "function");
  }
});

test("the process-wide pool accepts only a bounded per-origin connection override", () => {
  const { created } = installFakeTransport({ MODEL_ROUTER_UPSTREAM_CONNECTIONS: "7" });
  assert.equal(created[0].options.connections, 7);

  for (const value of ["0", "1.5", "1025", "many"]) {
    assert.throws(
      () => installFakeTransport({ MODEL_ROUTER_UPSTREAM_CONNECTIONS: value }),
      /must be an integer from 1 to 1024/u,
    );
  }
});

test("the proxy pool factory preserves the per-origin connection ceiling", () => {
  const created = [];
  class FakePool {
    constructor(origin, options) {
      created.push({ origin, options });
    }
  }
  const options = proxyFetchDispatcherOptions(
    { MODEL_ROUTER_UPSTREAM_CONNECTIONS: "3" },
    FakePool,
  );
  options.factory("http://proxy.example", { connect: "connector" });
  assert.deepEqual(created, [{
    origin: "http://proxy.example",
    options: { connect: "connector", connections: 3 },
  }]);
});

test("proxy variables alone do not opt the router into proxying", () => {
  const { created, dispatcher } = installFakeTransport({
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://secure-proxy.example:8443",
  });

  assert.equal(created.length, 1);
  assert.equal(dispatcher.kind, "direct");
  assert.deepEqual(dispatcher.options, fetchDispatcherOptions({
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://secure-proxy.example:8443",
  }));
});

test("the router accepts the NODE_OPTIONS and command-line opt-in forms", () => {
  for (const [environment, execArgv] of [
    [{ NODE_OPTIONS: "--use-env-proxy", HTTP_PROXY: "http://proxy.example:8080" }, []],
    [{ HTTP_PROXY: "http://proxy.example:8080" }, ["--use-env-proxy"]],
  ]) {
    const { created, dispatcher } = installFakeTransport(environment, execArgv);
    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "environment-proxy");
    assert.equal(dispatcher.options.connections, DEFAULT_UPSTREAM_CONNECTIONS);
    assert.equal(typeof dispatcher.options.factory, "function");
  }
});

test("NO_PROXY or ALL_PROXY alone keeps the lower-overhead direct agent", () => {
  for (const environment of [
    { NO_PROXY: "localhost,127.0.0.1" },
    { ALL_PROXY: "socks5://proxy.example:1080" },
    // EnvHttpProxyAgent ignores uppercase HTTP_PROXY when lowercase is present,
    // even when the lowercase value deliberately disables it.
    { http_proxy: "", HTTP_PROXY: "http://proxy.example:8080" },
  ]) {
    const { created, dispatcher } = installFakeTransport(environment);

    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "direct");
    assert.equal(dispatcher, created[0]);
    assert.deepEqual(dispatcher.options, fetchDispatcherOptions(environment));
  }
});

test("the installed transport proxies requests and honors NO_PROXY", async () => {
  const proxyEnvironmentNames = [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
  ];
  const originalEnvironment = Object.fromEntries(
    proxyEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  const originalDispatcher = getGlobalDispatcher();
  let proxiedRequests = 0;
  let directRequests = 0;
  const target = http.createServer((_request, response) => {
    directRequests += 1;
    response.end("direct");
  });
  const proxy = http.createServer((_request, response) => {
    proxiedRequests += 1;
    response.end("proxied");
  });
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  const close = (server) => new Promise((resolve) => server.close(resolve));

  let dispatcher;
  try {
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    for (const name of proxyEnvironmentNames) delete process.env[name];
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;

    dispatcher = installStableFetchTransport();
    let response = await fetch(`http://127.0.0.1:${targetPort}/through-proxy`);
    assert.equal(await response.text(), "proxied");
    assert.equal(proxiedRequests, 1);
    assert.equal(directRequests, 0);

    process.env.NO_PROXY = "127.0.0.1";
    response = await fetch(`http://127.0.0.1:${targetPort}/bypass-proxy`);
    assert.equal(await response.text(), "direct");
    assert.equal(proxiedRequests, 1);
    assert.equal(directRequests, 1);
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await dispatcher?.close();
    await Promise.all([close(target), close(proxy)]);
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the proxy transport bounds each target origin and releases a canceled stream slot", async () => {
  const names = [
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "NODE_USE_ENV_PROXY", "MODEL_ROUTER_UPSTREAM_CONNECTIONS",
  ];
  const originalEnvironment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalDispatcher = getGlobalDispatcher();
  const requests = [];
  const held = new Map();
  const proxySockets = new Set();
  const proxy = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith("/hold")) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
      held.set(request.url, response);
      return;
    }
    response.end("ok");
  });
  proxy.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.once("close", () => proxySockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });

  let dispatcher;
  try {
    const proxyPort = proxy.address().port;
    for (const name of names) delete process.env[name];
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.MODEL_ROUTER_UPSTREAM_CONNECTIONS = "1";
    dispatcher = installStableFetchTransport();

    const abort = new AbortController();
    const heldResponse = await fetch("http://origin-a.test/hold", { signal: abort.signal });
    const reader = heldResponse.body.getReader();
    const queued = fetch("http://origin-a.test/queued");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      requests.includes("http://origin-a.test/queued"),
      false,
      `queued=${JSON.stringify(requests)} sockets=${proxySockets.size}`,
    );

    const independent = await fetch("http://origin-b.test/independent");
    assert.equal(await independent.text(), "ok");
    assert.equal(requests.includes("http://origin-b.test/independent"), true);

    abort.abort();
    await assert.rejects(() => reader.read(), /abort|operation|terminated/iu);
    const released = await queued;
    assert.equal(await released.text(), "ok");
    assert.equal(requests.includes("http://origin-a.test/queued"), true);
  } finally {
    for (const response of held.values()) response.destroy();
    for (const socket of proxySockets) socket.destroy();
    setGlobalDispatcher(originalDispatcher);
    await dispatcher?.close();
    await new Promise((resolve) => proxy.close(resolve));
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// The service is four long-lived processes, and setGlobalDispatcher only
// reaches the one that called it. A forwarder that skips the install keeps
// Node's HTTP/2-capable default and stays exposed to the poisoned-session
// failure this module exists to remove — so every server entry point must
// install the stable transport, including ones added after this test.
test("every long-lived server process installs the stable transport", () => {
  const serverEntryPoints = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) =>
      readFileSync(path.join(SRC_DIR, name), "utf8").includes("createServer("),
    );

  assert.ok(
    serverEntryPoints.length >= 4,
    `expected at least the four known server entry points, found: ${serverEntryPoints.join(", ")}`,
  );

  for (const name of serverEntryPoints) {
    const source = readFileSync(path.join(SRC_DIR, name), "utf8");
    assert.ok(
      source.includes("installStableFetchTransport()"),
      `${name} creates a server but never installs the stable fetch transport`,
    );
  }
});

test("loopback health probes use the same proxy opt-in as routed traffic", () => {
  const created = [];
  class FakeAgent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
      created.push(this);
    }
  }
  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.kind = "environment-proxy";
      this.options = options;
      created.push(this);
    }
  }

  const proxied = createLoopbackProbeDispatcher({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment: { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://proxy.example:8080" },
  });
  assert.equal(proxied.kind, "environment-proxy");

  created.length = 0;
  const direct = createLoopbackProbeDispatcher({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment: { HTTP_PROXY: "http://proxy.example:8080" },
  });
  assert.equal(direct.kind, "direct");
});

test("loopback probes use undici fetch so a separate Agent is accepted", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "gateway" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const response = await loopbackProbeFetch(`http://127.0.0.1:${port}/health/liveliness`, {
      headers: { Authorization: "Bearer test" },
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "gateway" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A default parameter that called the factory built a new Agent -- a whole
// connection pool -- on every probe, and the router polls /health continuously.
test("repeated loopback probes share one dispatcher", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const seen = [];
  const original = loopbackProbeDispatcher();
  try {
    const port = server.address().port;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await loopbackProbeFetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.json();
      seen.push(loopbackProbeDispatcher());
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(seen.length, 3);
  for (const dispatcher of seen) assert.equal(dispatcher, original);
  // The accessor returns the one singleton; the factory still makes new pools,
  // which is what the default parameter used to do on every single probe.
  const separate = createLoopbackProbeDispatcher();
  try {
    assert.notEqual(original, separate);
  } finally {
    await separate.close();
  }
});

// Importing the module must not open a pool; only a probe should.
test("the shared probe dispatcher is built on first use, not at import", () => {
  const source = readFileSync(path.join(SRC_DIR, "fetch-transport.mjs"), "utf8");
  assert.match(source, /let sharedProbeDispatcher;/);
  assert.match(source, /sharedProbeDispatcher \?\?= createLoopbackProbeDispatcher\(\)/);
  assert.doesNotMatch(
    source,
    /^(const|let) \w+ = createLoopbackProbeDispatcher\(\)/m,
    "a module-level call would open a connection pool for every importer",
  );
});
