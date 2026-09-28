# Python gateway dependency lock

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## The Python gateway is installed from a hash-verified lock

The router's gateway is LiteLLM, so every install executes a large Python
dependency tree. That tree is pinned and hashed rather than re-resolved.

1. `requirements/python.txt` is the lock: the full transitive closure of
   `PYTHON_REQUIREMENTS` in `src/install-plan.mjs`, every distribution pinned
   and carrying its SHA256. Both installers install *that file* with
   `--require-hashes`, in both their `uv` and their `pip` branch. Pinning only
   the two top-level packages left everything underneath them floating, which
   is how one machine's gateway came to differ from another's.
2. Never edit either `requirements/` file by hand, and never add a package to
   an installer command line. Change the pin in `src/install-plan.mjs` and run
   `bin/lock-python`, which rewrites `requirements/python.in` from
   `PYTHON_REQUIREMENTS` and recompiles the lock. Commit both files together.
3. The lock must stay **universal**. `bin/lock-python` passes `--universal
   --generate-hashes --python-version 3.10`, which is what makes one file
   serve macOS, Linux, and Windows on CPython 3.10+ through environment
   markers. A lock regenerated without `--universal` looks fine and installs
   only on the machine that produced it; `test/python-lock.test.mjs` fails on
   that, on an unhashed entry, and on any disagreement with
   `PYTHON_REQUIREMENTS`. Do not weaken those tests to land a lock.
4. Check which wheels a litellm pin actually publishes before moving it.
   `1.95.0` shipped `manylinux` and `win_amd64` only, so **macOS built it from
   the sdist** with `maturin` and a Rust toolchain — slow, and broken outright
   without `cargo`. `1.96.0` publishes macOS wheels (arm64 and x86_64) as well,
   so no supported platform builds from source today. If a macOS install is slow
   or failing, check for `cargo` and check the pin's wheel list; do not assume
   either state.
5. Hash verification covers the distributions, not the isolated build
   environment pip and uv create for an sdist. `maturin` is fetched unhashed
   during that build. Closing that gap needs a separate build-requirements
   lock; do not claim the current lock covers it. No supported platform builds
   from source at the current pin, which narrows the exposure but does not
   remove it — a pin without a wheel for someone's platform brings it back.
6. A pin can be a **security floor**, and moving it backwards reintroduces the
   advisory it was raised for. `litellm==1.95.0` required
   `cryptography>=48.0.1,<49.0`, so no patched cryptography could be resolved
   while it was held (GHSA-g6cj-pr64-35w5, fixed in 50.0.0). Dependabot reports
   the transitive package; the fix is almost always the direct pin above it.
7. Resolving is not booting. litellm's own metadata allows fastapi versions its
   code cannot import (`get_flat_dependant`, removed in 0.140), so `uv pip
   compile` will happily produce a lock whose gateway dies on startup. Any
   change to either Python pin has to be proven by starting the proxy and
   getting a live `/health/liveliness`, not by a successful resolve.
8. The lock is proven by installing it, not by reasoning about it.
   `.github/workflows/python-lock.yml` installs it for real on Linux and
   Windows through both resolvers, then asserts the pinned versions, the
   `litellm[proxy]` extra, and a live `/health/liveliness`. It gets the command
   from `install-plan.mjs python-install-command`, which extracts the line from
   `bin/install` and `install.ps1` themselves — never write a `pip install` line
   into CI, because a job that spells its own command can pass while the
   shipped installer fails. Its negative control must also keep failing: if an
   unhashed requirement ever installs, every other check in that job is
   meaningless. Do not add a resolver cache there; a cache hit can serve an
   already-unpacked wheel and skip the hash check the job exists to perform.
