#!/usr/bin/env bash
set -euo pipefail

scriptDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repositoryRoot="$(cd -- "${scriptDir}/.." && pwd)"
checker="${repositoryRoot}/tools/style/check-native-tooling-style.mjs"

mode="changed"
domain="all"
writeMode="--write"
arguments=()

while (($# > 0)); do
    case "$1" in
        --check)
            writeMode=""
            ;;
        --changed)
            mode="changed"
            ;;
        --full)
            mode="full"
            ;;
        --domain)
            domain="${2:?--domain requires a value}"
            shift
            ;;
        --base|--file|--root|--policy)
            arguments+=("$1" "${2:?$1 requires a value}")
            shift
            ;;
        --require-tools)
            arguments+=("$1")
            ;;
        *)
            printf 'Unknown format option: %s\n' "$1" >&2
            exit 2
            ;;
    esac
    shift
done

command=(node "$checker" --operation format --mode "$mode" --domain "$domain")
if [[ -n "$writeMode" ]]; then
    command+=("$writeMode")
fi
command+=("${arguments[@]}")
exec "${command[@]}"
