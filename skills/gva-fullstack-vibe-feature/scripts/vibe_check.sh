#!/usr/bin/env bash
set -euo pipefail

MODULE="${1:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0

error() {
  printf "ERROR: %s\n" "$*" >&2
  FAIL=1
}

warn() {
  printf "WARN: %s\n" "$*" >&2
}

check_module() {
  local module="$1"

  [ -d "$ROOT/server/router/$module" ] && error "new modules must not add server/router/$module"

  for dir in "$ROOT/server/api/v1/$module" "$ROOT/server/service/$module" "$ROOT/server/model/$module"; do
    if [ -d "$dir" ] && find "$dir" -name 'enter.go' -print -quit | grep -q .; then
      error "new modules must not add enter.go under ${dir#$ROOT/}"
    fi
  done

  if command -v rg >/dev/null 2>&1; then
    rg -n 'ApiGroupApp|ServiceGroupApp|RouterGroupApp' \
      "$ROOT/server/api/v1/$module" "$ROOT/server/service/$module" "$ROOT/server/model/$module" \
      --glob '*.go' >/tmp/vibe_groupapp.$$ 2>/dev/null || true
    [ -s /tmp/vibe_groupapp.$$ ] && { cat /tmp/vibe_groupapp.$$ >&2; error "new module uses GroupApp aggregators"; }
    rm -f /tmp/vibe_groupapp.$$

    if [ -d "$ROOT/server/service/$module" ]; then
      rg -n 'server/global|/global"|global\.' "$ROOT/server/service/$module" --glob '*.go' >/tmp/vibe_global.$$ 2>/dev/null || true
      [ -s /tmp/vibe_global.$$ ] && { cat /tmp/vibe_global.$$ >&2; error "service layer must not import or use global state directly"; }
      rm -f /tmp/vibe_global.$$
    fi

    if [ -d "$ROOT/web/src/view/$module" ]; then
      rg -n "@/utils/request|from '@/utils/request'|from \"@/utils/request\"" "$ROOT/web/src/view/$module" --glob '*.vue' --glob '*.js' >/tmp/vibe_request.$$ 2>/dev/null || true
      [ -s /tmp/vibe_request.$$ ] && { cat /tmp/vibe_request.$$ >&2; error "view layer must use module API wrappers instead of direct request imports"; }
      rm -f /tmp/vibe_request.$$
    fi
  else
    warn "rg not found; skipped pattern checks"
  fi
}

if [ -n "$MODULE" ]; then
  check_module "$MODULE"
else
  warn "no module supplied; running repository-level soft checks only"
  [ -d "$ROOT/server/api/v1" ] || warn "missing server/api/v1"
  [ -d "$ROOT/server/service" ] || warn "missing server/service"
  [ -d "$ROOT/server/model" ] || warn "missing server/model"
  [ -d "$ROOT/web/src/api" ] || warn "missing web/src/api"
  [ -d "$ROOT/web/src/view" ] || warn "missing web/src/view"
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

printf "vibe_check passed"
[ -n "$MODULE" ] && printf " for module %s" "$MODULE"
printf "\n"
