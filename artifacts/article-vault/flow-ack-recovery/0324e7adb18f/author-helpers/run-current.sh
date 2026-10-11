#!/bin/bash
set -eu
export PATH=/workspace/chain-1975-evidence/provider-caller-cancellation/node-runtime/node-v24.16.0-linux-x64/bin:$PATH
export FSUSBLOG_USE_LOCAL_FSUSUI=1
export FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/chain1975-runtime-borrow-fsusui
export FSUSBLOG_VITEST_MAX_WORKERS=1
label="$1"
shift
export FSUSBLOG_RUN_ID="chain1975-flow-ack-${label}-20261011"
export FSUSBLOG_RUN_OUTPUT_ROOT="/workspace/chain-1975-evidence/flow-ack-recovery-20261011/${label}-run"
mkdir -p "$FSUSBLOG_RUN_OUTPUT_ROOT"
export FSUSBLOG_VITEST_RUNTIME_TOPOLOGY_EVIDENCE="$FSUSBLOG_RUN_OUTPUT_ROOT/topology.jsonl"
exec python3 /workspace/chain-1975-evidence/flow-ack-recovery-20261011/run-record.py "$label" "$@"
