#!/usr/bin/env bash
set -euo pipefail

prototype_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_directory="$(cd -- "$prototype_directory/../.." && pwd)"
cd -- "$repository_directory"
sha256sum --check "$prototype_directory/canonical-sources.sha256.txt" >&2
cd -- "$prototype_directory"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_NOLOGO=1
export DOTNET_CLI_HOME="$prototype_directory/.artifacts/cli-home"
export NUGET_PACKAGES="$prototype_directory/.artifacts/packages"
dotnet test controls/CanonicalControls.csproj --configuration Release --logger 'trx;LogFileName=canonical-controls.trx' --results-directory .artifacts/control-results --verbosity minimal
