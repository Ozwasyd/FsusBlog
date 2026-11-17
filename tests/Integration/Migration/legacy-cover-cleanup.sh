# Shared owned-cluster cleanup; optional callback preserves runner-specific evidence.
cleanup() {
    local status=$? scratch=$1 lane
    shift
    for lane in source target; do
        if [[ -f "$scratch/$lane/postmaster.pid" ]]; then pg_ctl -D "$scratch/$lane" -m fast -w stop >/dev/null || status=1; fi
    done
    local evidence="$scratch-evidence"
    mkdir -m 700 "$evidence"
    find "$scratch" -maxdepth 1 -type f \( -name '*.json' -o -name '*.err' -o -name '*.out' -o -name '*.log' \) -exec cp {} "$evidence/" \;
    if (( $# )); then "$1" "$scratch" "$evidence"; fi
    if [[ "$status" == 0 ]]; then
        find "$scratch" -type d -exec chmod u+w {} +
        find "$scratch" -depth -delete || status=1
    fi
    printf 'Cover proof exit=%s; owned clusters stopped; evidence=%s\n' "$status" "$evidence"
    exit "$status"
}
