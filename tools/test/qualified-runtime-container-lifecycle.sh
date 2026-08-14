#!/usr/bin/env bash

RemoveOwnedContainer() {
    local containerId="$1"
    [[ -n "$containerId" ]] || return 0
    if ! docker inspect "$containerId" >/dev/null 2>&1; then
        return 0
    fi
    local binding
    binding="$(docker inspect --format '{{.Id}}|{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$containerId")"
    [[ "$binding" == "$containerId|$run_id|$namespace" ]] || return 1
    docker rm -f -v "$containerId" >/dev/null
}
StopOwnedBackendGracefully() {
    local containerId="$1"
    local graceSeconds="$2"
    local observationFile="$3"
    [[ "$containerId" =~ ^[0-9a-f]{64}$ ]] || {
        printf '%s\n' 'graceful backend shutdown requires one concrete container ID' >&2
        return 1
    }
    [[ "$graceSeconds" =~ ^[1-9][0-9]*$ && "$graceSeconds" -le 300 ]] || {
        printf '%s\n' 'graceful backend shutdown requires a 1-300 second stop grace' >&2
        return 1
    }
    local binding
    binding="$(docker inspect --format '{{.Id}}|{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$containerId")" \
        || return 1
    [[ "$binding" == "$containerId|$run_id|$namespace" ]] || {
        printf '%s\n' 'graceful backend shutdown ownership does not match the qualified run' >&2
        return 1
    }

    local startedAtMs finishedAtMs elapsedMs state running oomKilled exitCode
    startedAtMs="$(node -e 'process.stdout.write(String(Date.now()))')"
    docker stop --time "$graceSeconds" "$containerId" >/dev/null
    finishedAtMs="$(node -e 'process.stdout.write(String(Date.now()))')"
    elapsedMs=$((finishedAtMs - startedAtMs))
    state="$(docker inspect --format '{{.State.Running}}|{{.State.OOMKilled}}|{{.State.ExitCode}}' "$containerId")" \
        || return 1
    IFS='|' read -r running oomKilled exitCode <<<"$state"
    [[ "$running" == "false" && "$oomKilled" == "false" && "$exitCode" == "0" \
        && "$elapsedMs" -lt $((graceSeconds * 1000)) ]] || {
        printf '[runtime-admission] backend did not stop cleanly within grace: state=%s elapsedMs=%s graceSeconds=%s\n' \
            "$state" "$elapsedMs" "$graceSeconds" >&2
        return 1
    }

    mkdir -p -- "$(dirname "$observationFile")"
    node - "$observationFile" "$source_commit" "$image" "$containerId" \
        "$graceSeconds" "$elapsedMs" "$exitCode" <<'NODE'
const fs = require('node:fs');
const [file, sourceCommit, imageReference, containerId, grace, elapsed, exitCode] =
    process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
    schema: 'fsusblog.production-image.graceful-shutdown.v1',
    sourceCommit,
    imageReference,
    containerId,
    signal: 'SIGTERM',
    graceSeconds: Number(grace),
    elapsedMilliseconds: Number(elapsed),
    exitCode: Number(exitCode),
    oomKilled: false,
    stoppedAt: new Date().toISOString()
}, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
NODE
    printf '[runtime-admission] backend stopped cleanly after SIGTERM in %sms (grace=%ss)\n' \
        "$elapsedMs" "$graceSeconds"
}
RemoveOwnedNetwork() {
    local networkId="$1"
    [[ -n "$networkId" ]] || return 0
    if ! docker network inspect "$networkId" >/dev/null 2>&1; then
        return 0
    fi
    local binding
    binding="$(docker network inspect --format '{{.Id}}|{{index .Labels "io.fsusblog.test.run-id"}}|{{index .Labels "io.fsusblog.test.namespace"}}' "$networkId")"
    [[ "$binding" == "$networkId|$run_id|$namespace" ]] || return 1
    docker network rm "$networkId" >/dev/null
}
RecordBackendCrashDiagnosticStatus() {
    local diagnosticDirectory="$1"
    local message="$2"
    printf '%s\n' "$message" >> "$diagnosticDirectory/collection-status.txt"
}
CopySmallBackendCrashDiagnostic() {
    local containerId="$1"
    local containerPath="$2"
    local destination="$3"
    local diagnosticDirectory="$4"
    local temporaryDestination="${destination}.partial"
    rm -f -- "$temporaryDestination"
    if ! docker cp "${containerId}:${containerPath}" "$temporaryDestination" >/dev/null 2>&1; then
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "not available: $containerPath"
        return 0
    fi
    if [[ ! -f "$temporaryDestination" ]]; then
        rm -f -- "$temporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "rejected non-file diagnostic: $containerPath"
        return 0
    fi
    local bytes
    bytes="$(wc -c < "$temporaryDestination")"
    if [[ ! "$bytes" =~ ^[0-9]+$ ]] || ((bytes > 1048576)); then
        rm -f -- "$temporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "rejected oversized diagnostic: $containerPath"
        return 0
    fi
    mv -- "$temporaryDestination" "$destination"
    RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "captured: $containerPath"
}
CaptureOwnedBackendCrashDiagnostics() {
    local containerId="$1"
    [[ "$containerId" =~ ^[0-9a-f]{64}$ ]] || return 0
    docker inspect "$containerId" >/dev/null 2>&1 || return 0
    local binding
    binding="$(docker inspect --format '{{.Id}}|{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$containerId")" \
        || return 1
    [[ "$binding" == "$containerId|$run_id|$namespace" ]] || return 1
    local state exitCode
    state="$(docker inspect --format '{{json .State}}' "$containerId")" || return 1
    exitCode="$(docker inspect --format '{{.State.ExitCode}}' "$containerId")" || return 1
    [[ "$exitCode" != "0" ]] || return 0
    local diagnosticDirectory="$root/.tmp/release-reliability/${run_id}/crash-diagnostics"
    umask 077
    mkdir -p -- "$diagnosticDirectory" || return 1
    chmod 700 -- "$diagnosticDirectory" || return 1
    printf '%s\n' "$state" > "$diagnosticDirectory/container-state.json" \
        || { RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'failed to write container state'; return 0; }
    local logDestination="$diagnosticDirectory/container-logs-tail.txt"
    local logTemporaryDestination="${logDestination}.partial"
    local logBytes
    if docker logs --tail 200 "$containerId" > "$logTemporaryDestination" 2>/dev/null; then
        logBytes="$(wc -c < "$logTemporaryDestination")"
        if [[ "$logBytes" =~ ^[0-9]+$ ]] && ((logBytes <= 1048576)); then
            mv -- "$logTemporaryDestination" "$logDestination"
            RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'captured: docker logs tail'
        else
            rm -f -- "$logTemporaryDestination"
            RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'rejected oversized docker logs tail'
        fi
    else
        rm -f -- "$logTemporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'failed to collect docker logs tail'
    fi
    CopySmallBackendCrashDiagnostic "$containerId" /app/runtime-cache/coredump.1.crashreport.json \
        "$diagnosticDirectory/crashreport.json" "$diagnosticDirectory"
    CopySmallBackendCrashDiagnostic "$containerId" /app/runtime-cache/createdump.log \
        "$diagnosticDirectory/createdump.log" "$diagnosticDirectory"
}
