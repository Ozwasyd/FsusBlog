if [[ -z "${FSUSBLOG_TEMPORAL_HANDSHAKE_OWNER_PID:-}" ]]; then
    export FSUSBLOG_TEMPORAL_HANDSHAKE_OWNER_PID="${BASHPID:-$$}"

    FsusBlogTemporalExitHandshake() {
        local child_status=$?
        "${FSUSBLOG_NODE:-node}" \
            "$FSUSBLOG_TEMPORAL_HANDSHAKE_EMITTER" || return 97
        return "$child_status"
    }

    trap FsusBlogTemporalExitHandshake EXIT
fi
