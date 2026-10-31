#!/usr/bin/env bash
set -e

DEST_DIR="$HOME/.config/herdr-app"
MOD_DIR="$DEST_DIR/mods/workspace-status-custom"
LAYOUT_DIR="$DEST_DIR/layouts"

echo "Installing Remote Status Monitor for Herdr App..."

mkdir -p "$MOD_DIR" "$LAYOUT_DIR"
cp -r mods/workspace-status-custom/* "$MOD_DIR/"
cp layouts/main-custom.json "$LAYOUT_DIR/"

if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$MOD_DIR"
    herdr-app do layout.switch '{"name":"main-custom"}' || true
fi

echo "Installation complete! The status bar monitor is now active."
