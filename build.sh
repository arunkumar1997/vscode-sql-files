#!/bin/bash
# Thin wrapper kept for backward compatibility.
# For per-platform VSIX builds use:
#   npm run package:current           # build VSIX for this host
#   npm run package:all               # build VSIX for every supported target
#   npm run package:target <target>   # e.g. linux-x64, darwin-arm64
#
# Releases are produced by .github/workflows/release.yml on `v*` tags.
set -e

echo "Installing dependencies..."
npm install

echo "Packaging VSIX for current host..."
npm run package:current

echo "Done! VSIX file(s):"
ls -la out/*.vsix
