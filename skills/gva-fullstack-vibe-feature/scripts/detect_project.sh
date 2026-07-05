#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
ROOT="$(cd "$ROOT" && pwd)"

exists() {
  if [ -e "$ROOT/$1" ]; then
    printf "yes"
  else
    printf "no"
  fi
}

find_go_module() {
  if [ -f "$ROOT/server/go.mod" ]; then
    awk '/^module / {print $2; exit}' "$ROOT/server/go.mod"
  elif [ -f "$ROOT/go.mod" ]; then
    awk '/^module / {print $2; exit}' "$ROOT/go.mod"
  else
    printf ""
  fi
}

printf "root=%s\n" "$ROOT"
printf "config=%s\n" "$(exists ".vibe-feature.yaml")"
printf "backend_api=%s\n" "$(exists "server/api/v1")"
printf "backend_service=%s\n" "$(exists "server/service")"
printf "backend_model=%s\n" "$(exists "server/model")"
printf "frontend_api=%s\n" "$(exists "web/src/api")"
printf "frontend_view=%s\n" "$(exists "web/src/view")"
printf "go_module=%s\n" "$(find_go_module)"
