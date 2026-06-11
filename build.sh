#!/bin/bash
set -e

echo "Installing dependencies..."
npm install

echo "Installing all platform-specific DuckDB binaries for cross-platform VSIX..."
# npm install --no-save \
#   @duckdb/node-bindings-linux-x64 \
#   @duckdb/node-bindings-linux-arm64 \
#   @duckdb/node-bindings-win32-x64 \
#   @duckdb/node-bindings-darwin-arm64 \
#   @duckdb/node-bindings-darwin-x64

echo "Building extension..."
npm run build

echo "Packaging VSIX..."
npx @vscode/vsce package --allow-missing-repository --skip-license --allow-star-activation

echo "Done! VSIX file:"
ls -la *.vsix
