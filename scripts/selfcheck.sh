#!/bin/bash

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_step() {
  local label="$1"
  shift
  printf '\n== %s ==\n' "$label"
  if "$@"; then
    printf 'PASS: %s\n' "$label"
  else
    local rc=$?
    printf 'FAIL: %s (exit %d)\n' "$label" "$rc" >&2
    exit "$rc"
  fi
}

step_validate() {
  (cd "$ROOT" && anna-app validate --strict)
}

step_build() {
  (cd "$ROOT" && npm run build)
}

step_go_build() {
  (cd "$ROOT/executas/notes-summarizer" && go build)
}

step_executa_test() {
  (cd "$ROOT" && ./scripts/test-executa.sh)
}

step_mock_sampling() {
  (cd "$ROOT" && anna-app executa dev \
    --dir executas/notes-summarizer \
    --invoke summarize \
    --args '{"notes":["自检"]}' \
    --mock-sampling fixtures/sampling-mock.jsonl)
}

run_step "anna-app validate --strict" step_validate
run_step "npm run build" step_build
run_step "go build executas/notes-summarizer" step_go_build
run_step "./scripts/test-executa.sh" step_executa_test
run_step "mock sampling summary" step_mock_sampling

printf '\nPASS: selfcheck complete\n'
