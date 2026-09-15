import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, Pool, setGlobalDispatcher } from "undici";

import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";

export const DEFAULT_UPSTREAM_CONNECTIONS = 128;

function upstreamConnections(environment) {
  const raw = environment.MODEL_ROUTER_UPSTREAM_CONNECTIONS;
  if (raw === undefined || raw === "") return DEFAULT_UPSTREAM_CONNECTIONS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new Error("MODEL_ROUTER_UPSTREAM_CONNECTIONS must be an integer from 1 to 1024.");
  }
  return value;
}

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until launchd restarted the whole
// service. Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
//
// Concurrent Codex turns each hold one HTTP/1.1 streaming socket for the
// whole generation. Keep the per-origin ceiling deliberately generous so
// ordinary concurrent turns never queue, but finite so a broken or abusive
// caller cannot grow one provider's socket set without bound. The override is
// primarily for controlled saturation tests and constrained installations.
//
// Leave `keepAliveTimeout` at Undici's 4s default. This pool is shared by
// every outbound provider request, and an upstream that idle-closes without
// advertising `Keep-Alive: timeout=` hands back a half-closed socket once we
// hold connections longer than it does -- surfacing as UND_ERR_SOCKET on a
// POST Undici will not retry. Only the loopback probe pool below, whose one
// origin is our own server, raises it.
export function fetchDispatcherOptions(environment = process.env) {
  return {
    allowH2: false,
    pipelining: 1,
    connections: upstreamConnections(environment),
  };
}

export function proxyFetchDispatcherOptions(environment = process.env, PoolClass = Pool) {
  const options = fetchDispatcherOptions(environment);
  return {
    ...options,
    // EnvHttpProxyAgent's plain-HTTP forwarding wrapper otherwise creates its
    // inner proxy Pool with only `{ connect }`, dropping `connections`. Keep
    // the same per-target-origin ceiling on that supported proxy path.
    factory(origin, poolOptions) {
      return new PoolClass(origin, { ...poolOptions, connections: options.connections });
    },
  };
}

export function installStableFetchTransport({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  environment = process.env,
  execArgv = process.execArgv,
} = {}) {
  const proxyConfigured = environmentHttpProxyConfigured(environment, execArgv);
  const DispatcherClass = proxyConfigured
    ? EnvHttpProxyAgentClass
    : AgentClass;
  const options = proxyConfigured
    ? proxyFetchDispatcherOptions(environment)
    : fetchDispatcherOptions(environment);
  const dispatcher = new DispatcherClass(options);
  setDispatcher(dispatcher);
  return dispatcher;
}

// Health probes must not share the streaming pool. A GET /health/liveliness
// that queues behind five SSE POSTs to the same origin is what made the
// unauthenticated `/health` leaf hang long enough for doctor and the tray
// to call the router dead.
//
// Use undici's own `fetch` with this Agent. Passing an npm-undici dispatcher
// into Node's builtin `fetch` throws `invalid onRequestStart method`, every
// probe looks unreachable, and `/health` stays 503 until startup gives up.
export function createLoopbackProbeDispatcher({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  environment = process.env,
  execArgv = process.execArgv,
  timeoutMs = 3_000,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  return new DispatcherClass({
    allowH2: false,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

// One pool for the whole process. Building the Agent in a default parameter
// made a fresh connection pool on every probe instead, so each `/health` poll
// left another dispatcher -- and its sockets -- behind with nothing to close
// them. Created on first use so importing this module opens nothing.
let sharedProbeDispatcher;

export function loopbackProbeDispatcher() {
  sharedProbeDispatcher ??= createLoopbackProbeDispatcher();
  return sharedProbeDispatcher;
}

export function loopbackProbeFetch(url, init = {}, dispatcher = loopbackProbeDispatcher()) {
  return undiciFetch(url, { ...init, dispatcher });
}
