#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
dotnet_bin="${DOTNET_BIN:-dotnet}"
migrate="${FSUSBLOG_MIGRATE_DLL:-$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}"
# An invalid target must never be parsed or opened by a retired command.
for command in passkey admin; do
    if output="$(FSUSBLOG_DB=invalid-never-connect "$dotnet_bin" "$migrate" legacy "$command" plan 2>&1)"; then
        echo "Retired $command unexpectedly succeeded." >&2
        exit 1
    else
        [[ $? == 1 ]]
    fi
    [[ "$output" == 'Legacy credential and administrator copying is retired. Use native V2 enrollment and account creation.' ]]
done
help="$("$dotnet_bin" "$migrate" --help)"
[[ "$help" == *'legacy identity PROVIDER'* ]]
[[ "$help" != *'legacy passkey'* && "$help" != *'legacy admin'* ]]
printf 'Retired credential/admin copying rejects before target access; identity inventory remains.\n'
