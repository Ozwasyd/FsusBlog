#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

SLOT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            [[ $# -ge 2 ]] || SlotFail "--slot requires a value"
            SLOT="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || SlotFail "--state-file requires a value"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

SlotRequire "$SLOT"
SlotRequireCommand curl
SlotRequireCommand docker
SlotRequireCommand jq
SlotRequireCommand node
SlotConfigure "$SLOT"

persisted="$(SlotStateRead --slot "$SLOT")"
if ! raw="$(docker inspect "$FSUSBLOG_CONTAINER_NAME" 2>/dev/null)"; then
    jq -cn \
        --arg slot "$SLOT" \
        --arg containerName "$FSUSBLOG_CONTAINER_NAME" \
        --arg projectName "$FSUSBLOG_COMPOSE_PROJECT_NAME" \
        --argjson port "$FSUSBLOG_SLOT_PORT" \
        --argjson persisted "$persisted" \
        '{slot: $slot, exists: false, running: false, health: "missing", liveness: "not-running", readiness: "not-running", containerName: $containerName, projectName: $projectName, host: "127.0.0.1", port: $port, loopbackOnly: true, release: null, startedAt: null, persisted: $persisted}'
    exit 0
fi

runtime="$(jq -c \
    --arg slot "$SLOT" \
    --arg containerName "$FSUSBLOG_CONTAINER_NAME" \
    --arg projectName "$FSUSBLOG_COMPOSE_PROJECT_NAME" \
    --argjson expectedPort "$FSUSBLOG_SLOT_PORT" '
  .[0] as $container
  | ($container.NetworkSettings.Ports["8080/tcp"] // []) as $bindings
  | {
      slot: $slot,
      exists: true,
      running: ($container.State.Running == true),
      health: ($container.State.Health.Status // (if $container.State.Running then "running-no-health" else "stopped" end)),
      containerName: ($container.Name | ltrimstr("/")),
      projectName: ($container.Config.Labels["io.fsusblog.deployment.project"] // ""),
      host: "127.0.0.1",
      port: $expectedPort,
      portBindings: $bindings,
      loopbackOnly: (($bindings | length) == 1 and $bindings[0].HostIp == "127.0.0.1" and ($bindings[0].HostPort | tonumber) == $expectedPort),
      release: {
        slot: ($container.Config.Labels["io.fsusblog.release.slot"] // ""),
        releaseId: ($container.Config.Labels["io.fsusblog.release.id"] // ""),
        commitSha: ($container.Config.Labels["io.fsusblog.release.commit"] // ""),
        imageRef: ($container.Config.Labels["io.fsusblog.release.image-ref"] // ""),
        imageDigest: ($container.Config.Labels["io.fsusblog.release.image-digest"] // ""),
        deploymentMode: ($container.Config.Labels["io.fsusblog.deployment.mode"] // ""),
        deploymentGeneration: (($container.Config.Labels["io.fsusblog.deployment.generation"] // "0") | tonumber? // 0)
      },
      startedAt: ($container.State.StartedAt // null),
      identityMatchesSlot: (($container.Name | ltrimstr("/")) == $containerName and ($container.Config.Labels["io.fsusblog.deployment.project"] // "") == $projectName and ($container.Config.Labels["io.fsusblog.release.slot"] // "") == $slot)
    }' <<<"$raw")"

liveness="not-running"
readiness="not-running"
if [[ "$(jq -r '.running' <<<"$runtime")" == "true" ]]; then
    if curl -fsS --max-time 5 "http://127.0.0.1:$FSUSBLOG_SLOT_PORT/health/live" >/dev/null; then
        liveness="ok"
    else
        liveness="failed"
    fi
    if curl -fsS --max-time 5 "http://127.0.0.1:$FSUSBLOG_SLOT_PORT/health/ready" >/dev/null; then
        readiness="ok"
    else
        readiness="failed"
    fi
fi

jq -cn \
    --argjson runtime "$runtime" \
    --argjson persisted "$persisted" \
    --arg liveness "$liveness" \
    --arg readiness "$readiness" \
    '$runtime + {liveness: $liveness, readiness: $readiness, persisted: $persisted}'
