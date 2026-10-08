#!/usr/bin/env bash
# Claude Router v4 installer.
#
# Registers this folder as a plugin marketplace and installs the tier-router
# mod from it, so the session reads the mod straight from this checkout: a
# `git pull` plus /reload-plugins is an upgrade. Retires a v3 install first
# (see uninstall.sh --v3), since v3's hook would keep injecting its own
# delegation directives on top of v4's routing.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v claude >/dev/null || { echo "claude (Claude Code) is not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "Claude Router v4 installer"
echo "  from: $SRC"
echo

"$SRC/uninstall.sh" --v3
echo

if claude plugin marketplace list 2>/dev/null | grep -q 'claude-router'; then
  claude plugin marketplace update claude-router
else
  claude plugin marketplace add "$SRC"
fi
claude plugin install tier-router@claude-router --scope user
claude plugin validate "$SRC" >/dev/null

echo
echo "Installed. Open a new session (or run /reload-plugins) and type /cr to see it."
echo "Options: claude plugin configure tier-router"
