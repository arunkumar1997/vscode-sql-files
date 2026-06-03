#!/bin/bash
set -e

echo "Installing dependencies..."
npm install

echo "Building extension..."
npm run build

echo "Packaging VSIX..."
npx @vscode/vsce package --allow-missing-repository --skip-license --allow-star-activation

echo "Done! VSIX file:"
ls -la *.vsix
