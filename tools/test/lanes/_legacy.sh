#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1
# shellcheck source=../legacy-test.sh
source "$ROOT_DIR/tools/test/legacy-test.sh"

LANE_FAILURES=()

run_collect() {
  local label="$1"
  shift
  if "$@"; then
    return 0
  else
    local status=$?
    LANE_FAILURES+=("${label} (exit ${status})")
  fi
  return 0
}

resolve_collect_child_environment() {
  local workers="$1"
  FSUSBLOG_COLLECT_WORKERS="$workers" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const { resolveManifestChildEnvironment } = await import(pathToFileURL(process.argv[2]).href)
const workers = Number.parseInt(process.env.FSUSBLOG_COLLECT_WORKERS ?? '', 10)
const child = resolveManifestChildEnvironment({
  env: process.env,
  workers,
  concurrent: workers > 1
})
for (const key of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY'
]) {
  if (child[key] !== undefined) process.stdout.write(`${key}=${child[key]}\n`)
}
NODE
}

resolve_collect_parallel_workers() {
  local job_count="$1"
  FSUSBLOG_COMMAND_MANIFEST_WORKERS="$job_count" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const { resolveManifestWorkers } = await import(pathToFileURL(process.argv[2]).href)
process.stdout.write(String(resolveManifestWorkers({ env: process.env })))
NODE
}

run_collect_parallel() {
  local group="$1"
  shift
  if (( $# == 0 || $# % 2 != 0 )); then
    printf '[lane] %s requires label/function pairs\n' "$group" >&2
    return 2
  fi

  local total=$(( $# / 2 ))
  local worker_cap
  worker_cap="$(resolve_collect_parallel_workers "$total")"
  local status_dir="$ROOT_DIR/.tmp/parallel-status/$(namespace_slug "$group")-$$-$RANDOM"
  local child_env_file="$status_dir/child.env"
  local -a labels=()
  local -a commands=()
  local -a status_files=()
  mkdir -p "$status_dir"
  resolve_collect_child_environment "$worker_cap" > "$child_env_file"

  while (( $# > 0 )); do
    local label="$1"
    local command="$2"
    shift 2
    if ! declare -F "$command" >/dev/null; then
      rm -rf "$status_dir"
      printf '[lane] %s job %s references unknown function %s\n' "$group" "$label" "$command" >&2
      return 2
    fi
    labels+=("$label")
    commands+=("$command")
    status_files+=("$status_dir/${#labels[@]}-$(namespace_slug "$label").status")
  done

  log "collect group start: $group ($total jobs, workers=$worker_cap)"
  local next=0
  local active=0
  while (( next < total || active > 0 )); do
    while (( next < total && active < worker_cap )); do
      local index="$next"
      (
        set +e
        while IFS='=' read -r key value; do
          [[ -n "$key" ]] && export "$key=$value"
        done < "$child_env_file"
        log "collect start: ${labels[$index]}"
        ( "${commands[$index]}" )
        local child_status=$?
        if (( child_status == 0 )); then
          log "collect done: ${labels[$index]}"
        else
          log "collect failed: ${labels[$index]} (exit $child_status)"
        fi
        local pending_status="${status_files[$index]}.pending-$BASHPID"
        printf '%s\n' "$child_status" > "$pending_status"
        mv "$pending_status" "${status_files[$index]}"
        exit 0
      ) &
      next=$((next + 1))
      active=$((active + 1))
    done
    if (( active > 0 )); then
      wait -n || true
      active=$((active - 1))
    fi
  done

  local index
  for ((index = 0; index < total; index += 1)); do
    local child_status
    if [[ -f "${status_files[$index]}" ]]; then
      read -r child_status < "${status_files[$index]}"
    else
      child_status=125
    fi
    if [[ "$child_status" != "0" ]]; then
      LANE_FAILURES+=("${labels[$index]} (exit ${child_status})")
    fi
  done
  rm -rf "$status_dir"
  log "collect group done: $group"
  return 0
}

finish_collect() {
  if (( ${#LANE_FAILURES[@]} == 0 )); then
    return 0
  fi
  printf '[lane] %d command(s) failed:\n' "${#LANE_FAILURES[@]}" >&2
  printf '  - %s\n' "${LANE_FAILURES[@]}" >&2
  return 1
}
