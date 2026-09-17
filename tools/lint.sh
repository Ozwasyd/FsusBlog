#!/usr/bin/env bash
set -euo pipefail

scriptDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repositoryRoot="$(cd -- "${scriptDir}/.." && pwd)"
checker="${repositoryRoot}/tools/style/check-native-tooling-style.mjs"

if (($# == 0)); then
    printf 'Usage: %s <native|scripts|docs> [--changed|--full] [--base REF] [--file PATH]\n' "$0" >&2
    exit 2
fi

domain="$1"
shift
case "$domain" in
    native | scripts | docs) ;;
    *)
        printf 'Unknown lint domain: %s\n' "$domain" >&2
        exit 2
        ;;
esac

mode="changed"
arguments=()
while (($# > 0)); do
    case "$1" in
        --changed)
            mode="changed"
            ;;
        --full)
            mode="full"
            ;;
        --base | --file | --root | --policy)
            arguments+=("$1" "${2:?$1 requires a value}")
            shift
            ;;
        --require-tools)
            arguments+=("$1")
            ;;
        *)
            printf 'Unknown lint option: %s\n' "$1" >&2
            exit 2
            ;;
    esac
    shift
done

exec node "$checker" --operation lint --mode "$mode" --domain "$domain" "${arguments[@]}"
