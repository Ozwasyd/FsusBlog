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
  "legacy password auth protocol frames" \
  "legacy password auth protocol frame residue detected" \
  '\bAuth(?:Login|Register|UpdatePassword|UpdateUsername)Request(?:Pod|CoreModel)?\b|\b(?:Write|Encode|TryDecode)Auth(?:Login|Register|UpdatePassword)Request\b|\bencodeAuth(?:Login|Register|UpdatePassword)Request\b|encodeStringMutationRequest[(]\s*data[.]newUsername\s*[)]' \
  "" \
  src/shared/Contracts/Validation/aeds-protocol.json src/shared/Contracts/Validation/fsusblog.openapi.json src/core/Algorithms/AedsFrameType.cs src/shared/AedsFrameHeader.cs src/frontend/wasm/web/protocol/frame.ts src/shared/Contracts/Models/UserPods.cs src/shared/Contracts/Validation/PodContractValidation.cs src/shared/Contracts/Validation/PodSizeCatalog.cs src/core/Mapping/Models/ReadModels.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts tests/backend/Fixtures/aeds-golden-catalog.json tests/frontend/fixtures/cross-stack-contract-matrix.json tests/frontend/fixtures/cross-stack-contract-matrix.generated.json tools/contracts

run_residue_check \
  "passkey sensitive frontend logs" \
  "passkey sensitive frontend log residue detected" \
  'console[.](?:log|error|warn)[(][^;\n]*["'\'']\[Passkey\]|assertion received|beginResp:|register beginResp:|list raw:|startAuthentication with options|alert[(][^;\n]*(?:通行密钥|Passkey|WebAuthn)' \
  "" \
  src/frontend/src/composables/usePasskeyLogin.ts src/frontend/src/composables/usePasskeyManagement.ts

run_residue_check \
  "frontend public handle username semantics" \
  "frontend public handle username-semantic residue detected" \
  '\b(?:USERNAME_CONSTRAINT|validateUsername)\b|autocomplete=["'\'']username["'\'']' \
  "" \
  src/frontend/src/views/auth/Register.vue src/frontend/src/views/user/IdentityCenter.vue src/frontend/src/composables/useAnonymousOnboarding.ts

run_residue_check \
  "legacy plain auth cookie fallback" \
  "legacy plain auth cookie fallback residue detected" \
  'Request[.]Cookies[.]TryGetValue[(]["'\''](?:AccessToken|RefreshToken|SessionId|AdminAccessToken|AdminSessionId)["'\'']|ReadCookie[(]context,\s*(?:AccessTokenCookieName|RefreshTokenCookieName|SessionIdCookieName|AdminAccessTokenCookieName|AdminSessionIdCookieName),\s*Host(?:AccessToken|RefreshToken|SessionId|AdminAccessToken|AdminSessionId)CookieName\s*[)]' \
  "" \
  src/backend/Infrastructure/Auth/AuthCookieService.cs src/backend/Infrastructure/Helpers/JwtHelper.cs

run_residue_check \
  "anonymous step-up password body fallback" \
  "anonymous step-up password body fallback residue detected" \
  'allowPasswordBody:\s*true' \
  "" \
  src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs

run_residue_check \
  "id-derived passkey user handles" \
  "id-derived passkey user-handle residue detected" \
  'BitConverter[.]GetBytes[(]\s*userId\s*[)]|fsus-account-\{userId\}' \
  "" \
  src/backend/Services/Security/PasskeyService.cs

run_residue_check \
  "raw anonymous credential issuance user ids" \
  "raw anonymous credential issuance user-id residue detected" \
  'anonymous_credential_issuance_audit[(][^)]*user_id|unique_idx_anonymous_credential_issuance_user_epoch|idx_anonymous_credential_issuance_user\b|ON CONFLICT[(]user_id,\s*epoch[)]|ActorId:\s*userId[.]ToString|int\s+UserId,\s*long\s+Epoch' \
  '^(tests/backend/Unit/AnonymousCredentialIssuerTests[.]cs|src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry[.]cs)$' \
  src/backend/Entities/AnonymousCredentialIssuanceAudit.cs src/backend/Services/Security/AnonymousCredentialIssuerService.cs src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs tests/backend/Unit/AnonymousCredentialIssuerTests.cs

run_residue_check \
  "anonymous credential issue naked authorization" \
  "anonymous credential issue naked authorization residue detected" \
  '[.]RequireAuthorization[(][)]|httpContext[.]GetUserId[(][)]' \
  "" \
  src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs

run_residue_check \
  "frontend anonymous step-up password proof payloads" \
  "frontend anonymous step-up password proof payload residue detected" \
  '\b(?:FrameType[.]MfaPasswordProofRequest|MfaPasswordProofRequest|encodeMfaPasswordProofRequest)\b' \
  "" \
  src/frontend/src

run_residue_check \
  "legacy auth identity protocol fields" \
  "legacy auth identity protocol field residue detected" \
  'AuthIdentitySnapshotDto[(][^;\n]*(?:Username|Role|UserId)|CurrentUserSnapshotDto[(][^;\n]*(?:Username|Role|UserId)|AuthLoginFlowDto[(][^;\n]*AuthIdentitySnapshotDto|AuthIdentitySnapshotDto\s+User|public readonly Utf8Fixed(?:64|32) (?:Username|Role);|flow[.]User|snapshot[.](?:Username|Role)|dto[.]User[?][.](?:Username|Role)|interface AuthLoginIdentitySnapshot|user:\s*AuthLoginIdentitySnapshot|(?:username|role):\s*(?:string|readFixedUtf8)' \
  "" \
  src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/Models/UserPods.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts

run_residue_check \
  "legacy username mutation runtime path" \
  "legacy username mutation runtime residue detected" \
  '\bAuthUpdateUsernameRequest\b|/auth/update-username\b|\bUpdateUsernameDto\b|\bUpdateUsernameAsync\b|\bupdateUsername\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend src/core src/shared src/frontend/src docs tests/backend/Unit tests/frontend/unit tests/frontend/fixtures tools/contracts

run_residue_check \
  "legacy username account lookup endpoint" \
  "legacy username account lookup endpoint residue detected" \
  '[/]auth[/]find[/][{]username[}]|\bGetAccountByUsernameAsync\b' \
  "" \
  src/backend src/shared/Contracts/Validation/fsusblog.openapi.json

run_residue_check \
  "legacy password auth runtime contracts" \
  "legacy password auth runtime residue detected" \
  '\b(?:LoginDto|RegisterDto|UpdatePasswordDto)\b|\bRegisterAsync[(][^;\n]*(?:RegisterDto|username|password)|\bLoginAsync[(][^;\n]*(?:LoginDto|username|password)|\bGetByUsernameAsync\b|\bUpdatePasswordAsync[(][^;\n]*|\bAuthUpdatePasswordRequest\b|/auth/update-password\b|\bupdatePassword\b|\bencodeAuthUpdatePasswordRequest\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend/Models/Dtos/UserDto.cs src/backend/Interfaces/IUserAuthService.cs src/backend/Interfaces/IUserService.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.cs src/backend/Services/UserService.Ports.cs src/backend/Services/Security/UserSecurityStepUpService.cs src/backend/Infrastructure/CoreBridge src/core/Services src/frontend/src/api/auth.ts src/frontend/src/views/auth src/frontend/src/composables/useAuthLogin.ts

run_residue_check \
  "legacy admin username lookup runtime path" \
  "legacy admin username lookup runtime residue detected" \
  '/auth/find/[{]username[}]|\bbinary_get_auth_find_username\b|\bGetAccountByUsernameAsync\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.Ports.cs src/shared/Contracts/Validation/fsusblog.openapi.json src/frontend/src/generated/fsusBinaryRoutes.ts tests/frontend/fixtures/cross-stack-contract-matrix.json tests/frontend/fixtures/cross-stack-contract-matrix.generated.json

run_residue_check \
  "legacy shared user snapshot contract" \
  "legacy shared user snapshot contract residue detected" \
  '\bUserSnapshotContract\b|\bAuthLoginResultContract\b|AuthLoginResultContract[(][^;\n]*User|LastLoginIp\b|string[[:space:]]+(?:Username|Role)\b|snapshot[.](?:Username|Role|LastLoginIp)\b|user[.](?:Username|Role|LastLoginIp)\b' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/shared/Contracts/AuthSystem/AuthSystemContracts.cs src/core/Services/Abstractions/IUserCoreService.cs src/core/Services/Gateways/IUserCoreGateway.cs src/core/Services/Implementations/UserCoreService.cs src/backend/Infrastructure/CoreBridge/Gateways/UserCoreGateway.cs src/backend/Infrastructure/CoreBridge/Adapters/UserServiceCoreAdapter.cs

run_residue_check \
  "legacy sys_user identity field names" \
  "legacy sys_user identity field residue detected" \
  '\bpublic[[:space:]]+string[?]?[[:space:]]+(Username|Password|Role)\b|\bLastUsernameUpdateTime\b|\b(user|u|ru)[.](Username|Role)\b|Role[[:space:]]*(==|!=)[[:space:]]*"admin"|Role[.]Equals[(]"admin"|Username[[:space:]]*[{][[:space:]]*get[;][[:space:]]*init[;][[:space:]]*[}]' \
  "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
  src/backend/Entities/User.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.cs src/backend/Services/UserService.Ports.cs src/backend/Services/Authoring/AuthoringWorkflowService.cs src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs src/backend/Services/Security/PasskeyService.cs src/backend/Infrastructure/Auth/AnonymousIdentityRuntime.cs

run_residue_check \
  "legacy comment public username fallback" \
  "legacy comment public username fallback residue detected" \
  '\bu[.]username\b|\bru[.]username\b|LEFT JOIN sys_user[[:space:]]+(?:u|ru)\b|[.]Username\b' \
  "" \
  src/backend/Services/CommentService.cs

run_residue_check \
  "legacy public comment read identity fields" \
  "legacy public comment read identity field residue detected" \
  '\b(?:readonly[[:space:]]+(?:userName|replyToUserId|replyToUserName)|(?:userName|replyToUserName):[[:space:]]*comment[.]|replyToUserName[?]?:|replyToUserId[?]?:|CommentPushDto[.]UserName)\b' \
  "" \
  src/shared/Contracts/Outputs/ServerResponseContracts.cs src/core/Mapping/Models/ReadModels.cs src/frontend/src/view-contracts/commentDetail.ts docs/api/contracts.md

run_residue_check \
  "legacy message sender user model" \
  "legacy message sender user-model residue detected" \
  '\b(?:adminUserId|targetUserId|systemTargetUserId|InitiatorUserId|CreatedById|SenderId)\b|public int UserId|Queryable<User>\(\)|[.]Username|目标用户 ID|MessageSenderType[.]User|\bUser[[:space:]]*=[[:space:]]*0,|ConversationSenderValue[.]User|\b(?:GetUserConversationsAsync|GetUserConversationDetailAsync|CreateUserTicketAsync|ReplyAsUserAsync|SendUserTransactionalNoticeAsync|SendUserBannedNoticeAsync|SendUserUnbannedNoticeAsync|PushUserStatusAsync)\b|\b(?:getUserConversations|getUserConversationDetail|createUserConversation|replyUserConversation|useUserMessagesInbox)\b|\bUserConversationRow\b|\bPublishUserConversation|\b(?:UserStatusChanged|UserStatusPayload|UserStatusPayloadPod)\b|mode=["'\'']user["'\'']|messages-bubble-user|contextUserText|context-user-text' \
  "" \
  src/backend/Entities/Message.cs src/backend/Interfaces/IMessageService.cs src/backend/Services/NotificationStream/MessageCenterService.cs src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs src/shared/Contracts/Models/MessagePods.cs src/core/Cache/PodBinaryCodec.Message.cs src/core/Cache/PodBinaryCodec.Notification.cs src/frontend/src/api/message.ts src/frontend/src/composables src/frontend/src/components/user/messages src/frontend/src/views/user/Messages.vue src/frontend/src/services/notificationStreamTypes.ts src/frontend/src/services/notificationStreamRuntime.ts src/frontend/src/store/notificationStream.ts tests/frontend/support/aeds-envelope.mjs tests/frontend/unit/api/message.test.ts tests/frontend/e2e/acceptance/admin-console.spec.ts tests/frontend/checks/security/check-permission-matrix.mjs

run_residue_check \
  "legacy demo seed password user model" \
  "legacy demo seed password user-model residue detected" \
  'insert into sys_user [(]username,\s*password,\s*role|create_time,\s*user_id,\s*author_mode|reply_to_user_id|moderated_by_user_id|from sys_user|role = ['\''"]admin['\''"]|ChangeMe123!|Admin password' \
  "" \
  tools/dev/demo-seed.sql tools/dev/seed-demo-data.sh docs/development/demo-data.md README.md docs/development.md

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

