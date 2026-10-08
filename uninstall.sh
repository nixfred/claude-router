#!/usr/bin/env bash
# Claude Router uninstaller.
#
#   ./uninstall.sh        remove the v4 mod (tier-router) and this marketplace
#   ./uninstall.sh --v3   retire a v3 install: its python hooks, their
#                         settings.json entries, executor agents and skills
#
# Nothing is deleted: v3 files and a settings.json backup are moved to
# ~/.claude/.trash/claude-router-v3-<time>/ so any of it can be put back.
# cr-usage.py stays where it is; status lines read it.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

retire_v3() {
  local trash="$CLAUDE_DIR/.trash/claude-router-v3-$(date +%Y%m%d-%H%M%S)"
  local moved=0

  # 1. Unwire first: v3's SessionStart doctor rebuilds whatever it finds missing.
  if [ -f "$SETTINGS" ] && jq -e '[.hooks[]?[]?.hooks[]?.command // ""] | any(test("classify-prompt\\.py|cr-doctor\\.py|cr-record-exec\\.py"))' "$SETTINGS" >/dev/null 2>&1; then
    mkdir -p "$trash"
    cp -p "$SETTINGS" "$trash/settings.json.bak"
    jq '.hooks |= (
          with_entries(.value |= (
            map(.hooks |= map(select((.command // "") | test("classify-prompt\\.py|cr-doctor\\.py|cr-record-exec\\.py") | not)))
            | map(select((.hooks | length) > 0))
          ))
          | with_entries(select((.value | length) > 0))
        )' "$SETTINGS" > "$SETTINGS.cr-tmp"
    jq -e . "$SETTINGS.cr-tmp" >/dev/null
    mv "$SETTINGS.cr-tmp" "$SETTINGS"
    echo "  unwired v3 hooks from settings.json (backup: $trash/settings.json.bak)"
  fi

  # 2. Move v3's files aside.
  for f in hooks/UserPromptSubmit/classify-prompt.py hooks/cr-doctor.py hooks/cr-record-exec.py agents/claude-router; do
    if [ -e "$CLAUDE_DIR/$f" ]; then
      mkdir -p "$trash/$(dirname "$f")"
      mv "$CLAUDE_DIR/$f" "$trash/$f"
      echo "  moved $f"
      moved=$((moved + 1))
    fi
  done

  # 3. v3's skills, recognised by their exact description line, never by name alone.
  local descriptions=(
    'Manually route a query to the optimal Claude model (Haiku/Sonnet/Opus)'
    'Use when user says "router stats", "/router-stats"'
    'Use when user says "cr-doctor", "/cr-doctor"'
    'Retry the last query with an escalated model'
    'Extract and persist insights from the current conversation to the knowledge base'
    'Display knowledge base status and recent learnings'
    'Execute complex multi-step tasks with forked subtask contexts'
    'Generate HTML analytics dashboard for routing statistics'
    'List and toggle official plugin integrations'
    'Enable continuous learning mode for automatic insight extraction'
    'Disable continuous learning mode'
    'Clear the knowledge base and start fresh'
  )
  for skill in route router-stats cr-doctor retry learn knowledge orchestrate router-analytics router-plugins learn-on learn-off learn-reset; do
    local file="$CLAUDE_DIR/skills/$skill/SKILL.md"
    [ -f "$file" ] || continue
    local line
    line="$(grep -m1 '^description:' "$file" || true)"
    for d in "${descriptions[@]}"; do
      if [[ "$line" == "description: $d"* ]]; then
        mkdir -p "$trash/skills"
        mv "$CLAUDE_DIR/skills/$skill" "$trash/skills/$skill"
        echo "  moved skills/$skill"
        moved=$((moved + 1))
        break
      fi
    done
  done

  if [ -d "$trash" ]; then
    echo "v3 retired. Everything removed is in $trash"
  else
    echo "No v3 install found."
  fi
}

if [ "${1:-}" = "--v3" ]; then
  retire_v3
  exit 0
fi

echo "Removing the tier-router mod..."
claude plugin uninstall tier-router@claude-router --scope user || true
claude plugin marketplace remove claude-router || true
echo "Done. Start a new Claude Code session for it to take effect."
