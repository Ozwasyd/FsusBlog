#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${FSUSBLOG_FAULT_EVIDENCE_DIR:-$ROOT_DIR/.tmp/fault-injection}"
mkdir -p "$OUT_DIR"

# Fault recovery may restart the managed backend, so bind it to the exact
# bootstrap runtime mode and make Debug consume the shared backend producer.
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"
RequireBootstrappedNamespace
runtime_configuration="${FSUSBLOG_RUNTIME_CONFIGURATION:-Debug}"
case "$runtime_configuration" in
    Debug)
        FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild
        ;;
    Release)
        if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" != "1" ]]; then
            Fail 'fault injection cannot restart an unprepared Release backend'
        fi
        ;;
    *)
        Fail "unsupported managed backend runtime configuration: $runtime_configuration"
        ;;
esac
export FSUSBLOG_RUNTIME_CONFIGURATION="$runtime_configuration"
export FSUSBLOG_RUNTIME_NO_BUILD=1

set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" fault-injection "$OUT_DIR"
probe_status=$?
set -e

summary_status="$(
    "${FSUSBLOG_NODE:-node}" -e "const fs=require('node:fs'); const file=process.argv[1]; if (!fs.existsSync(file)) process.exit(2); const summary=JSON.parse(fs.readFileSync(file,'utf8')); process.stdout.write(String(summary.status || 'missing'))" \
        "$OUT_DIR/summary.json"
)"

if [[ "$summary_status" != "ok" ]]; then
    printf '[fault-injection] summary status is %s; failing lane\n' "$summary_status" >&2
    exit 1
fi

if [[ "$probe_status" -ne 0 ]]; then
    printf '[fault-injection] probe exited %s despite ok summary\n' "$probe_status" >&2
    exit "$probe_status"
fi

printf '[fault-injection] wrote %s\n' "$OUT_DIR/summary.json"
