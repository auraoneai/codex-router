// How long a routed stream may stay silent *after* its prologue has been
// released, per provider family.
//
// Two different limits share one guard. Before release, the bound is a latency
// budget: nothing has reached the client, the attempt is still fully
// replaceable, and a short limit is what turns an invisible empty completion
// into a retry. After release the same timer becomes a stall bound, and the
// tradeoff inverts -- the turn is already visible and can no longer be replayed,
// so ending it early destroys a live answer rather than saving a dead one.
//
// A reasoning model routed through Kiro Prism or Free Prism can legitimately
// produce nothing for longer than the 30s prologue budget while it thinks
// between events, so reusing that budget as the stall bound truncates healthy
// generations. Grok already had this problem and got its own much larger
// allowance; these families need the same treatment at a smaller scale, because
// they stream ordinary reasoning rather than Grok's minutes-long silences.
//
// Deliberately a policy lookup and not a new timer: the guard's existing
// `maxStreamStallMs` does the work. This module only decides the number, so
// there is exactly one stall mechanism in the router.
export const DEFAULT_ROUTED_STREAM_STALL_MS = 120_000;

// Node clamps a delay above this to 1ms, which would end a turn at its first
// event -- the opposite of what a stall allowance is for.
const MAX_TIMER_MS = 2_147_483_647;

// Canonical provider ids whose post-prologue silence is ordinary reasoning.
// Keyed on the canonical id so protocol variants of one family inherit it.
const EXTENDED_STALL_PROVIDERS = new Set(["kiro-prism", "free-prism"]);

export function routedStreamStallMs(environment = process.env) {
  const configured = Number(
    environment.CODEX_ROUTER_ROUTED_STREAM_STALL_MS ?? DEFAULT_ROUTED_STREAM_STALL_MS,
  );
  return Number.isFinite(configured) && configured > 0 && configured <= MAX_TIMER_MS
    ? configured
    : DEFAULT_ROUTED_STREAM_STALL_MS;
}

// The stall bound for one route, or undefined when this provider has no reason
// to outlast the prologue budget. Undefined rather than a number so the caller
// keeps its existing default and this module never has to know it.
//
// `preludeMs` is the floor: a stall allowance shorter than the pre-release
// budget would make releasing the prologue *reduce* the time a stream has, which
// no caller could intend.
export function providerStreamStallMs(
  canonicalProvider,
  { preludeMs = 0, environment = process.env } = {},
) {
  if (!EXTENDED_STALL_PROVIDERS.has(canonicalProvider)) return undefined;
  return Math.max(routedStreamStallMs(environment), preludeMs);
}
