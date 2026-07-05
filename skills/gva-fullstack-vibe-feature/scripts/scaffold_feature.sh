#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TPL="$SKILL_DIR/assets/templates"

to_pascal() {
  python3 - "$1" <<'PY'
import re, sys
s=sys.argv[1]
print(''.join(p[:1].upper()+p[1:] for p in re.split(r'[_\-\s]+', s) if p))
PY
}

to_upper() {
  printf "%s" "$1" | tr '[:lower:]-' '[:upper:]_'
}

find_go_module() {
  if [ -f "$ROOT/server/go.mod" ]; then
    awk '/^module / {print $2; exit}' "$ROOT/server/go.mod"
  elif [ -f "$ROOT/go.mod" ]; then
    awk '/^module / {print $2; exit}' "$ROOT/go.mod"
  else
    echo ""
  fi
}

write_from_template() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    echo "skip existing ${dst#$ROOT/}"
    return
  fi
  sed \
    -e "s/{{MODULE}}/$MODULE/g" \
    -e "s/{{PASCAL}}/$PASCAL/g" \
    -e "s/{{UPPER}}/$UPPER/g" \
    -e "s#{{GO_MODULE}}#$GO_MODULE#g" \
    -e "s/{{ROUTE_PREFIX}}/$ROUTE_PREFIX/g" \
    -e "s/{{SNAKE_TABLE}}/$SNAKE_TABLE/g" \
    "$src" > "$dst"
  echo "created ${dst#$ROOT/}"
}

MODULE="$1"
if [ -z "$MODULE" ]; then
  echo "usage: scaffold_feature.sh <module>" >&2
  exit 2
fi

PASCAL="$(to_pascal "$MODULE")"
UPPER="$(to_upper "$MODULE")"
GO_MODULE="${GO_MODULE:-$(find_go_module)}"
ROUTE_PREFIX="${ROUTE_PREFIX:-$MODULE}"
SNAKE_TABLE="${SNAKE_TABLE:-$MODULE}"

if [ -z "$GO_MODULE" ]; then
  echo "cannot detect go module; set GO_MODULE=..." >&2
  exit 1
fi

write_from_template "$TPL/backend/api.go.tpl" "$ROOT/server/api/v1/$MODULE/$MODULE.go"
write_from_template "$TPL/backend/service.go.tpl" "$ROOT/server/service/$MODULE/$MODULE.go"
write_from_template "$TPL/backend/model.go.tpl" "$ROOT/server/model/$MODULE/$MODULE.go"
write_from_template "$TPL/backend/request.go.tpl" "$ROOT/server/model/$MODULE/request/$MODULE.go"
write_from_template "$TPL/backend/response.go.tpl" "$ROOT/server/model/$MODULE/response/$MODULE.go"
write_from_template "$TPL/backend/autosync.go.tpl" "$ROOT/server/utils/autosync/autosync.go"
write_from_template "$TPL/frontend/api.js.tpl" "$ROOT/web/src/api/$MODULE.js"
write_from_template "$TPL/frontend/index.vue.tpl" "$ROOT/web/src/view/$MODULE/index.vue"
write_from_template "$TPL/frontend/permissions.js.tpl" "$ROOT/web/src/view/$MODULE/permissions.js"
write_from_template "$TPL/frontend/use-list.js.tpl" "$ROOT/web/src/view/$MODULE/composables/use${PASCAL}List.js"

cat <<EOF

Next wiring steps:
  1. Import server/api/v1/$MODULE in server/initialize/router_biz.go
  2. Call $MODULE.Register(private, public, global.GVA_DB, global.GVA_LOG)
  3. Add autosync.Flush(global.GVA_DB) at end of initBizRouter
  4. Add autosync.FlushMenus(global.GVA_DB) at end of initBizRouter
  5. If model has new tables, add to bizModel() in gorm_biz.go

Then run:
  $SKILL_DIR/scripts/vibe_check.sh "$MODULE"
EOF