run_residue_check \
  "role-based admin authorization checks" \
  "role-based admin authorization residue detected" \
  'IsInRole[(]\s*["'\'']admin["'\''][)]|FindFirst[(]\s*ClaimTypes[.]Role\s*[)]|RequireRole[(]\s*["'\'']admin["'\''][)]|Authorize[(][^)]*Roles\s*=|RolesAuthorizationRequirement|new\s*[(]\s*ClaimTypes[.]Role\s*,\s*["'\'']admin["'\'']|new[(]ClaimTypes[.]Role\s*,\s*["'\'']admin["'\''][)]|PolicyRequiresAdminRole|ContainsAdminRole' \
  "" \
  src/backend

run_residue_check \
  "legacy authoring user attribution" \
  "legacy authoring user attribution residue detected" \
  'SaveDraftAsync[(]\s*context[.]GetUserId[(][)]|GetDraftAsync[(]\s*context[.]GetUserId[(][)]|DiscardDraftAsync[(]\s*context[.]GetUserId[(][)]|RollbackRevisionAsync[(]\s*context[.]GetUserId[(][)]|OwnerUserId|owner_user_id|CreatedByUserId|created_by_user_id|createdByUserId' \
  '^(src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry[.]cs)$' \
  src/backend/Modules/Endpoints/AuthoringEndpoints.cs src/backend/Services/Authoring/AuthoringWorkflowService.cs src/backend/Services/ArticleService.cs src/backend/Entities/Article.cs src/backend/Models/Dtos/AuthoringDtos.cs src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs src/frontend/src/api/authoring.ts src/frontend/src/components/admin/article/ArticleRevisionPanel.vue

run_residue_check \
  "legacy comment moderation account display fallback" \
  "legacy comment moderation account display fallback residue detected" \
  'Queryable<Comment,\s*Article,\s*User|JoinType[.]Left,\s*c[.]UserId\s*==\s*u[.]Id|JoinType[.]Left,\s*c[.]ReplyToUserId\s*==\s*ru[.]Id|u[.]PublicHandle|ru[.]PublicHandle|u[.]Username|ru[.]Username|row[.]UserName|comment[.]userName|cleanText[(]item[.]userName[)]|accountSearchText' \
  "" \
  src/backend/Services/Authoring/AuthoringWorkflowService.cs src/frontend/src/components/admin/DashboardCommentModerationPanel.vue src/frontend/src/composables/useCommentModerationQueue.ts

run_residue_check \
  "legacy comment moderation user attribution" \
  "legacy comment moderation user attribution residue detected" \
  'ModerateCommentAsync[(]\s*int\s+actorUserId|ModerateCommentsAsync[(][^)]*int\s+actorUserId|ModeratedByUserId|moderatedByUserId|moderated_by_user_id|ModeratedByUserId\s*==\s*actorUserId|ModerateCommentAsync[(]\s*context[.]GetUserId[(][)]|ModerateCommentsAsync[(]\s*context[.]GetUserId[(][)]' \
  '^(src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry[.]cs|tests/backend/Integration/SchemaMigrationIntegrationTests[.]cs)$' \
  src/backend/Entities/Comment.cs src/backend/Services/Authoring/AuthoringWorkflowService.cs src/backend/Modules/Endpoints/AuthoringEndpoints.cs src/backend/Models/Dtos/AuthoringDtos.cs src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs src/frontend/src/api/authoring.ts src/frontend/src/composables/useCommentModerationQueue.ts src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue tests/backend/Integration/SchemaMigrationIntegrationTests.cs

run_residue_check \
  "legacy anonymous credential user commitment binding" \
  "legacy anonymous credential user commitment binding residue detected" \
  'public[[:space:]]+int[?]?[[:space:]]+UserId\b|ColumnName[[:space:]]*=[[:space:]]*["'\'']user_id["'\'']|CommitmentHash|commitment_hash|ZkCommitment|zk_commitment|IssueAsync[(][^)]*userId[^)]*commitmentHash|GetActiveCredentialAsync[(]|GetCredentialLevelAsync[(]' \
  "" \
  src/backend/Entities/AnonymousCredential.cs src/backend/Services/Security/AnonymousCredentialService.cs

run_residue_check \
  "legacy frontend admin fallbacks" \
  "legacy frontend admin fallback residue detected" \
  'legacy[.]admin|syncLegacyAdminPrincipal|userInfo[.]role\s*={2,3}\s*["'\'']admin["'\'']|user[?]?[.]role\s*={2,3}\s*["'\'']admin["'\'']' \
  "" \
  src/frontend/src

run_residue_check \
  "legacy anonymous identity frontend id contract" \
  "legacy anonymous identity frontend id contract residue detected" \
  'internalUserId|InternalUserId|export[[:space:]]+interface[[:space:]]+RecoveryKeyVerifyResponse[[:space:]]*\{[^}]*userId|const[[:space:]]+userId[[:space:]]*=[[:space:]]*readInt32[(]payload,[[:space:]]*0[)]|user[?][.]id' \
  "" \
  src/core/Mapping/Models/ReadModels.cs src/shared/Contracts/Models/UserPods.cs src/backend/Services/UserService.Ports.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts src/frontend/src/views/user/IdentityCenter.vue

run_residue_check \
  "legacy user session raw ip output contract" \
  "legacy user session raw IP output residue detected" \
  '\blastIp\b|session[.]lastIp|formatSessionIp|readFixedUtf8[(]pod,\s*204,\s*64[)]|LastIp[[:space:]]*=[[:space:]]*s[.]LastIp|s[.]LastIp[[:space:]]*[?][?][[:space:]]*"unknown"|IP：' \
  "" \
  src/core/Cache/PodBinaryCodec.User.cs src/backend/Services/UserService.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts src/frontend/src/views/user/IdentityCenter.vue

run_residue_check \
  "human-read visit user binding" \
  "human-read visit user-bound residue detected" \
  'context[.]GetUserId[(][)]|VisitLogMessage[(][^;\n]*UserId|msg[.]UserId|public[[:space:]]+int[?][[:space:]]+UserId\b|new[[:space:]]+VisitLog[[:space:]]*[{][^}]*UserId[[:space:]]*=|\bRegisteredVisits\b|\bAnonymousVisits\b|registeredVisits|anonymousVisits|v[.]UserId' \
  '^(src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation[.]cs|src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry[.]cs|src/backend/Infrastructure/SchemaMigration/SchemaMigrationConsistencyChecker[.]cs)$' \
  src/backend/Entities/VisitLog.cs src/backend/Services/HumanReadProofService.cs src/backend/Services/VisitLog src/backend/Services/StatsService.cs src/backend/Infrastructure/CoreBridge src/backend/Infrastructure/Cache src/shared/Contracts src/core src/frontend/src tests/frontend/fixtures

run_residue_check \
  "human-read raw visit ip persistence" \
  "human-read raw visit-ip persistence residue detected" \
  'public[[:space:]]+string[?]?[[:space:]]+IP\b|SugarColumn[(][^;\n]*ColumnName[[:space:]]*=[[:space:]]*["'\'']ip["'\'']|EnsureColumnStep[(][^;\n]*["'\'']sys_visit_log["'\''][^;\n]*["'\'']ip["'\'']|ADD COLUMN IF NOT EXISTS ip\b|new[[:space:]]+VisitLog[[:space:]]*[{][^}]*IP[[:space:]]*=|IP[[:space:]]*=[[:space:]]*(?:msg[.]IP|ip)\b|sys_visit_log[."]ip\b' \
  "" \
  src/backend/Entities/VisitLog.cs src/backend/Services/VisitLog/VisitLogProcessorService.cs src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs

