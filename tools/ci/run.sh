#!/usr/bin/env bash
# One entry point shared by Actions and locally provisioned environments.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
root=$PWD
reports=${CI_REPORTS:-$root/artifacts/ci/reports}
mkdir -p "$reports"
dotnet=${DOTNET_BIN:-dotnet}
trx() {
  local project=$1 name=$2 profile=$3
  rm -f -- "$reports/$name.trx" "$reports/$name.summary.json"
  "$dotnet" test "$project" -c Release --no-build --no-restore \
    --logger "trx;LogFileName=$name.trx" --results-directory "$reports"
  python3 -B tools/ci/checks.py trx "$reports/$name.trx" --profile "$profile"
}
case "${1:-}" in
  source)
    python3 -B tools/check-docs.py
    python3 -B -m unittest discover -s tests/CI -p '*_test.py' -v
    while IFS= read -r -d '' file; do bash -n "$file"; done < <(find tools tests deploy -type f -name '*.sh' -print0)
    node tools/protocol-generate.mjs --check
    node --test tests/Admin/*.test.ts tests/Authoring/*.test.ts tests/Protocol/*.test.ts tests/Protocol/*.test.mjs
    for file in tests/Protocol/*.test.py; do python3 -B "$file"; done
    python3 -B -m unittest discover -s tests/Performance -p '*_test.py' -v
    GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -race \
      tests/Performance/load.go tests/Performance/cold.go tests/Performance/load_test.go
    ;;
  backend)
    expected=$(python3 -c 'import json; print(json.load(open("global.json"))["sdk"]["version"])')
    [[ $("$dotnet" --version) == "$expected" ]] || { echo 'SDK differs from global.json.' >&2; exit 2; }
    "$dotnet" restore FsusBlog.V2.slnx --configfile NuGet.Config --locked-mode -p:NuGetAudit=false
    "$dotnet" build FsusBlog.V2.slnx -c Release --no-restore -warnaserror
    trx tests/Core/FsusBlog.V2.Core.Tests.csproj core unit
    trx tests/Platform/FsusBlog.V2.Platform.Tests.csproj platform unit
    FSUS_DOTNET="$dotnet" bash tools/protocol-test.sh
    ;;
  integration)
    : "${FSUSBLOG_TEST_DB:?Use tools/ci/with-postgres.sh}"
    : "${FSUSBLOG_TEST_CADDY_BIN:?Native Caddy is mandatory}"
    [[ -x "$FSUSBLOG_TEST_CADDY_BIN" ]]
    export FSUSBLOG_TEST_CLI_DLL="$root/src/Cli/bin/Release/net10.0/FsusBlog.V2.Cli.dll"
    [[ -s "$FSUSBLOG_TEST_CLI_DLL" ]]
    trx tests/Integration/FsusBlog.V2.Integration.Tests.csproj integration integration
    bash tests/Integration/Migration/verify.sh
    ;;
  browser)
    [[ -x "${FSUSBLOG_TEST_CHROME:?A real Chromium executable is mandatory}" ]]
    export FSUSBLOG_TEST_REQUIRE_NATIVE=1
    export FSUSBLOG_NATIVE_SERVER_BUILD="$root/src/Server/bin/Release/net10.0"
    export FSUSBLOG_NATIVE_CLI_BUILD="$root/src/Cli/bin/Release/net10.0"
    export FSUSBLOG_WEB_DIST="$root/src/Web/dist"
    # Each runner owns its fixture; never run these flows concurrently in a DB.
    FSUSBLOG_TEST_EVIDENCE="$root/artifacts/ci/browser/blog" bash tests/EndToEnd/run-native.sh
    FSUSBLOG_TEST_EVIDENCE="$root/artifacts/ci/browser/admin-tls" bash tests/EndToEnd/run-admin-tls.sh
    FSUSBLOG_TEST_EVIDENCE="$root/artifacts/ci/browser/inbox-tls" FSUSBLOG_TEST_INBOX_TLS=1 bash tests/EndToEnd/run-inbox-native.sh
    if [[ ${CI_EXTENDED:-false} == true ]]; then
      for flow in private-media public-article-media workspace-recovery canvas-keyboard; do
        FSUSBLOG_TEST_FLOW="$flow" FSUSBLOG_TEST_EVIDENCE="$root/artifacts/ci/browser/$flow" bash tests/EndToEnd/run-native.sh
      done
    fi
    # Copy only run receipts, not certificates, bootstrap tickets, or browser storage.
    for receipt in "$root"/artifacts/ci/browser/*/run.txt; do
      name=$(basename "$(dirname "$receipt")")
      cp "$receipt" "$reports/browser-$name.txt"
    done
    ;;
  *) echo 'Usage: tools/ci/run.sh {source|backend|integration|browser}' >&2; exit 2 ;;
esac
