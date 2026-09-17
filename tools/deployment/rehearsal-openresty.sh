#!/usr/bin/env bash
set -euo pipefail

container="${FSUSBLOG_REHEARSAL_OPENRESTY_CONTAINER:-fsusblog-zdt-openresty}"
case "${1:-}" in
    -t)
        [[ "${2:-}" == "-c" && -n "${3:-}" && $# -eq 3 ]] || {
            echo "rehearsal-openresty: expected -t -c <config>" >&2
            exit 2
        }
        exec docker exec "$container" openresty -t -c "$3"
        ;;
    -s)
        [[ "${2:-}" == "reload" && "${3:-}" == "-c" && -n "${4:-}" && $# -eq 4 ]] || {
            echo "rehearsal-openresty: expected -s reload -c <config>" >&2
            exit 2
        }
        exec docker exec "$container" openresty -s reload -c "$4"
        ;;
    *)
        echo "rehearsal-openresty: only config test and graceful reload are allowed" >&2
        exit 2
        ;;
esac
