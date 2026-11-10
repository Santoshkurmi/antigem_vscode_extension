#!/usr/bin/env bash
# Build the Go bridge for every supported 64-bit platform.
# Requires: Go toolchain (CGO disabled, so cross-compilation works on any host).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p bin

# GOOS GOARCH -> VS Code target name
targets=(
  "linux   amd64  linux-x64"
  "linux   arm64  linux-arm64"
  "darwin  amd64  darwin-x64"
  "darwin  arm64  darwin-arm64"
  "windows amd64  win32-x64"
)

for entry in "${targets[@]}"; do
  read -r goos goarch target <<< "$entry"
  out="bin/antigem-bridge-${target}"
  if [ "$goos" = "windows" ]; then out="${out}.exe"; fi
  echo "==> building ${out} (${goos}/${goarch})"
  (cd bridge && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags="-s -w" -o "../${out}" .)
done

echo "==> all 64-bit bridge binaries built in bin/"
ls -lh bin/antigem-bridge-*