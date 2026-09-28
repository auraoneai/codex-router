# The `codex` shim

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## The `codex` shim is opt-in and must never break `codex`

`src/codex-shim.mjs` can put a wrapper named `codex` on the user's PATH so the
router is verified up before Codex starts. Installing a file that shadows a
command the user already has is a change only they may authorize.

1. Never install it from `install.sh`, `install.ps1`, `doctor --fix`, or any
   automatic repair. It ships behind `model-router codex shim install` only.
2. Never write into a PATH directory outside the user's home directory. A shim
   in `/usr/local/bin` changes `codex` for every account on the machine.
3. Never overwrite or delete a `codex` that does not carry `SHIM_MARKER`.
   Another wrapper there is somebody's deliberate setup, not debris.
4. Never edit shell startup files to put the shim on PATH. When no directory
   ahead of Codex is writable, print the `export PATH=...` line and stop.
5. Every failure path in the generated shim must still `exec` the real Codex.
   A stopped router, a deleted checkout, and a gateway that never becomes
   healthy are all recoverable; a `codex` that refuses to start is not. The
   wait is bounded by `MODEL_ROUTER_SHIM_WAIT`, and `MODEL_ROUTER_SHIM=0`
   bypasses the check.

`test/codex-shim.test.mjs` covers each of these. Do not weaken those tests to
land a change.
