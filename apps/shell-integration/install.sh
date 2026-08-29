#!/usr/bin/env sh
#
# Install the REWIND shell hook into your shell profile.
#
#   sh apps/shell-integration/install.sh
#
# Idempotent: running it twice changes nothing. It appends one `.` line to your profile and prints
# what it did. Uninstalling is deleting that line.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "${1:-${SHELL##*/}}" in
  zsh)  hook="$here/rewind.zsh";  profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash) hook="$here/rewind.bash"; profile="$HOME/.bashrc" ;;
  *)
    echo "REWIND: unsupported shell '${1:-${SHELL##*/}}'. Pass 'zsh' or 'bash' explicitly." >&2
    echo "PowerShell has its own installer: apps/shell-integration/install.ps1" >&2
    exit 1
    ;;
esac

line=". \"$hook\""

if [ -f "$profile" ] && grep -Fq "$hook" "$profile"; then
  echo "REWIND: already installed in $profile"
  exit 0
fi

printf '\n# REWIND — terminal events (commands and exit codes, never their output).\n%s\n' "$line" >> "$profile"
echo "REWIND: added to $profile"
echo "Open a new terminal, or run: $line"
