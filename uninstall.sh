#!/usr/bin/env bash
set -e

DEST_DIR="$HOME/.config/herdr-app"
MOD_DIR="$DEST_DIR/mods/workspace-status-custom"
LAYOUT_FILE="$DEST_DIR/layouts/main-custom.json"

echo "Uninstalling Remote Status Monitor from Herdr App..."

if command -v herdr-app >/dev/null 2>&1; then
    herdr-app do layout.switch '{"name":"main"}' || true
fi

rm -rf "$MOD_DIR"
rm -f "$LAYOUT_FILE"

echo "Uninstalled successfully. Switched back to default layout."