run_residue_check \
  "message legacy user identity sync coupling" \
  "message legacy user identity sync residue detected" \
  '(initiatoruserid|senderid|userid).*identity_sync' \
  "" \
  src/backend

run_residue_check \
  "stats recent comment user identity" \
  "stats recent comment user identity residue detected" \
  'LeftJoin<User>|u[.]Username|u[.]Id|GetOrdinal[(]["'\'']Username["'\''][)]|RecentCommentStatItemDto[(][^;\n]*(?:UserId|UserName)|RecentCommentCoreModel[(][^;\n]*(?:UserId|UserName)|ProjectRecentComment[(][^;\n]*(?:userId|userName)|UserId = userId|public readonly int UserId;|HasUserId|item[.]UserId|item[.]UserName|reader[.]readSpan[(]32[)]|comment[.]userName|userId:|userName:' \
  '' \
  src/backend/Services/StatsService.cs src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/Models/StatsPods.cs src/core/Mapping/Models/ReadModels.cs src/core/Mapping/Projectors/PodProjector.cs src/core/Cache/PodBinaryCodec.Stats.cs src/backend/Infrastructure/CoreBridge/Adapters/StatsServiceCoreAdapter.cs src/backend/Infrastructure/CoreBridge/Gateways/StatsCoreGateway.cs src/frontend/src/api/stats.ts src/frontend/src/adapters/binary/statsAdapter.ts src/frontend/src/view-contracts/adminStats.ts src/frontend/src/components/admin/DashboardRecentComments.vue

echo "[residue-check] passed"
