#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${FSUSBLOG_HISTORICAL_RESIDUE_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX='^(docs/(api/(design|contracts)[.]md|database-migration[.]md|anonymous-identity-smoke-flow[.]md)|src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation[.]cs|tools/db/.*|tests/(backend|frontend)/.*)$'

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
  '\bBridgeToLegacy(?:Authoring|Security)EndpointAsync\b|(?:authoring|security)_legacy_envelope|/_fsus/internal/binary[-]bridge/(?:author|admin/security)|\bBinaryBridgeInternalRequest\.(?:AuthoringPrefix|SecurityPrefix)\b' \
  '^(src/shared/Contracts/Validation/fsusblog[.]openapi[.]json|tests/frontend/fixtures/cross-stack-contract-matrix([.]generated)?[.]json)$' \
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

run_residue_check \
  "legacy anonymous account auth contracts" \
  "legacy anonymous account auth contract residue detected" \
  '\b(?:FrameType|AedsFrameType)\.Auth(?:Login|Register)Request\b|binaryUrl:\s*["'\'']/api/binary/auth/(?:login|register)["'\'']|group[.]MapPost[(]["'\'']/auth/(?:login|register)["'\'']|export\s+interface\s+(?:Login|Register)Dto\b|function\s+encodeAuth(?:Login|Register)Request\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/frontend/src src/backend/Modules/Endpoints/Binary docs tests/backend/Unit

run_residue_check \
  "legacy password login form" \
  "legacy password login form residue detected" \
  '\b(?:name|type|v-model)=["'\''][^"'\'']*(?:password|Password)|\b(?:passwordLogin|loginWithPassword|handlePasswordLogin)\b|\bFrameType[.]AuthLoginRequest\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/frontend/src/views/auth/Login.vue

run_residue_check \
  "legacy user profile credential fields" \
  "legacy user profile credential residue detected" \
  '\b(?:profileOldPassword|profileNewPassword|profileConfirmPassword|deleteAccountPassword|deleteAccountState|passwordForm|updateUsername|updatePassword)\b|账号信息|安全验证' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/frontend/src/views/user/Profile.vue src/frontend/src/views/user/IdentityCenter.vue src/frontend/src/components/user

run_residue_check \
  "legacy admin password reset governance" \
  "legacy admin password reset governance residue detected" \
  '\b(?:reset-pwd|AdminResetPwdDto|AdminResetUserPasswordRequest|adminResetPassword|encodeAdminResetPasswordRequest|UserResetPasswordDialog|resetDialog|canSubmitResetPassword|handleResetSubmit)\b|重置密码|新密码' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/frontend/src/views/admin src/frontend/src/components/admin src/frontend/src/composables src/frontend/src/api/admin.ts src/backend/Modules/Endpoints

run_residue_check \
  "legacy username public display fallback" \
  "legacy username public display fallback residue detected" \
  '\b(?:PublicHandle|publicHandle|public_handle|AnonymousDisplayName|anonymousDisplayName|anonymous_display_name)\b\s*(?:[?][?]|\|\|)\s*[^;\n]*(?:Username|username)\b|\b(?:Username|username)\b\s*(?:[?][?]|\|\|)\s*[^;\n]*(?:PublicHandle|publicHandle|public_handle)\b|[.]Select[(]u\s*=>\s*u[.]Username[)]|NormalizeToken[(]username' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend/Services/Security src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs src/frontend/src/views src/frontend/src/components src/frontend/src/api/comment.ts

run_residue_check \
  "legacy anonymous comment user-bound creation" \
  "legacy anonymous comment user-bound creation residue detected" \
  '\bCreateCommentAsync[(]\s*userId\b|\bCreateCommentV2Async[(]|\b(?:AedsFrameType|FrameType)[.]CommentCreateRequest\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs src/frontend/src/api/comment.ts

echo "[residue-check] passed"
