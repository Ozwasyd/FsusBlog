#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    printf '[test] _lane-collect-support.sh is source-only; use ./tools/test.sh <tier>\n' >&2
    exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=_suite-support.sh
source "$ROOT_DIR/tools/test/lanes/_suite-support.sh"

LANE_FAILURES=()

RunCollect() {
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

ResolveCollectAdmissionSnapshot() {
    local jobCount="$1"
    FSUSBLOG_COLLECT_JOB_COUNT="$jobCount" \
        "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const {
  resolveManifestAdmissionSnapshot
} = await import(pathToFileURL(process.argv[2]).href)
const maxWorkers = Number.parseInt(process.env.FSUSBLOG_COLLECT_JOB_COUNT ?? '', 10)
const snapshot = resolveManifestAdmissionSnapshot({
  env: process.env,
  maxWorkers,
  workload: 'scheduler-admitted'
})
process.stdout.write(`FSUSBLOG_COLLECT_WORKER_CAP=${snapshot.workerCap}\n`)
process.stdout.write(`FSUSBLOG_COLLECT_PARENT_CPU_UNITS=${snapshot.capacity.parentCpuUnits}\n`)
process.stdout.write(`FSUSBLOG_COLLECT_PARENT_MEMORY_GIB=${snapshot.capacity.parentMemoryGiB}\n`)
process.stdout.write(`FSUSBLOG_COLLECT_GRANT_SOURCE=${snapshot.capacity.source}\n`)
for (const key of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY',
  'FSUSBLOG_PARALLEL_ACTIVE_WORKERS'
]) {
  if (snapshot.childEnvironment[key] !== undefined) {
    process.stdout.write(`${key}=${snapshot.childEnvironment[key]}\n`)
  }
}
NODE
}

CollectAdmissionSnapshotValue() {
    local snapshotFile="$1"
    local expectedKey="$2"
    local key value
    while IFS='=' read -r key value; do
        if [[ "$key" == "$expectedKey" ]]; then
            printf '%s\n' "$value"
            return 0
        fi
    done <"$snapshotFile"
    printf '[lane] collect admission snapshot is missing %s\n' "$expectedKey" >&2
    return 2
}

AppendCollectGrantHistory() {
    local historyFile="$1"
    local snapshotFile="$2"
    local workerCap parentCpu parentMemory source
    workerCap="$(CollectAdmissionSnapshotValue "$snapshotFile" FSUSBLOG_COLLECT_WORKER_CAP)"
    parentCpu="$(CollectAdmissionSnapshotValue "$snapshotFile" FSUSBLOG_COLLECT_PARENT_CPU_UNITS)"
    parentMemory="$(CollectAdmissionSnapshotValue "$snapshotFile" FSUSBLOG_COLLECT_PARENT_MEMORY_GIB)"
    source="$(CollectAdmissionSnapshotValue "$snapshotFile" FSUSBLOG_COLLECT_GRANT_SOURCE)"
    printf '%s\t%s\t%s\t%s\t%s\n' \
        "$(date +%s%3N)" "$workerCap" "$parentCpu" "$parentMemory" "$source" >>"$historyFile"
}

