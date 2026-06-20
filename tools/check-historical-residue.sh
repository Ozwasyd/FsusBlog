#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${FSUSBLOG_HISTORICAL_RESIDUE_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

run_residue_check() {
  local description="$1"
  local failure_message="$2"
  local pattern="$3"
  local allow_path_regex="$4"
  shift 4

  local paths=()
  local candidate
  for candidate in "$@"; do
    if [[ -e "$candidate" ]]; then
      paths+=("$candidate")
    fi
  done

  echo "[residue-check] verifying ${description}..."
  if [[ "${#paths[@]}" -eq 0 ]]; then
    return
  fi

  local output
  local status
  set +e
  output="$(
    rg -n --pcre2 \
      --glob '!**/node_modules/**' \
      --glob '!**/dist/**' \
      --glob '!**/build*/**' \
      --glob '!**/.artifacts/**' \
      --glob '!tests/frontend/checks/static/check-historical-residue-fixture.mjs' \
      "$pattern" "${paths[@]}" 2>&1
  )"
  status=$?
  set -e

  if [[ "$status" -eq 1 ]]; then
    return
  fi
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$output"
    exit "$status"
  fi

  if [[ -n "$allow_path_regex" ]]; then
    output="$(printf '%s\n' "$output" | awk -F: -v allow="$allow_path_regex" '$1 !~ allow')"
  fi

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
    echo "[residue-check] ${failure_message}"
    exit 1
  fi
}

run_residue_check \
  "legacy gateway markers" \
  "legacy gateway residue detected" \
  '\b(?:I[A-Za-z]*Legacy[A-Za-z]*Gateway|Legacy[A-Za-z]+Gateway)\b' \
  "" \
  src/core src/backend src/frontend src/shared

run_residue_check \
  "obsolete AOT shell builder names" \
  "obsolete AOT shell builder names detected" \
  'BuildHomeShell|BuildArticleDetailShell|BuildFilterShell|BuildAboutShell|BuildArchiveShell' \
  "" \
  src/backend/Infrastructure/PublicAot/PublicAotShellService.cs

run_residue_check \
  "old dto aliases" \
  "old dto alias residue detected" \
  '\b(ArticleListDto|ArticleDetailDto|CategoryDto|PageResultDto|CursorResult|SeoConfigDto|PageContentDto|UserCommentDto|ArticleDto|SearchDto|ArticleQueryRequestDto)\b' \
  "" \
  src/backend src/shared src/frontend

run_residue_check \
  "legacy runtime bridge names" \
  "legacy runtime bridge residue detected" \
  '\bBridgeToLegacy(?:Authoring|Security)EndpointAsync\b|(?:authoring|security)_legacy_envelope|/_fsus/internal/binary-bridge/(?:author|admin/security)|\bBinaryBridgeInternalRequest\.(?:AuthoringPrefix|SecurityPrefix)\b' \
  '^(src/backend/Infrastructure/Middlewares/(Authoring|Security)BinaryBridgeMiddleware[.]cs|src/backend/Infrastructure/Filters/BinaryBridgeInternalOnlyFilter[.]cs|src/backend/Modules/Endpoints/(Authoring|Security)Endpoints[.]cs|src/shared/Contracts/Validation/fsusblog[.]openapi[.]json|tools/contracts/aeds-only-policy[.]allowlist[.]json|docs/api/(aeds-only-policy|contracts|design|quick-reference)[.]md|tests/frontend/checks/static/check-public-private-data-leakage[.]mjs)$' \
  src/backend src/shared tools/contracts docs/api tests/frontend

run_residue_check \
  "old comment-create V1 paths" \
  "old comment-create V1 residue detected" \
  '\bcreateCommentV1\b|\bCommentCreateRequest\b|\b(?:AedsFrameType|FrameType)\.CommentCreateRequest\b|["'\'']/api/Comment(?:["'\''/?]|$)' \
  "" \
  src/backend src/shared src/frontend/src

run_residue_check \
  "old author-mode aliases" \
  "old author-mode alias residue detected" \
  '\b(?:authorMode|defaultAuthorMode|DefaultAuthorMode|AuthorMode)\b\s*[:=]\s*["'\''](?:guest|incognito|legacy|legacy_anonymous|anonymous_legacy|anon|authenticated|account|real_name|real-name)["'\'']' \
  "" \
  src/backend src/shared src/frontend/src tests/frontend/fixtures

run_residue_check \
  "old UI fixture fallbacks" \
  "old UI fixture fallback residue detected" \
  '\blegacy-ui-fixture-fallback\b|\bFsusUiFallbackFixtures\b|\buiFixtureFallback\b|\bFSUSBLOG_(?:USE_)?UI_FIXTURE_FALLBACK\b|\bfixtureFallback\b' \
  "" \
  src/frontend/src tests/frontend/fixtures tests/frontend/checks

run_residue_check \
  "old local package type shims" \
  "old local package type shim residue detected" \
  '\bLocalPackageTypeShim\b|\bfsusui-local-shim\b|declare\s+module\s+["'\'']@ozwasyd/element-plus["'\'']' \
  '^src/frontend/src/fsusui/elementPlusAugmentations\.d\.ts$' \
  src/frontend/src tests/frontend

run_residue_check \
  "old algorithm fallback switches" \
  "old algorithm fallback switch residue detected" \
  '\bLegacyModernAcAutomaton\b|\bUseLegacyChildRangeAutomaton\b|\bFSUSBLOG_SECURITY_MODERN_AC_USE_LEGACY_CHILD_RANGE\b|FsusBlog\.Security\.ModernAcAutomaton\.UseLegacyChildRange|\b_legacyFallback\b' \
  "" \
  src/backend/Infrastructure/Helpers/Security tests/backend

echo "[residue-check] passed"
