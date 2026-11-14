#!/usr/bin/env bash
set -euo pipefail

destination="${1:?Pass output path for the Wasm module}"
case "$destination" in
    /*) ;;
    *) destination="$PWD/$destination" ;;
esac

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
object="$(mktemp "${TMPDIR:-/tmp}/fsusv2-wasm.XXXXXX")"
trap 'unlink "$object"' EXIT

"${FSUS_WASM_CXX:-clang++}" --target=wasm32-unknown-unknown -std=c++20 -O3 \
    -ffreestanding -fno-exceptions -fno-rtti -Wall -Wextra -Werror \
    -c src/ProtocolWasm/aeds-wasm.cpp -o "$object"
"${FSUS_WASM_LD:-wasm-ld}" --no-entry --export-memory --strip-all \
    --export=fsus_aeds_buffer --export=fsus_aeds_validate "$object" -o "$destination"
