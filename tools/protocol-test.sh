#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
work="$(mktemp -d "${TMPDIR:-/tmp}/fsusv2-protocol.XXXXXX")"
cleanup() {
    for owned in "$work/frame-contract" "$work/aeds.wasm"; do
        if [[ -f "$owned" ]]; then unlink "$owned"; fi
    done
    rmdir "$work"
}
trap cleanup EXIT

node tools/protocol-generate.mjs --check
node --test tests/Protocol/*.test.ts

project=tests/Protocol/FsusBlog.V2.ProtocolTests.csproj
"${FSUS_DOTNET:-dotnet}" restore "$project" --locked-mode
"${FSUS_DOTNET:-dotnet}" run --project "$project" --no-restore -- tests/Protocol/fixtures

"${CXX:-c++}" -std=c++20 -pedantic -Wall -Wextra -Werror -Isrc/ProtocolWasm \
    tests/Protocol/frame-contract.cpp -o "$work/frame-contract"
"$work/frame-contract" tests/Protocol/fixtures/api-error-v1.hex tests/Protocol/fixtures/article-command.hex
echo 'AEDS native C++ frame checks passed'

tools/protocol-wasm.sh "$work/aeds.wasm"
node tests/Protocol/wasm-contract.mjs "$work/aeds.wasm"
