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

const {
  readManifestSchedulerResourceGrant,
  resolveManifestChildEnvironment
} = await import(pathToFileURL(process.argv[2]).href)
const workers = Number.parseInt(process.env.FSUSBLOG_COLLECT_WORKERS ?? '', 10)
const liveGrant = readManifestSchedulerResourceGrant({ env: process.env })
const env = liveGrant
  ? {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: String(liveGrant.cpuUnits),
      FSUSBLOG_STEP_MEMORY_GIB: String(liveGrant.memoryGiB)
    }
  : process.env
const child = resolveManifestChildEnvironment({
  env,
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

const { resolveManifestLiveCapacity } = await import(pathToFileURL(process.argv[2]).href)
const capacity = resolveManifestLiveCapacity({ env: process.env, workload: 'scheduler-admitted' })
process.stdout.write(String(capacity.maxParallel))
NODE
}

write_collect_live_grant_evidence() {
    local group="$1"
    local status_dir="$2"
    local final_status="$3"
    local evidence_file="${FSUSBLOG_COLLECT_LIVE_GRANT_EVIDENCE_FILE:-}"
    if [[ -z "$evidence_file" ]]; then
        local run_slug
        run_slug="$(namespace_slug "${FSUSBLOG_TEST_RUN_ID:-direct}")"
        evidence_file="$ROOT_DIR/.tmp/test-results/live-grant/$run_slug/collect-$(namespace_slug "$group").json"
    fi
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$status_dir" "$evidence_file" "$group" "$final_status" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [statusDir, outputFile, group, finalStatus] = process.argv.slice(2)
const lines = (file) => {
  try { return fs.readFileSync(path.join(statusDir, file), 'utf8').split(/\r?\n/u).filter(Boolean) } catch { return [] }
}
const plan = lines('plan.tsv').map((line) => {
  const [index, label] = line.split('\t')
  return { index: Number(index), label }
})
const grantHistory = lines('grant-history.tsv').map((line) => {
  const [observedAtMs, workerCap] = line.split('\t')
  return { observedAtMs: Number(observedAtMs), workerCap: Number(workerCap) }
})
const blocked = lines('blocked.tsv').map((line) => {
  const [observedAtMs, next, activeWeight, workerCap] = line.split('\t')
  return { observedAtMs: Number(observedAtMs), next: Number(next), activeWeight: Number(activeWeight), workerCap: Number(workerCap), reason: 'live-grant-capacity' }
})
const children = plan.map(({ index, label }) => {
  const statusFile = fs.readdirSync(statusDir).find((name) => name.startsWith(`${index + 1}-`) && name.endsWith('.status'))
  if (!statusFile) return { id: label, status: finalStatus === 'cancelled' ? 'cancelled' : 'not-started' }
  const [exitCode, admittedAtMs, finishedAtMs, cpuBudget, memoryGiB, nestedWorkers] = fs.readFileSync(path.join(statusDir, statusFile), 'utf8').trim().split('\t')
  return {
    id: label,
    status: exitCode === '0' ? 'success' : 'failure',
    exitCode: Number(exitCode),
    admittedAtMs: Number(admittedAtMs),
    finishedAtMs: Number(finishedAtMs),
    durationMs: Number(finishedAtMs) - Number(admittedAtMs),
    cpuBudget: Number(cpuBudget),
    memoryGiB: Number(memoryGiB),
    nestedWorkers: Number(nestedWorkers)
  }
})
const document = {
  schema: 'fsusblog.live-grant-execution.v1',
  lane: `collect:${group}`,
  executionMode: process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ? 'live-grant' : 'fixed',
  schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID || null,
  status: finalStatus,
  grantHistory,
  children,
  blocked,
  generatedAt: new Date().toISOString()
}
fs.mkdirSync(path.dirname(outputFile), { recursive: true })
const temporary = `${outputFile}.next-${process.pid}`
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
fs.renameSync(temporary, outputFile)
NODE
}

run_collect_parallel() {
    local group="$1"
    shift
    if (($# == 0 || $# % 2 != 0)); then
        printf '[lane] %s requires label/function pairs\n' "$group" >&2
        return 2
    fi

    local total=$(($# / 2))
    local worker_cap
    worker_cap="$(resolve_collect_parallel_workers "$total")"
    local status_dir="$ROOT_DIR/.tmp/parallel-status/$(namespace_slug "$group")-$$-$RANDOM"
    local -a labels=()
    local -a commands=()
    local -a status_files=()
    local -a child_pids=()
    local -a observed=()
    mkdir -p "$status_dir"
    : >"$status_dir/plan.tsv"
    : >"$status_dir/grant-history.tsv"
    : >"$status_dir/blocked.tsv"

    while (($# > 0)); do
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
        printf '%s\t%s\n' "$((${#labels[@]} - 1))" "$label" >>"$status_dir/plan.tsv"
    done

    log "collect group start: $group ($total jobs, workers=$worker_cap)"
    printf '%s\t%s\n' "$(date +%s%3N)" "$worker_cap" >>"$status_dir/grant-history.tsv"
    local next=0
    local active=0
    local completed=0
    trap 'for child_pid in "${child_pids[@]:-}"; do kill "$child_pid" >/dev/null 2>&1 || true; done; write_collect_live_grant_evidence "$group" "$status_dir" cancelled; exit 130' INT TERM
    local blocked_signature=''
    while ((completed < total)); do
        local next_worker_cap
        next_worker_cap="$(resolve_collect_parallel_workers "$total")"
        if [[ "$next_worker_cap" != "$worker_cap" ]]; then
            log "collect capacity update: $group (workers=$worker_cap->$next_worker_cap active=$active)"
            worker_cap="$next_worker_cap"
            printf '%s\t%s\n' "$(date +%s%3N)" "$worker_cap" >>"$status_dir/grant-history.tsv"
        fi
        local child_env_file=''
        if ((next < total && active < worker_cap)); then
            child_env_file="$status_dir/wave-$next-$worker_cap.env"
            resolve_collect_child_environment "$worker_cap" >"$child_env_file"
        fi
        while ((next < total && active < worker_cap)); do
            local index="$next"
            (
                set +e
                while IFS='=' read -r key value; do
                    [[ -n "$key" ]] && export "$key=$value"
                done <"$child_env_file"
                local admitted_at_ms
                admitted_at_ms="$(date +%s%3N)"
                log "collect start: ${labels[$index]}"
                ("${commands[$index]}")
                local child_status=$?
                if ((child_status == 0)); then
                    log "collect done: ${labels[$index]}"
                else
                    log "collect failed: ${labels[$index]} (exit $child_status)"
                fi
                local finished_at_ms
                finished_at_ms="$(date +%s%3N)"
                local pending_status="${status_files[$index]}.pending-$BASHPID"
                printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
                    "$child_status" "$admitted_at_ms" "$finished_at_ms" \
                    "${FSUSBLOG_STEP_CPU_BUDGET:-0}" "${FSUSBLOG_STEP_MEMORY_GIB:-0}" \
                    "${FSUSBLOG_COMMAND_MANIFEST_WORKERS:-0}" >"$pending_status"
                mv "$pending_status" "${status_files[$index]}"
                exit 0
            ) &
            child_pids[$index]="$!"
            observed[$index]=0
            next=$((next + 1))
            active=$((active + 1))
            blocked_signature=''
        done
        if ((next < total && active >= worker_cap)); then
            local next_blocked_signature="$next:$active:$worker_cap"
            if [[ "$next_blocked_signature" != "$blocked_signature" ]]; then
                blocked_signature="$next_blocked_signature"
                printf '%s\t%s\t%s\t%s\n' "$(date +%s%3N)" "$next" "$active" "$worker_cap" >>"$status_dir/blocked.tsv"
            fi
        fi
        local progressed=0
        local index
        for ((index = 0; index < next; index += 1)); do
            if [[ "${observed[$index]:-0}" == "1" || ! -f "${status_files[$index]}" ]]; then
                continue
            fi
            wait "${child_pids[$index]}" >/dev/null 2>&1 || true
            observed[$index]=1
            active=$((active - 1))
            completed=$((completed + 1))
            progressed=1
        done
        if ((completed < total && progressed == 0)); then
            sleep 0.1
        fi
    done
    trap - INT TERM

    local index
    local group_failed=0
    for ((index = 0; index < total; index += 1)); do
        local child_status
        if [[ -f "${status_files[$index]}" ]]; then
            IFS=$'\t' read -r child_status _ <"${status_files[$index]}"
        else
            child_status=125
        fi
        if [[ "$child_status" != "0" ]]; then
            group_failed=1
            LANE_FAILURES+=("${labels[$index]} (exit ${child_status})")
        fi
    done
    local final_status='success'
    if ((group_failed == 1)); then final_status='failure'; fi
    write_collect_live_grant_evidence "$group" "$status_dir" "$final_status"
    rm -rf "$status_dir"
    log "collect group done: $group"
    return 0
}

finish_collect() {
    if ((${#LANE_FAILURES[@]} == 0)); then
        return 0
    fi
    printf '[lane] %d command(s) failed:\n' "${#LANE_FAILURES[@]}" >&2
    printf '  - %s\n' "${LANE_FAILURES[@]}" >&2
    return 1
}
