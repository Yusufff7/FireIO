#!/usr/bin/env bash
# Builds the host-side native test tools (MkvDemuxModule/test) — parsing,
# remuxing, seeking and subtitle extraction against real files on disk, no
# device needed. Needs cmake and a C++17 compiler; the build container has
# both. Tools land in MkvDemuxModule/test/build/; run each without arguments
# for its usage (see the README's "Testing without a device").
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/MkvDemuxModule"
# libmatroska looks for an installed libebml; this points it at the one in
# third_party instead. Applied once; a no-op afterwards.
if git -C third_party/libmatroska apply --check ../../patches/libmatroska-in-tree-ebml.patch 2>/dev/null; then
  git -C third_party/libmatroska apply ../../patches/libmatroska-in-tree-ebml.patch
fi
cmake -S test -B test/build -DCMAKE_BUILD_TYPE=Release
cmake --build test/build -j"$(nproc)"
echo
echo "Built: $(cd test/build && ls -1 | grep -E '_probe$|^seek_|^debug_one$' | xargs)"
