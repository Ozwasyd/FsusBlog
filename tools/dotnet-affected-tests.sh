#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"
BASE_REF="${FSUSBLOG_BASE_REF:-origin/main}"

Log() {
    printf '[dotnet:affected] %s\n' "$1"
}

ResolveBase() {
    if git -C "$ROOT_DIR" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
        git -C "$ROOT_DIR" merge-base "$BASE_REF" HEAD
        return
    fi

    git -C "$ROOT_DIR" rev-parse HEAD
}

CollectChangedFiles() {
    local base="$1"
    {
        git -C "$ROOT_DIR" diff --name-only "$base"...HEAD
        git -C "$ROOT_DIR" diff --name-only
        git -C "$ROOT_DIR" diff --cached --name-only
    } | awk 'NF' | sort -u
}

base_ref="$(ResolveBase)"
Log "selection=affected base=$base_ref"
mapfile -t changed_files < <(CollectChangedFiles "$base_ref")

if ((${#changed_files[@]} == 0)); then
    Log "selection=affected effective=skip reason=no-changed-files"
    exit 0
fi

requires_full=0
auth_security_sensitive=0
for file in "${changed_files[@]}"; do
    case "$file" in
        src/backend/* | src/shared/* | src/core/* | tests/backend/* | *.sln | *.slnx | Directory.Build.props | Directory.Packages.props | global.json)
            requires_full=1
            ;;
    esac
    case "$file" in
        src/backend/Infrastructure/Auth/* | src/backend/Infrastructure/Filters/BannedUserMiddleware.cs | src/backend/Infrastructure/Helpers/JwtHelper.cs | src/backend/Infrastructure/Security/* | src/backend/Modules/Endpoints/Auth/* | src/shared/Contracts/Security/* | tests/backend/*Auth* | tests/backend/*Security*)
            auth_security_sensitive=1
            requires_full=1
            ;;
    esac
done

if ((requires_full == 0)); then
    Log "selection=affected effective=skip reason=non-backend-changes changed=${#changed_files[@]}"
    exit 0
fi

if ((auth_security_sensitive == 1)); then
    Log "selection=affected effective=full reason=auth-security-sensitive changed=${#changed_files[@]}"
else
    Log "selection=affected effective=full reason=backend-shared-core-or-tests changed=${#changed_files[@]}"
fi
ordinaryFilter="${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-Category!=Integration&Fixture!=LocalRedis}"
configuration="${FSUSBLOG_BACKEND_TEST_CONFIGURATION:-Debug}"
rm -f "$ROOT_DIR/.tmp/backend-unit/affected.trx" \
    "$ROOT_DIR/.tmp/backend-unit/local-redis-membership-outcome.json"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/perception-redis-producer.mjs" --ordinary-plan \
    --lane backend-unit-affected --filter "$ordinaryFilter" \
    --run-id "${FSUSBLOG_TEST_RUN_ID:-affected-$$}" \
    --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}" \
    --source-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-$(node --input-type=module -e 'const { snapshotGitWorktree } = await import(process.argv[1] + "/tools/test-matrix/scheduler.mjs"); process.stdout.write((await snapshotGitWorktree(process.argv[1])).fingerprint)' "$ROOT_DIR")}" \
    --output "$ROOT_DIR/.tmp/backend-unit/local-redis-membership-plan.json"
"$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c "$configuration" -v minimal --no-build --no-restore \
    --filter "$ordinaryFilter" \
    --logger "trx;LogFileName=$ROOT_DIR/.tmp/backend-unit/affected.trx"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/perception-redis-producer.mjs" --ordinary-outcome \
    --plan "$ROOT_DIR/.tmp/backend-unit/local-redis-membership-plan.json" \
    --trx "$ROOT_DIR/.tmp/backend-unit/affected.trx" \
    --output "$ROOT_DIR/.tmp/backend-unit/local-redis-membership-outcome.json"
