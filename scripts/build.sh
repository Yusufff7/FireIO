#!/usr/bin/env bash
# Builds FireIO for a Fire TV Stick and, given a device, installs it.
#
# Run inside the Vega SDK container (see docker/README.md):
#
#   scripts/build.sh <build-number> [device-ip:port]
#
# The build number must be higher than the one already on the device — the
# device refuses to install a lower one. With a device address, the package
# is installed and launched; without one it's just built, under
# build/package/.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD_NUMBER=${1:?usage: scripts/build.sh <build-number> [device-ip:port]}
DEVICE=${2:-}
TARGET=armv7 # Fire TV Stick 4K Select; aarch64 and x86_64 also exist

export PATH="$HOME/vega/bin:$PATH"
SDK_ENV=$(ls -d "$HOME"/vega/sdk/vega-sdk/main/*/workspace/env 2>/dev/null | sort -V | tail -1)
VPT="$SDK_ENV/VegaPackagingTool-1.0/runtime/bin/vpt"
VDA="$SDK_ENV/KeplerCLIVegaDeviceAdaptor-2.0/runtime/bin/vda"
[ -x "$VPT" ] || { echo "Vega SDK not found under ~/vega — install it first (docker/README.md)"; exit 1; }

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ ! -f "$ROOT/src/storage/localDefaults.ts" ]; then
  say "No src/storage/localDefaults.ts — creating one from the template (no addons configured)"
  cp "$ROOT/src/storage/localDefaults.example.ts" "$ROOT/src/storage/localDefaults.ts"
fi

# --- Native module -----------------------------------------------------------
# libmatroska needs a small CMake patch to build against the libebml next to
# it rather than an installed one. Applied once; a no-op afterwards.
cd "$ROOT/MkvDemuxModule"
if git -C third_party/libmatroska apply --check ../../patches/libmatroska-in-tree-ebml.patch 2>/dev/null; then
  say "Patching libmatroska for an in-tree build"
  git -C third_party/libmatroska apply ../../patches/libmatroska-in-tree-ebml.patch
fi
[ -d node_modules ] || { say "Installing native module dependencies"; npm install --no-audit --no-fund; }
say "Building native module ($TARGET)"
npx tsc -p tsconfig.json
vega build -t "$TARGET" -b Release

# --- App -----------------------------------------------------------------------
cd "$ROOT"
[ -d node_modules ] || { say "Installing app dependencies"; npm install --no-audit --no-fund; }
say "Building app (bundling JS — takes a few minutes)"
# --reset-cache matters: without it Metro can reuse a stale bundle and ship
# old code even though the sources changed.
npx react-native build-vega --build-type Release --reset-cache

# --- Package ---------------------------------------------------------------------
STAGE="$ROOT/build/private/vega/$TARGET/Release"
OUT="$ROOT/build/package"
# Packaging-tool workaround: vpt zeroes these two staged files after signing
# them, so the installed app fails its integrity check unless they're
# already zero-filled (same size) when it signs.
for f in "$STAGE/assets/kepler-sdk-version" "$STAGE/bundle/assets/app.json"; do
  [ -f "$f" ] && head -c "$(stat -c %s "$f")" /dev/zero > "$f.zeroed" && mv "$f.zeroed" "$f"
done
rm -rf "$OUT/stremiovega_$TARGET"
mkdir -p "$OUT"
say "Packaging build $BUILD_NUMBER"
"$VPT" pack "$STAGE" -n "@amazon-devices/stremiovega_$TARGET" -d "$OUT" -b "$BUILD_NUMBER" --validate
VPKG="$OUT/@amazon-devices/stremiovega_$TARGET.vpkg"
echo "Package: $VPKG"

# --- Install ----------------------------------------------------------------------
if [ -n "$DEVICE" ]; then
  say "Installing on $DEVICE"
  "$VDA" connect "$DEVICE"
  vega run-app "$VPKG" com.yusuf.stremiovega.main --deviceId "$DEVICE"
fi
