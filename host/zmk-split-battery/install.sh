#!/usr/bin/env bash
# Install the patched zmk-split-battery extension over the stock copy.
set -euo pipefail

UUID="zmk-split-battery@bogamie.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/extension/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

gnome-extensions enable "$UUID" 2>/dev/null || true

echo "Installed $UUID to $DEST"
echo "If the indicator does not appear, reload GNOME Shell (on Wayland, log out and back in)."
