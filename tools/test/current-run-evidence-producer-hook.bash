#!/usr/bin/env bash

if [[ -n "${FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-}" ]]; then
    unset BASH_ENV
    fsusblog_evidence_session="$(node tools/test/run-current-run-evidence-producer.mjs begin)" || exit 1
    FsusblogFinalizeCurrentRunEvidence() {
        local producerStatus="$?"
        trap - EXIT
        if [[ "$producerStatus" -eq 0 ]]; then
            node tools/test/run-current-run-evidence-producer.mjs finalize "$fsusblog_evidence_session" || producerStatus="$?"
        fi
        exit "$producerStatus"
    }
    trap FsusblogFinalizeCurrentRunEvidence EXIT
fi
