#!/bin/sh
set -eu

fail() {
  printf 'codex-router: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "Usage: $0 SOURCE.app DESTINATION.app REPOSITORY_ROOT"
source_bundle=$1
destination_bundle=$2
repo_dir=$3
expected_build_sha=${MODEL_ROUTER_PREBUILT_TRAY_EXPECTED_SHA:-}
existing_bundle=${MODEL_ROUTER_EXISTING_TRAY_BUNDLE:-}

case $source_bundle in /*) ;; *) fail "the prebuilt app path must be absolute." ;; esac
case $destination_bundle in /*) ;; *) fail "the staging app path must be absolute." ;; esac
case $repo_dir in /*) ;; *) fail "the repository root must be absolute." ;; esac
node -e 'if (!/^[0-9a-f]{40}$/.test(process.argv[1])) process.exit(1)' "$expected_build_sha" \
  || fail "an exact 40-character CI source SHA is required for prebuilt installation."
[ -d "$source_bundle" ] && [ ! -L "$source_bundle" ] \
  || fail "the prebuilt app must be a real .app directory."
[ ! -e "$destination_bundle" ] && [ ! -L "$destination_bundle" ] \
  || fail "the staged destination already exists."

repo_dir=$(CDPATH='' cd -P -- "$repo_dir" && pwd -P)
source_info="$source_bundle/Contents/Info.plist"
source_executable="$source_bundle/Contents/MacOS/ModelRouterTray"
control_center="$source_bundle/Contents/Resources/Control Center.app"
control_info="$control_center/Contents/Info.plist"
control_executable="$control_center/Contents/MacOS/Codex Router"
router_root_file="$control_center/Contents/Resources/router-root"
widget="$source_bundle/Contents/PlugIns/RouterUsageWidget.appex"
widget_executable="$widget/Contents/MacOS/RouterUsageWidget"

for required in \
  "$source_info" "$source_executable" "$control_info" "$control_executable" \
  "$router_root_file" "$widget/Contents/Info.plist" "$widget_executable"; do
  [ -f "$required" ] || fail "the prebuilt app is missing a required bundle file."
done

read_plist() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

[ "$(read_plist "$source_info" CFBundleIdentifier)" = "io.github.codex-router.tray" ] \
  || fail "the prebuilt app has an unexpected bundle identifier."
[ "$(read_plist "$control_info" CFBundleIdentifier)" = "io.github.codex-router.control-center" ] \
  || fail "the embedded Control Center has an unexpected bundle identifier."
[ "$(read_plist "$source_info" ModelRouterControlVersion)" = "$(node -p 'require(process.argv[1]).version' "$repo_dir/apps/control-center/package.json")" ] \
  || fail "the prebuilt Control Center version does not match this checkout."
[ "$(read_plist "$source_info" ModelRouterBuildSHA)" = "$expected_build_sha" ] \
  || fail "the prebuilt app was not built from the expected CI source commit."
/usr/bin/codesign --verify --deep --strict "$source_bundle" >/dev/null 2>&1 \
  || fail "the prebuilt app signature is invalid."

case $(uname -m) in
  arm64) required_arch=arm64 ;;
  x86_64) required_arch=x86_64 ;;
  *) fail "this Mac architecture is not supported by the prebuilt installer." ;;
esac
/usr/bin/lipo "$source_executable" -verify_arch "$required_arch" >/dev/null 2>&1 \
  || fail "the prebuilt tray does not support this Mac's architecture."
/usr/bin/lipo "$control_executable" -verify_arch "$required_arch" >/dev/null 2>&1 \
  || fail "the prebuilt Control Center does not support this Mac's architecture."
/usr/bin/lipo "$widget_executable" -verify_arch "$required_arch" >/dev/null 2>&1 \
  || fail "the prebuilt widget does not support this Mac's architecture."
[ "$(read_plist "$control_info" ModelRouterBuildSHA)" = "$expected_build_sha" ] \
  || fail "the embedded Control Center was not built from the expected CI source commit."

if [ -n "$existing_bundle" ]; then
  case $existing_bundle in /*) ;; *) fail "the existing app path must be absolute." ;; esac
  [ -d "$existing_bundle" ] && [ ! -L "$existing_bundle" ] \
    || fail "the existing app must be a real .app directory."
  existing_info="$existing_bundle/Contents/Info.plist"
  [ "$(read_plist "$existing_info" CFBundleIdentifier)" = "io.github.codex-router.tray" ] \
    || fail "the existing app has an unexpected bundle identifier."
  [ "$(read_plist "$existing_info" ModelRouterSourceRoot)" = "$repo_dir" ] \
    || fail "the existing app is not bound to this repository's state-owner checkout."
  [ "$(read_plist "$existing_info" ModelRouterControlVersion)" = "$(node -p 'require(process.argv[1]).version' "$repo_dir/apps/control-center/package.json")" ] \
    || fail "the existing app's Control Center version does not match this checkout."
  expected_protocol=$(node -p 'require(process.argv[1]).controlProtocol' "$repo_dir/apps/control-center/package.json")
  [ "$(read_plist "$existing_info" ModelRouterControlProtocol)" = "$expected_protocol" ] \
    || fail "the existing app uses an incompatible Control Center protocol."
  /usr/bin/codesign --verify --deep --strict "$existing_bundle" >/dev/null 2>&1 \
    || fail "the existing app signature is invalid."
  /usr/bin/codesign -dv --verbose=4 "$existing_bundle" 2>&1 | /usr/bin/grep -qx 'Signature=adhoc' \
    || fail "preserving the existing tray requires its current local ad-hoc signature."
  /usr/bin/lipo "$existing_bundle/Contents/MacOS/ModelRouterTray" -verify_arch "$required_arch" >/dev/null 2>&1 \
    || fail "the existing tray does not support this Mac's architecture."
  /usr/bin/ditto "$existing_bundle" "$destination_bundle"
  destination_control="$destination_bundle/Contents/Resources/Control Center.app"
  /bin/rm -rf "$destination_control"
  /usr/bin/ditto "$control_center" "$destination_control"
else
  /usr/bin/ditto "$source_bundle" "$destination_bundle"
  destination_control="$destination_bundle/Contents/Resources/Control Center.app"
fi
destination_info="$destination_bundle/Contents/Info.plist"
destination_widget="$destination_bundle/Contents/PlugIns/RouterUsageWidget.appex"

# The app is installed beside the canonical state-owner checkout. Bind both
# launch paths to that checkout before the transaction installer verifies and
# swaps the staged app.
/usr/libexec/PlistBuddy -c "Set :ModelRouterSourceRoot $repo_dir" "$destination_info"
printf '%s\n' "$repo_dir" > "$destination_control/Contents/Resources/router-root"
/usr/libexec/PlistBuddy -c "Set :ModelRouterBuildSHA $expected_build_sha" \
  "$destination_control/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :ModelRouterBuildSHA string $expected_build_sha" \
    "$destination_control/Contents/Info.plist"

signing_identity=${MODEL_ROUTER_CODESIGN_IDENTITY:--}
if [ -n "$existing_bundle" ]; then
  signing_identity=-
  /usr/libexec/PlistBuddy -c "Print :ModelRouterWidgetStorageMode" "$destination_info" >/dev/null \
    || fail "the existing tray has no widget storage mode marker."
elif [ "$signing_identity" = "-" ]; then
  widget_storage_mode=local
  widget_entitlements="$repo_dir/apps/macos/RouterUsageWidget/RouterUsageWidget/RouterUsageWidget.local.entitlements"
else
  widget_storage_mode=app-group
  widget_entitlements="$repo_dir/apps/macos/RouterUsageWidget/RouterUsageWidget/RouterUsageWidget.entitlements"
fi
if [ -z "$existing_bundle" ]; then
  /usr/libexec/PlistBuddy -c "Set :ModelRouterWidgetStorageMode $widget_storage_mode" "$destination_info"
  /usr/libexec/PlistBuddy -c "Set :ModelRouterWidgetStorageMode $widget_storage_mode" \
    "$destination_widget/Contents/Info.plist"
fi

# Sign nested code only after all bundle mutations, in the same order as the
# source builder. This preserves the installer transaction's strict seal check.
/usr/bin/codesign --force --deep --sign "$signing_identity" "$destination_control"
if [ -z "$existing_bundle" ]; then
  /usr/bin/codesign --force --sign "$signing_identity" \
    --entitlements "$widget_entitlements" "$destination_widget"
fi
if [ -n "$existing_bundle" ] || [ "$signing_identity" = "-" ]; then
  /usr/bin/codesign --force --sign "$signing_identity" "$destination_bundle"
else
  /usr/bin/codesign --force --sign "$signing_identity" \
    --entitlements "$repo_dir/apps/macos/ModelRouterTray/Resources/ModelRouterTray.entitlements" \
    "$destination_bundle"
fi
/usr/bin/codesign --verify --deep --strict "$destination_bundle"
