#!/usr/bin/env bash
# Claude Router v3 - manual installer.
# Copies hooks, agents, and skills into ~/.claude and registers the hooks
# (UserPromptSubmit router + SessionStart self-heal) via cr-doctor.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude"

echo "Claude Router v3 installer"
echo "  from: $SRC"
echo "  to:   $DEST"
echo

mkdir -p "$DEST/hooks/UserPromptSubmit" "$DEST/agents/claude-router" "$DEST/skills"

cp "$SRC/hooks/classify-prompt.py" "$DEST/hooks/UserPromptSubmit/classify-prompt.py"
cp "$SRC/hooks/cr-doctor.py"       "$DEST/hooks/cr-doctor.py"
echo "  hooks copied"

cp "$SRC"/agents/*.md "$DEST/agents/claude-router/" 2>/dev/null || true
echo "  agents copied"

for s in "$SRC"/skills/*/; do
  name="$(basename "$s")"
  mkdir -p "$DEST/skills/$name"
  cp "${s}SKILL.md" "$DEST/skills/$name/SKILL.md" 2>/dev/null || true
done
echo "  skills copied"

echo
echo "Registering hooks via cr-doctor..."
python3 "$DEST/hooks/cr-doctor.py"

echo
echo "Done. Restart Claude Code to activate routing."
echo "Optional extras (status-line tally + daily self-heal cron): see docs/configuration.md"
