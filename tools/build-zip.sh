#!/usr/bin/env bash
# Build the release zip from the COMMITTED plug-in (never the working tree), reproducibly:
# fixed file times (the last commit that touched the plug-in files), no extra attributes, a fixed file order. Rebuilding the
# same commit gives the same SHA-256, so anyone can check a published zip against its tag.
#   tools/build-zip.sh 0.2.0 [out-dir]
set -euo pipefail
VERSION="${1:?usage: tools/build-zip.sh <version> [out-dir]}"
OUT="${2:-dist}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
grep -q "version: \"$VERSION\"" plugin/plugin.js || { echo "plugin.js does not report version $VERSION" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/x" "$WORK/stage/engram-buzz-plugin"
git archive HEAD plugin/manifest.json plugin/plugin.js | tar -x -C "$WORK/x"
cp "$WORK/x/plugin/manifest.json" "$WORK/x/plugin/plugin.js" "$WORK/stage/engram-buzz-plugin/"
TS="$(git log -1 --format=%cd --date=format:%Y%m%d%H%M.%S -- plugin/manifest.json plugin/plugin.js)"
touch -t "$TS" "$WORK/stage/engram-buzz-plugin" "$WORK/stage/engram-buzz-plugin/"*
mkdir -p "$OUT"
ZIP="$(cd "$OUT" && pwd)/engram-buzz-plugin-$VERSION.zip"
rm -f "$ZIP"
(cd "$WORK/stage" && TZ=UTC zip -X -D -q "$ZIP" engram-buzz-plugin/manifest.json engram-buzz-plugin/plugin.js)
shasum -a 256 "$ZIP"
