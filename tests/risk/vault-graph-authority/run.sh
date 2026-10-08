#!/usr/bin/env bash
set -euo pipefail

qaDirectory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
qaRepository=$(git -C "$qaDirectory" rev-parse --show-toplevel)
qaOutput=${1:?usage: run.sh /absolute/empty/output-directory}
if [[ "$qaOutput" != /* || -e "$qaOutput" ]]; then
    printf '%s\n' 'Output must be an absolute path that does not already exist.' >&2
    exit 2
fi
mkdir -p -- "$qaOutput"

qaEarly=80a2736711edff3a711ec854d55c65433a127a5f
qaStrict=00eeaf705dcc03a5412b36002df0b166e7442f3a
qaLink=bc05768dc1e2b6dc7495889295f2e86273855ec0
qaCurrentLink=7117889cec02509f14099f28477f673a8cf5795b
git -C "$qaRepository" fetch origin "$qaEarly" "$qaStrict" "$qaLink" "$qaCurrentLink"
git -C "$qaRepository" worktree add --detach "$qaOutput/early" "$qaEarly"
git -C "$qaRepository" worktree add --detach "$qaOutput/strict" "$qaStrict"
git -C "$qaRepository" worktree add --detach "$qaOutput/link" "$qaLink"
git -C "$qaRepository" worktree add --detach "$qaOutput/current-link" "$qaCurrentLink"

qaFailed=0
runDiagnostic()
{
    local qaName=$1
    shift
    local qaExit=0
    if "$@" > "$qaOutput/$qaName.log" 2>&1; then
        qaExit=0
    else
        qaExit=$?
        qaFailed=1
    fi
    printf '%s\n' "$qaExit" > "$qaOutput/$qaName.exit"
    printf '%s: exit %s\n' "$qaName" "$qaExit"
}

runDiagnostic graph dotnet run --project "$qaDirectory/VaultGraphAuthorityRisk.csproj" -c Release \
    -p:GraphSource="$qaOutput/strict"
runDiagnostic strict-composition dotnet build "$qaDirectory/VaultGraphAuthorityRisk.csproj" -c Release \
    -p:GraphSource="$qaOutput/strict" -p:LinkSource="$qaOutput/link" \
    -p:Compose=true -p:ProbeCompatibility=true
runDiagnostic compatible-composite dotnet run --project "$qaDirectory/VaultGraphAuthorityRisk.csproj" -c Release \
    -p:GraphSource="$qaOutput/early" -p:LinkSource="$qaOutput/link" -p:Compose=true -p:StrictApi=false
runDiagnostic current-composition dotnet build "$qaDirectory/VaultGraphAuthorityRisk.csproj" -c Release \
    -p:GraphSource="$qaOutput/strict" -p:LinkSource="$qaOutput/current-link" \
    -p:Compose=true -p:ProbeCompatibility=true
runDiagnostic current-composite dotnet run --project "$qaDirectory/VaultGraphAuthorityRisk.csproj" -c Release \
    -p:GraphSource="$qaOutput/strict" -p:LinkSource="$qaOutput/current-link" -p:Compose=true

printf 'Diagnostic logs: %s\n' "$qaOutput"
exit "$qaFailed"
