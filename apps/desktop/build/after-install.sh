#!/bin/bash
# Post-install: register the desktop actions and the package MIME type.
#
# electron-builder writes the .desktop entry from package.json but has no
# config for [Desktop Action] groups, so they are appended here.
set -e

DESKTOP=/usr/share/applications/noishi-desktop.desktop
MIME_DIR=/usr/share/mime/packages

if [ -f "$DESKTOP" ]; then
    if ! grep -q '^Actions=' "$DESKTOP"; then
        sed -i 's|^Categories=.*|&\nActions=new-chat;new-code;|' "$DESKTOP"
    fi
    if ! grep -q '^\[Desktop Action new-chat\]' "$DESKTOP"; then
        cat >> "$DESKTOP" <<'EOF'

[Desktop Action new-chat]
Name=Nova conversa
Exec=/opt/Noishi/noishi-desktop noishi://chat/new
Icon=noishi-desktop

[Desktop Action new-code]
Name=Nova sessão Code
Exec=/opt/Noishi/noishi-desktop noishi://code/new
Icon=noishi-desktop
EOF
    fi
fi

if [ -d "$MIME_DIR" ]; then
    cat > "$MIME_DIR/noishi-package.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-noishi-package">
    <comment>Noishi agent package</comment>
    <glob pattern="*.mcpb"/>
    <glob pattern="*.skill"/>
    <glob pattern="*.dxt"/>
  </mime-type>
</mime-info>
EOF
    if command -v update-mime-database >/dev/null 2>&1; then
        update-mime-database "$MIME_DIR" || true
    fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
