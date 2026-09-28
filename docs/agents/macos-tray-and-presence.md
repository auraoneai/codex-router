# macOS tray, Codex detection, and presence

Mandatory reading for the tasks listed against this file in the root
`AGENTS.md` index. The root index's cross-cutting rules still apply.

## Detecting whether Codex is open

Follow mode ("Show tray: With Codex") decides when the tray is visible and, in
that mode, when the router runs at all. Codex ships both as a desktop app and as
an npm CLI, and only the app has a bundle identifier, so
`NSRunningApplication` alone is not an answer: a bundle-only check reported
"Codex is not running" for every terminal session, hid the menu bar item, and
stopped the router 30 seconds into the user's work.

Detection must cover both — bundle identifiers for the apps, and a process-table
scan for the CLI. Keep the scan in `sysctl`; it runs every five seconds for the
life of the session, and spawning `pgrep` on that cadence is a cost the check
does not justify. `apps/macos/ModelRouterTray/Tests/HostProcessDetectionTests.swift`
guards it.

## The macOS app icon is committed, not built during a tray build

`apps/macos/ModelRouterTray/Resources/AppIcon.svg` is the source and
`AppIcon.icns` beside it is the committed output of `scripts/build-app-icon.sh`.
Regenerate and commit both together after editing the SVG. Do not make
`scripts/build-macos-tray-app.sh` rasterize the icon: it would put `sips` and
`iconutil` on the critical path of every tray build for one asset that changes
almost never. Keep the SVG free of `--` inside comments and of SVG filter
primitives — CoreSVG, which is what `sips` uses, rejects the first and silently
drops the second.

## A client the tray cannot watch keeps the router on

The tray's presence setting can tie the router to the Codex and ChatGPT desktop
apps, stopping it 30 seconds after both close. That is only safe for a client
the tray can actually see. `NSRunningApplication` enumerates app bundles, so it
sees the desktop apps and nothing else — a `codex` TUI in a terminal and a `dsh`
harness turn both register nothing at all. Neither can be started on demand
either: a turn that finds 127.0.0.1:4202 closed fails immediately, while the
five-process stack behind that port takes up to 300 seconds to warm, so lazy
start does not exist at request latency. The port has to already be open.

- `effectivePresenceMode()` in `src/presence-state.mjs` is what the tray and
  `doctor` act on. It reports `always` whenever `dsh-models.json` exists or
  `codex` resolves on PATH, whatever the stored mode says. Read it, never
  `readPresenceMode()`, anywhere a service gets stopped.
- Detection errs toward finding a client. A false positive costs a dormant
  toggle; a false negative costs somebody their next request.
- The stored mode is overridden, never rewritten. Removing the harness route or
  the CLI hands the user's own choice back on the next read.
- The router owns the rule and the tray consumes it: `control --json` carries a
  `presence` block, and the tray reads `presence.effectiveMode` rather than
  re-deriving anything from target flags, which is where the two would drift.
  The field is optional in the Swift decoder, so a tray keeps working against a
  router that predates it.
- `test/presence-state.test.mjs` covers both signals, the override, the round
  trip, and the fact that always-on is left alone. A change to the gate needs a
  test there.
