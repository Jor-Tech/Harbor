#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
launcher="$HOME/.local/share/applications/harbor.desktop"
# A user launcher takes precedence over the DEB's launcher with the same name.
# Retire only the exact legacy shortcut created by this script.
if [ -x /opt/Harbor/harbor-terminal ] && [ -f /usr/share/applications/harbor.desktop ]; then
  if [ -f "$launcher" ]; then
    if ! grep -Fqx "Exec=\"$project_dir/release/linux-unpacked/harbor-terminal\"" "$launcher"; then
      printf '%s\n' "A custom launcher exists at $launcher; inspect it before switching to the installed package." >&2
      exit 1
    fi
    mkdir -p "$HOME/.local/share/Harbor/launcher-backups"
    mv "$launcher" "$HOME/.local/share/Harbor/launcher-backups/harbor.desktop.$(date +%s)"
  fi
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  printf '%s\n' 'Harbor now uses the installed DEB launcher in /usr/share/applications/harbor.desktop.'
  exit 0
fi
app_binary="$project_dir/release/linux-unpacked/harbor-terminal"
if [ ! -x "$app_binary" ]; then
  printf '%s\n' 'Build Harbor first with npm run dist.' >&2
  exit 1
fi
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
install -m 644 "$project_dir/assets/harbor.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/harbor.svg"
cat > "$HOME/.local/share/applications/harbor.desktop" <<DESKTOP
[Desktop Entry]
Name=Harbor
Comment=SSH workspace with an independent encrypted vault
Exec="$app_binary"
Icon=harbor
Terminal=false
Type=Application
Categories=Network;RemoteAccess;
StartupWMClass=harbor
DESKTOP
chmod 644 "$HOME/.local/share/applications/harbor.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications"
fi
printf '%s\n' 'Harbor is available in the applications menu.'
