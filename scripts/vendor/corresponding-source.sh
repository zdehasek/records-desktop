#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOCK="$ROOT/vendor/sources.lock.json"
DOWNLOADS="$ROOT/.build/vendor/downloads"
OUTPUT="$ROOT/.build/vendor/corresponding-source"
VERSION=$(node -p "require('$ROOT/package.json').version")
trap 'rm -rf "$OUTPUT"' EXIT

COMPONENTS=(ffmpeg x264 libheif libde265 dav1d)
node "$ROOT/scripts/vendor/fetch.mjs" "${COMPONENTS[@]}"
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/archives" "$OUTPUT/build-scripts" "$OUTPUT/signing-materials" "$ROOT/dist-electron"

for name in "${COMPONENTS[@]}"; do
  archive=$(node -e 'const c=require(process.argv[1]).components.find(x=>x.name===process.argv[2]);const p=new URL(c.url).pathname.split("/").filter(Boolean);process.stdout.write(p.at(-1)==="download"?p.at(-2):p.at(-1))' "$LOCK" "$name")
  cp "$DOWNLOADS/$archive" "$OUTPUT/archives/"
done
cp "$LOCK" "$OUTPUT/sources.lock.json"
cp "$ROOT/scripts/vendor/build-macos.sh" "$ROOT/scripts/vendor/corresponding-source.sh" "$ROOT/scripts/vendor/fetch.mjs" "$ROOT/scripts/vendor/validate.mjs" "$ROOT/scripts/vendor/policy.xml" "$OUTPUT/build-scripts/"
cp "$ROOT/scripts/sign-macos.cjs" "$ROOT/electron-builder.config.cjs" "$ROOT/build/entitlements.mac.plist" "$ROOT/build/entitlements.mac.inherit.plist" "$ROOT/build/entitlements.magick.plist" "$OUTPUT/signing-materials/"
{
  printf 'Records %s corresponding source and LGPL relinking materials\n' "$VERSION"
  printf 'Generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Host: %s\n' "$(uname -a)"
  if command -v xcodebuild >/dev/null; then xcodebuild -version; fi
  if command -v clang >/dev/null; then clang --version; fi
} > "$OUTPUT/TOOLCHAIN.txt"
cat > "$OUTPUT/README.txt" <<'EOF'
This archive contains the exact pristine sources and build materials for the
bundled GPL FFmpeg/x264 programs and the LGPL libheif/libde265 shared
libraries, including their static dav1d dependency. Records itself remains
under its stated license.

To reproduce a build, start with the Records source checkout for this release.
Copy archives/* to .build/vendor/downloads/, sources.lock.json to vendor/, and
build-scripts/* to scripts/vendor/. On the matching macOS/Xcode architecture,
run scripts/vendor/build-macos.sh. The fetch script downloads and verifies any
other locked dependencies needed for the complete media-tool build.
sources.lock.json gives the exact versions, checksums, and options;
scripts/vendor/validate.mjs performs staged-tree and relocation checks.
signing-materials/ records the exact hardened-runtime policy used by the release
build, including the Magick-only library-validation exception.

libheif.dylib and libde265.dylib are deliberately separate shared libraries in
the application resources. You may rebuild or modify either LGPL library from
the included source, replace the corresponding staged dylib, and re-sign the
application as macOS requires. No technical measure in Records prohibits that
replacement or reverse engineering for debugging those modifications.
EOF

COPYFILE_DISABLE=1 tar -czf "$ROOT/dist-electron/Records-$VERSION-corresponding-source.tar.gz" -C "$OUTPUT" .
shasum -a 256 "$ROOT/dist-electron/Records-$VERSION-corresponding-source.tar.gz"