WriteCollectLiveGrantEvidence() {
    local group="$1"
    local statusDir="$2"
    local finalStatus="$3"
    local evidenceFile="${FSUSBLOG_COLLECT_LIVE_GRANT_EVIDENCE_FILE:-}"
    if [[ -z "$evidenceFile" ]]; then
        local runSlug
        runSlug="$(NamespaceSlug "${FSUSBLOG_TEST_RUN_ID:-direct}")"
        evidenceFile="$ROOT_DIR/.tmp/test-results/live-grant/$runSlug/collect-$(NamespaceSlug "$group").json"
    fi
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$statusDir" "$evidenceFile" "$group" "$finalStatus" <<'NODE'
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
  const [observedAtMs, workerCap, parentCpuUnits, parentMemoryGiB, source] = line.split('\t')
  return {
    observedAtMs: Number(observedAtMs),
    workerCap: Number(workerCap),
    parentCpuUnits: Number(parentCpuUnits),
    parentMemoryGiB: Number(parentMemoryGiB),
    source
  }
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
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
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

CleanupCollectParallelChildren() {
    local childPid
    for childPid in "$@"; do
        [[ -n "$childPid" ]] || continue
        kill "$childPid" >/dev/null 2>&1 || true
        wait "$childPid" >/dev/null 2>&1 || true
    done
}

CleanupCollectParallelSignal() {
    local group="$1"
    local statusDir="$2"
    shift 2
    CleanupCollectParallelChildren "$@"
    WriteCollectLiveGrantEvidence "$group" "$statusDir" cancelled
    rm -rf "$statusDir"
    exit 130
}

CleanupCollectParallelReturn() {
    local returnStatus="$1"
    local group="$2"
    local statusDir="$3"
    shift 3
    CleanupCollectParallelChildren "$@"
    WriteCollectLiveGrantEvidence "$group" "$statusDir" cancelled
    rm -rf "$statusDir"
    trap - RETURN INT TERM
    return "$returnStatus"
}

RunCollectParallel() {
    local group="$1"
    shift
    if (($# == 0 || $# % 2 != 0)); then
        printf '[lane] %s requires label/function pairs\n' "$group" >&2
        return 2
    fi

    local total=$(($# / 2))
    local statusDir
    statusDir="$ROOT_DIR/.tmp/parallel-status/$(NamespaceSlug "$group")-$$-$RANDOM"
    local -a labels=()
    local -a commands=()
    local -a statusFiles=()
    local -a childPids=()
    local -a observed=()
    mkdir -p "$statusDir"
    : >"$statusDir/plan.tsv"
    : >"$statusDir/grant-history.tsv"
    : >"$statusDir/blocked.tsv"
    local admissionSnapshotFile="$statusDir/admission-initial.env"
    ResolveCollectAdmissionSnapshot "$total" >"$admissionSnapshotFile"
    local workerCap
    workerCap="$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_WORKER_CAP)"
    local grantSignature
    grantSignature="$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_PARENT_CPU_UNITS):$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_PARENT_MEMORY_GIB):$workerCap:$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_GRANT_SOURCE)"

    while (($# > 0)); do
        local label="$1"
        local command="$2"
        shift 2
        if ! declare -F "$command" >/dev/null; then
            rm -rf "$statusDir"
            printf '[lane] %s job %s references unknown function %s\n' "$group" "$label" "$command" >&2
            return 2
        fi
        labels+=("$label")
        commands+=("$command")
        statusFiles+=("$statusDir/${#labels[@]}-$(NamespaceSlug "$label").status")
        printf '%s\t%s\n' "$((${#labels[@]} - 1))" "$label" >>"$statusDir/plan.tsv"
    done

    Log "collect group start: $group ($total jobs, workers=$workerCap)"
    AppendCollectGrantHistory "$statusDir/grant-history.tsv" "$admissionSnapshotFile"
    local next=0
    local active=0
    local completed=0
    trap 'CleanupCollectParallelReturn "$?" "$group" "$statusDir" "${childPids[@]:-}"' RETURN
    trap 'CleanupCollectParallelSignal "$group" "$statusDir" "${childPids[@]:-}"' INT TERM
    local blockedSignature=''
    while ((completed < total)); do
        admissionSnapshotFile="$statusDir/admission-$next-$completed.env"
        ResolveCollectAdmissionSnapshot "$total" >"$admissionSnapshotFile"
        local nextWorkerCap
        nextWorkerCap="$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_WORKER_CAP)"
        local nextGrantSignature
        nextGrantSignature="$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_PARENT_CPU_UNITS):$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_PARENT_MEMORY_GIB):$nextWorkerCap:$(CollectAdmissionSnapshotValue "$admissionSnapshotFile" FSUSBLOG_COLLECT_GRANT_SOURCE)"
        if [[ "$nextGrantSignature" != "$grantSignature" ]]; then
            Log "collect capacity update: $group (workers=$workerCap->$nextWorkerCap active=$active)"
            workerCap="$nextWorkerCap"
            grantSignature="$nextGrantSignature"
            AppendCollectGrantHistory "$statusDir/grant-history.tsv" "$admissionSnapshotFile"
        fi
        while ((next < total && active < workerCap)); do
            local index="$next"
            (
                set +e
                while IFS='=' read -r key value; do
                    case "$key" in
                        FSUSBLOG_STEP_CPU_BUDGET | FSUSBLOG_STEP_MEMORY_GIB | \
                            FSUSBLOG_COMMAND_MANIFEST_WORKERS | FSUSBLOG_NODE_TEST_CONCURRENCY | \
                            FSUSBLOG_PARALLEL_ACTIVE_WORKERS)
                            export "$key=$value"
                            ;;
                    esac
                done <"$admissionSnapshotFile"
                local admittedAtMs
                admittedAtMs="$(date +%s%3N)"
                Log "collect start: ${labels[$index]}"
                ("${commands[$index]}")
                local childStatus=$?
                if ((childStatus == 0)); then
                    Log "collect done: ${labels[$index]}"
                else
                    Log "collect failed: ${labels[$index]} (exit $childStatus)"
                fi
                local finishedAtMs
                finishedAtMs="$(date +%s%3N)"
                local pendingStatus="${statusFiles[$index]}.pending-$BASHPID"
                printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
                    "$childStatus" "$admittedAtMs" "$finishedAtMs" \
                    "${FSUSBLOG_STEP_CPU_BUDGET:-0}" "${FSUSBLOG_STEP_MEMORY_GIB:-0}" \
                    "${FSUSBLOG_COMMAND_MANIFEST_WORKERS:-0}" >"$pendingStatus"
                mv "$pendingStatus" "${statusFiles[$index]}"
                exit 0
            ) &
            childPids[index]="$!"
            observed[index]=0
            next=$((next + 1))
            active=$((active + 1))
            blockedSignature=''
        done
        if ((next < total && active >= workerCap)); then
            local nextBlockedSignature="$next:$active:$workerCap"
            if [[ "$nextBlockedSignature" != "$blockedSignature" ]]; then
                blockedSignature="$nextBlockedSignature"
                printf '%s\t%s\t%s\t%s\n' "$(date +%s%3N)" "$next" "$active" "$workerCap" >>"$statusDir/blocked.tsv"
            fi
        fi
        local progressed=0
        local index
        for ((index = 0; index < next; index += 1)); do
            if [[ "${observed[$index]:-0}" == "1" || ! -f "${statusFiles[$index]}" ]]; then
                continue
            fi
            wait "${childPids[$index]}" >/dev/null 2>&1 || true
            observed[index]=1
            active=$((active - 1))
            completed=$((completed + 1))
            progressed=1
        done
        if ((completed < total && progressed == 0)); then
            sleep 0.1
        fi
    done
    trap - RETURN INT TERM

    local index
    local groupFailed=0
    for ((index = 0; index < total; index += 1)); do
        local childStatus
        if [[ -f "${statusFiles[$index]}" ]]; then
            IFS=$'\t' read -r childStatus _ <"${statusFiles[$index]}"
        else
            childStatus=125
        fi
        if [[ "$childStatus" != "0" ]]; then
            groupFailed=1
            LANE_FAILURES+=("${labels[$index]} (exit ${childStatus})")
        fi
    done
    local finalStatus='success'
    if ((groupFailed == 1)); then finalStatus='failure'; fi
    WriteCollectLiveGrantEvidence "$group" "$statusDir" "$finalStatus"
    rm -rf "$statusDir"
    Log "collect group done: $group"
    return 0
}

FinishCollect() {
    if ((${#LANE_FAILURES[@]} == 0)); then
        return 0
    fi
    printf '[lane] %d command(s) failed:\n' "${#LANE_FAILURES[@]}" >&2
    printf '  - %s\n' "${LANE_FAILURES[@]}" >&2
    return 1
}
