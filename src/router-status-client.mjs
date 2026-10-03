// Lets `control` status reads ride the router's snapshot endpoint instead of
// recomputing in a fresh process. Every function here fails open to local
// computation: a stopped router, a rotated caller key, a timeout, or a
// malformed body all read exactly like a cache miss, never like an error.
// Set MODEL_ROUTER_STATUS_HTTP=0 (or pass --local) to skip the router and
// compute locally, which is also the behavior when this module cannot load
// the caller key.
import { existsSync, readFileSync } from "node:fs";

import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2_500;
const OVERVIEW_SECTION = "overview";

export function routerStatusHttpEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.MODEL_ROUTER_STATUS_HTTP ?? ""));
}

function readCallerSecret() {
  try {
    if (!existsSync(CALLER_SECRET_PATH)) return undefined;
    return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  } catch {
    return undefined;
  }
}

export async function fetchRouterStatusSections(
  sections,
  { refresh = false, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, secret, port } = {},
) {
  try {
    if (!routerStatusHttpEnabled()) return { ok: false };
    const resolvedSecret = secret ?? readCallerSecret();
    if (!resolvedSecret) return { ok: false };
    const url =
      `${callerBaseUrl(port ?? PORTS.router, resolvedSecret)}/status/snapshot` +
      `?sections=${encodeURIComponent(sections.join(","))}&refresh=${refresh ? "1" : "0"}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false };
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_STATUS_BYTES) {
      return { ok: false };
    }
    const text = await response.text();
    if (text.length > MAX_STATUS_BYTES) return { ok: false };
    const parsed = JSON.parse(text);
    if (!parsed || parsed.ok !== true || !parsed.sections || typeof parsed.sections !== "object") {
      return { ok: false };
    }
    return { ok: true, sections: parsed.sections };
  } catch {
    return { ok: false };
  }
}

// Returns served section data, or undefined when the caller must compute
// locally. A refresh the router could not serve fresh, a stale overview (only
// `control` rewarm that file), and any section error all fall through.
export async function fetchSectionData(section, { refresh = false } = {}) {
  if (process.argv.includes("--local")) return undefined;
  const served = await fetchRouterStatusSections([section], { refresh });
  if (!served.ok) return undefined;
  const entry = served.sections?.[section];
  if (!entry || entry.error !== undefined || entry.data === undefined) return undefined;
  if (entry.stale && (refresh || section === OVERVIEW_SECTION)) return undefined;
  return entry.data;
}
