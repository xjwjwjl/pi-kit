#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

append_block() {
  local file="$1"
  local start="<!-- gva-fullstack-vibe-feature:start -->"
  local end="<!-- gva-fullstack-vibe-feature:end -->"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -q "$start" "$file"; then
    echo "skip existing block ${file#$PWD/}"
    return
  fi
  cat >> "$file" <<EOF

$start
New business features must follow the Admin Full-Stack Vibe Feature convention.

Before implementing new requirements, read:
- $SKILL_DIR/references/workflow.md
- $SKILL_DIR/references/backend.md
- $SKILL_DIR/references/frontend.md
- $SKILL_DIR/references/forbidden.md

Use project-local .vibe-feature.yaml if present. Prefer repository-local rules when they exist.

Key rules:
- Do not create new module router directories.
- Do not create new module enter.go aggregators.
- Do not use ApiGroupApp, ServiceGroupApp, or RouterGroupApp in new business code.
- Put backend route registration in server/api/v1/{module}/ with Register(...).
- Pass dependencies explicitly through constructors.
- Put frontend API wrappers in web/src/api/{module}.js.
- Put frontend pages in web/src/view/{module}/ with components/ and composables/ as needed.

Run:
$SKILL_DIR/scripts/vibe_check.sh {module}
$end
EOF
  echo "updated ${file#$PWD/}"
}

append_block "AGENTS.md"
append_block ".cursor/rules/gva-fullstack-vibe.mdc"
append_block ".claude/rules/gva-fullstack-vibe.md"
append_block ".codex/rules/gva-fullstack-vibe.md"
