#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${FSUSBLOG_HISTORICAL_RESIDUE_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX='^(docs/(api/(design|contracts)[.]md|database-migration[.]md|anonymous-identity-smoke-flow[.]md)|tools/db/.*|tests/(backend|frontend)/.*|src/migration/Definitions/[^/]+MigrationDefinitions[.]cs)$'

RunResidueCheck() {
    local description="$1"
    local failureMessage="$2"
    local pattern="$3"
    local allowPathRegex="$4"
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

    if [[ -n "$allowPathRegex" ]]; then
        output="$(printf '%s\n' "$output" | awk -F: -v allow="$allowPathRegex" '$1 !~ allow')"
    fi

    if [[ -n "$output" ]]; then
        printf '%s\n' "$output"
        echo "[residue-check] ${failureMessage}"
        exit 1
    fi
}

RequireSecurityLiteral() {
    local literal="$1"
    local paths=()
    local candidate
    for candidate in security/matrices/privacy-zk-comment.yml security/zk/contracts/comment-v5-tamper-cases.manifest.json; do
        if [[ -e "$candidate" ]]; then
            paths+=("$candidate")
        fi
    done

    if [[ "${#paths[@]}" -eq 0 ]]; then
        echo "[residue-check] security ZK invariant guard has no security manifests to inspect"
        exit 1
    fi

    if ! rg -q --fixed-strings "$literal" "${paths[@]}"; then
        echo "[residue-check] required security ZK invariant literal missing: ${literal}"
        exit 1
    fi
}

RunAppsettingsIdentityResidueCheck() {
    echo "[residue-check] verifying appsettings legacy admin identity fields..."

    local output=""
    local file
    while IFS= read -r -d '' file; do
        local matches
        matches="$(
            awk '
        function brace_delta(value, i, char, delta) {
          delta = 0
          for (i = 1; i <= length(value); i++) {
            char = substr(value, i, 1)
            if (char == "{") {
              delta++
            } else if (char == "}") {
              delta--
            }
          }
          return delta
        }
        BEGIN { in_admin = 0; admin_depth = 0 }
        {
          if ($0 ~ /"Admin(:|__)(Username|Password|Role)"[[:space:]]*:/) {
            print FILENAME ":" FNR ":" $0
          }

          if (!in_admin && $0 ~ /"Admin"[[:space:]]*:[[:space:]]*\{/) {
            in_admin = 1
            admin_depth = 0
          }

          if (in_admin && $0 ~ /"(Username|Password|Role)"[[:space:]]*:/) {
            print FILENAME ":" FNR ":" $0
          }

          if (in_admin) {
            admin_depth += brace_delta($0)
            if (admin_depth <= 0) {
              in_admin = 0
              admin_depth = 0
            }
          }
        }
      ' "$file"
        )"
        if [[ -n "$matches" ]]; then
            output+="$matches"$'\n'
        fi
    done < <(
        find "$ROOT_DIR" \
            \( -path '*/node_modules/*' -o -path '*/dist/*' -o -path '*/build*/*' -o -path '*/.artifacts/*' -o -path '*/.tmp/*' -o -path '*/bin/*' -o -path '*/obj/*' \) -prune \
            -o -type f -name 'appsettings*.json' -print0
    )

    if [[ -n "$output" ]]; then
        printf '%s' "$output"
        echo "[residue-check] legacy appsettings admin identity field residue detected"
        exit 1
    fi
}

RequireSecurityLiteral "tamper-scope"
RequireSecurityLiteral "tamper-root"
RequireSecurityLiteral "tamper-revocation-root"
RequireSecurityLiteral "tamper-non-current-layout"

RunResidueCheck \
    "legacy gateway markers" \
    "legacy gateway residue detected" \
    '\b(?:I[A-Za-z]*Legacy[A-Za-z]*Gateway|Legacy[A-Za-z]+Gateway)\b' \
    "" \
    src/core src/backend src/frontend src/shared

RunResidueCheck \
    "notification stream legacy target names" \
    "notification stream legacy target residue detected" \
    '\b(?:NotificationStreamGroups|AuthenticatedUsers|AuthenticatedUsersGroup|ContentGovernanceGroup|AdminUsersGroup)\b|authenticated-users' \
    "" \
    src/backend/Infrastructure/NotificationStream/NotificationStreamTargets.cs \
    src/backend/Infrastructure/NotificationStream/NotificationStreamAudienceResolver.cs \
    src/backend/Modules/Endpoints/NotificationStreamDrillEndpoints.cs

RunResidueCheck \
    "frontend retired identifiers" \
    "frontend retired identifier residue detected" \
    '\b(?:setUserInfo|isMobileSearchOpen|setMobileSearchVisible|updateRiskControlOptions|rollbackRiskControlOptions|RiskControlPolicyUpdateRequest|poSpaceV1Enabled|CommentDto|PowRequest|useAboutPage)\b|About[.]vue' \
    "" \
    src/frontend/src

RunResidueCheck \
    "retired persisted binary transport toggle" \
    "retired persisted binary transport toggle residue detected" \
    'fsus[.]transport[.]binary|\b(?:useArticleBinaryStore|readBinaryFlag|useBinary)\b|["'\'']article-binary["'\'']' \
    "" \
    src/frontend/src tests/frontend/unit docs/api

RunResidueCheck \
    "retired backend cleanup symbols" \
    "retired backend cleanup symbol residue detected" \
    '\b(?:CrawlerAuthMiddleware|PublicAotShellKeyBuilder|CreateConversationRequest|ReplyConversationRequest|AdminConversationStatusRequest|SendSystemMessageRequest|SearchArticlesRequest|ArticleQueryRequest|DeleteCommentRequest|RefreshRequestDto|MfaSetupVerifyRequestDto|MfaChallengeRequestDto|MfaDisableRequestDto|UploadCompleteRequestDto|ApplyArticleList|ApplyHotArticles|ApplyFeaturedArticles|ApplyCommentThreads|ApplyCommentThreadReplies|DecrementUnreadAsync|GetUnreadCountAsync|UpdateGlobalVersionAsync|GetGlobalVersionAsync|ClearUnreadAsync|MessageGlobalVersion)\b' \
    "" \
    src/backend

RunResidueCheck \
    "obsolete AOT shell builder names" \
    "obsolete AOT shell builder names detected" \
    'BuildHomeShell|BuildArticleDetailShell|BuildFilterShell|BuildAboutShell|BuildArchiveShell' \
    "" \
    src/backend/Infrastructure/PublicAot/PublicAotShellService.cs

RunResidueCheck \
    "old dto aliases" \
    "old dto alias residue detected" \
    '\b(ArticleListDto|ArticleDetailDto|CategoryDto|PageResultDto|CursorResult|SeoConfigDto|PageContentDto|UserCommentDto|ArticleDto|SearchDto|ArticleQueryRequestDto)\b' \
    "" \
    src/backend src/shared src/frontend

RunResidueCheck \
    "legacy runtime bridge names" \
    "legacy runtime bridge residue detected" \
    '\bBridgeToLegacy(?:Authoring|Security)EndpointAsync\b|(?:authoring|security)_legacy_envelope|/_fsus/internal/binary[-]bridge/(?:author|admin/security)|\bBinaryBridgeInternalRequest\.(?:AuthoringPrefix|SecurityPrefix)\b' \
    '^(src/shared/Contracts/Validation/fsusblog[.]openapi[.]json|tests/frontend/fixtures/cross-stack-contract-matrix([.]generated)?[.]json)$' \
    src/backend src/shared tools/contracts docs/api tests/frontend

RunResidueCheck \
    "old comment-create V1 paths" \
    "old comment-create V1 residue detected" \
    '\bcreateCommentV1\b|\b(?:CommentCreateV2[A-Za-z0-9_]*|createCommentV2|encodeCommentCreateV2[A-Za-z0-9_]*)\b|["'\'']/api/Comment(?:["'\''/?]|$)' \
    "" \
    src/backend src/shared src/frontend/src

RunResidueCheck \
    "retired comment-create account override" \
    "retired comment-create account override residue detected" \
    '\b(?:ReplyToUserId|replyToUserId|HasReplyToUserId)\b' \
    "" \
    src/frontend/src src/backend/Models/Dtos/CommentDto.cs \
    src/shared/Contracts/Models/CommentCreateRequestPod.Generated.cs \
    src/core/Mapping/Models/CommentCreateRequest.Generated.cs

RunResidueCheck \
    "old author-mode aliases" \
    "old author-mode alias residue detected" \
    '\b(?:authorMode|defaultAuthorMode|DefaultAuthorMode|AuthorMode)\b\s*[:=]\s*["'\''](?:guest|incognito|legacy|legacy_anonymous|anonymous_legacy|anon|authenticated|account|real_name|real-name)["'\'']' \
    "" \
    src/backend src/shared src/frontend/src tests/frontend/fixtures

RunResidueCheck \
    "old UI fixture fallbacks" \
    "old UI fixture fallback residue detected" \
    '\blegacy-ui-fixture-fallback\b|\bFsusUiFallbackFixtures\b|\buiFixtureFallback\b|\bFSUSBLOG_(?:USE_)?UI_FIXTURE_FALLBACK\b|\bfixtureFallback\b' \
    "" \
    src/frontend/src tests/frontend/fixtures tests/frontend/checks

RunResidueCheck \
    "old local package type shims" \
    "old local package type shim residue detected" \
    '\bLocalPackageTypeShim\b|\bfsusui-local-shim\b|declare\s+module\s+["'\'']@ozwasyd/element-plus["'\'']' \
    '^src/frontend/src/fsusui/elementPlusAugmentations\.d\.ts$' \
    src/frontend/src tests/frontend

RunResidueCheck \
    "old algorithm fallback switches" \
    "old algorithm fallback switch residue detected" \
    '\bLegacyModernAcAutomaton\b|\bUseLegacyChildRangeAutomaton\b|\bFSUSBLOG_SECURITY_MODERN_AC_USE_LEGACY_CHILD_RANGE\b|FsusBlog\.Security\.ModernAcAutomaton\.UseLegacyChildRange|\b_legacyFallback\b' \
    "" \
    src/backend/Infrastructure/Helpers/Security tests/backend

RunResidueCheck \
    "legacy anonymous account auth contracts" \
    "legacy anonymous account auth contract residue detected" \
    '\b(?:FrameType|AedsFrameType)\.Auth(?:Login|Register)Request\b|binaryUrl:\s*["'\'']/api/binary/auth/(?:login|register)["'\'']|group[.]MapPost[(]["'\'']/auth/(?:login|register)["'\'']|export\s+interface\s+(?:Login|Register)Dto\b|function\s+encodeAuth(?:Login|Register)Request\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/frontend/src src/backend/Modules/Endpoints/Binary docs tests/backend/Unit

RunResidueCheck \
    "docs api contracts legacy identity JSON examples" \
    "docs api contracts legacy identity JSON example residue detected" \
    '"(?:userName|replyToUserName|internalUserId)"[[:space:]]*:[[:space:]]*+(?!null\b)[^,}\r\n]+' \
    "" \
    docs/api/contracts.md

RunResidueCheck \
    "legacy password auth protocol frames" \
    "legacy password auth protocol frame residue detected" \
    '\bAuth(?:Login|Register|UpdatePassword|UpdateUsername)Request(?:Pod|CoreModel)?\b|\b(?:Write|Encode|TryDecode)Auth(?:Login|Register|UpdatePassword)Request\b|\bencodeAuth(?:Login|Register|UpdatePassword)Request\b|encodeStringMutationRequest[(]\s*data[.]newUsername\s*[)]' \
    "" \
    src/shared/Contracts/Validation/aeds-protocol.json src/shared/Contracts/Validation/fsusblog.openapi.json src/core/Algorithms/AedsFrameType.cs src/shared/AedsFrameHeader.cs src/frontend/wasm/web/protocol/frame.ts src/shared/Contracts/Models/UserPods.cs src/shared/Contracts/Validation/PodContractValidation.cs src/shared/Contracts/Validation/PodSizeCatalog.cs src/core/Mapping/Models/ReadModels.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts tests/backend/Fixtures/aeds-golden-catalog.json tests/frontend/fixtures/cross-stack-contract-matrix.json tests/frontend/fixtures/cross-stack-contract-matrix.generated.json tools/contracts

RunResidueCheck \
    "passkey sensitive frontend logs" \
    "passkey sensitive frontend log residue detected" \
    'console[.](?:log|error|warn)[(][^;\n]*["'\'']\[Passkey\]|assertion received|beginResp:|register beginResp:|list raw:|startAuthentication with options|alert[(][^;\n]*(?:通行密钥|Passkey|WebAuthn)' \
    "" \
    src/frontend/src/composables/usePasskeyLogin.ts src/frontend/src/composables/usePasskeyManagement.ts

RunResidueCheck \
    "frontend public handle username semantics" \
    "frontend public handle username-semantic residue detected" \
    '\b(?:USERNAME_CONSTRAINT|validateUsername)\b|autocomplete=["'\'']username["'\'']' \
    "" \
    src/frontend/src

RunResidueCheck \
    "legacy plain auth cookie fallback" \
    "legacy plain auth cookie fallback residue detected" \
    'Request[.]Cookies[.]TryGetValue[(]["'\''](?:AccessToken|RefreshToken|SessionId|AdminAccessToken|AdminSessionId)["'\'']|ReadCookie[(]context,\s*(?:AccessTokenCookieName|RefreshTokenCookieName|SessionIdCookieName|AdminAccessTokenCookieName|AdminSessionIdCookieName),\s*Host(?:AccessToken|RefreshToken|SessionId|AdminAccessToken|AdminSessionId)CookieName\s*[)]' \
    "" \
    src/backend/Infrastructure/Auth/AuthCookieService.cs src/backend/Infrastructure/Helpers/JwtHelper.cs

RunResidueCheck \
    "anonymous step-up password body fallback" \
    "anonymous step-up password body fallback residue detected" \
    'allowPasswordBody:\s*true' \
    "" \
    src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs

RunResidueCheck \
    "id-derived passkey user handles" \
    "id-derived passkey user-handle residue detected" \
    'BitConverter[.]GetBytes[(]\s*userId\s*[)]|fsus-account-\{userId\}' \
    "" \
    src/backend/Services/Security/PasskeyService.cs

RunResidueCheck \
    "raw anonymous credential issuance user ids" \
    "raw anonymous credential issuance user-id residue detected" \
    'anonymous_credential_issuance_audit[(][^)]*user_id|unique_idx_anonymous_credential_issuance_user_epoch|idx_anonymous_credential_issuance_user\b|ON CONFLICT[(]user_id,\s*epoch[)]|ActorId:\s*userId[.]ToString|int\s+UserId,\s*long\s+Epoch' \
    '^(src/migration/Definitions/[^/]+MigrationDefinitions[.]cs)$' \
    src/backend/Entities/AnonymousCredentialIssuanceAudit.cs src/migration/Definitions

RunResidueCheck \
    "frontend anonymous step-up password proof payloads" \
    "frontend anonymous step-up password proof payload residue detected" \
    '\b(?:FrameType[.]MfaPasswordProofRequest|MfaPasswordProofRequest|encodeMfaPasswordProofRequest)\b' \
    "" \
    src/frontend/src

RunResidueCheck \
    "legacy auth identity protocol fields" \
    "legacy auth identity protocol field residue detected" \
    'AuthIdentitySnapshotDto[(][^;\n]*(?:Username|Role|UserId)|CurrentUserSnapshotDto[(][^;\n]*(?:Username|Role|UserId)|AuthLoginFlowDto[(][^;\n]*AuthIdentitySnapshotDto|AuthIdentitySnapshotDto\s+User|public readonly Utf8Fixed(?:64|32) (?:Username|Role);|flow[.]User|snapshot[.](?:Username|Role)|dto[.]User[?][.](?:Username|Role)|interface AuthLoginIdentitySnapshot|user:\s*AuthLoginIdentitySnapshot|(?:username|role):\s*(?:string|readFixedUtf8)' \
    "" \
    src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/Models/UserPods.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts

RunResidueCheck \
    "legacy username mutation runtime path" \
    "legacy username mutation runtime residue detected" \
    '\bAuthUpdateUsernameRequest\b|/auth/update-username\b|\bUpdateUsernameDto\b|\bUpdateUsernameAsync\b|\bupdateUsername\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend src/core src/shared src/frontend/src docs tests/backend/Unit tests/frontend/unit tests/frontend/fixtures tools/contracts

RunResidueCheck \
    "legacy username account lookup endpoint" \
    "legacy username account lookup endpoint residue detected" \
    '[/]auth[/]find[/][{]username[}]|\bGetAccountByUsernameAsync\b' \
    "" \
    src/backend src/shared/Contracts/Validation/fsusblog.openapi.json

RunResidueCheck \
    "legacy password auth runtime contracts" \
    "legacy password auth runtime residue detected" \
    '\b(?:LoginDto|RegisterDto|UpdatePasswordDto)\b|\bRegisterAsync[(][^;\n]*(?:RegisterDto|username|password)|\bLoginAsync[(][^;\n]*(?:LoginDto|username|password)|\bGetByUsernameAsync\b|\bUpdatePasswordAsync[(][^;\n]*|\bAuthUpdatePasswordRequest\b|/auth/update-password\b|\bupdatePassword\b|\bencodeAuthUpdatePasswordRequest\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend/Models/Dtos/UserDto.cs src/backend/Interfaces/IUserService.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.cs src/backend/Services/UserService.Ports.cs src/backend/Services/Security/UserSecurityStepUpService.cs src/backend/Infrastructure/CoreBridge src/core/Services src/frontend/src/api/auth.ts src/frontend/src/views/auth src/frontend/src/composables/useAuthLogin.ts

RunResidueCheck \
    "legacy admin username lookup runtime path" \
    "legacy admin username lookup runtime residue detected" \
    '/auth/find/[{]username[}]|\bbinary_get_auth_find_username\b|\bGetAccountByUsernameAsync\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.Ports.cs src/shared/Contracts/Validation/fsusblog.openapi.json src/frontend/src/generated/fsusBinaryRoutes.ts tests/frontend/fixtures/cross-stack-contract-matrix.json tests/frontend/fixtures/cross-stack-contract-matrix.generated.json

RunResidueCheck \
    "legacy shared user snapshot contract" \
    "legacy shared user snapshot contract residue detected" \
    '\bUserSnapshotContract\b|\bAuthLoginResultContract\b|AuthLoginResultContract[(][^;\n]*User|LastLoginIp\b|string[[:space:]]+(?:Username|Role)\b|snapshot[.](?:Username|Role|LastLoginIp)\b|user[.](?:Username|Role|LastLoginIp)\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/shared/Contracts/AuthSystem/AuthSystemContracts.cs src/core/Services/Abstractions/IUserCoreService.cs src/core/Services/Gateways/IUserCoreGateway.cs src/core/Services/Implementations/UserCoreService.cs src/backend/Infrastructure/CoreBridge/Gateways/UserCoreGateway.cs src/backend/Infrastructure/CoreBridge/Adapters/UserServiceCoreAdapter.cs

RunResidueCheck \
    "legacy sys_user identity field names" \
    "legacy sys_user identity field residue detected" \
    '\bsys_user[.](username|password|role|last_username_update_time|lastusernameupdatetime)\b|\bpublic[[:space:]]+string[?]?[[:space:]]+(Username|Password|Role)\b|\bLastUsernameUpdateTime\b|\b(user|u|ru)[.](Username|Role)\b|Role[[:space:]]*(==|!=)[[:space:]]*"admin"|Role[.]Equals[(]"admin"|Username[[:space:]]*[{][[:space:]]*get[;][[:space:]]*init[;][[:space:]]*[}]' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend/Entities/User.cs src/backend/Interfaces/UserApplicationPorts.cs src/backend/Services/UserService.cs src/backend/Services/UserService.Ports.cs src/backend/Services/Authoring src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs src/backend/Services/Security/PasskeyService.cs src/backend/Infrastructure/Auth/AnonymousIdentityRuntime.cs src/migration/Definitions

RunAppsettingsIdentityResidueCheck

RunResidueCheck \
    "operations connection string key parsing" \
    "operations connection string key parsing residue detected" \
    '\bconnection_value[[:space:]]+(User|Password)\b' \
    "" \
    tools/operations

RunResidueCheck \
    "legacy comment public username fallback" \
    "legacy comment public username fallback residue detected" \
    '\bu[.]username\b|\bru[.]username\b|LEFT JOIN sys_user[[:space:]]+(?:u|ru)\b|[.]Username\b' \
    "" \
    src/backend/Services/CommentService.cs

RunResidueCheck \
    "legacy public comment read identity fields" \
    "legacy public comment read identity field residue detected" \
    '\b(?:readonly[[:space:]]+(?:userName|replyToUserId|replyToUserName)|(?:userName|replyToUserName):[[:space:]]*comment[.]|replyToUserName[?]?:|replyToUserId[?]?:|CommentPushDto[.]UserName)\b' \
    "" \
    src/shared/Contracts/Outputs/ServerResponseContracts.cs src/core/Mapping/Models/ReadModels.cs src/frontend/src/view-contracts/commentDetail.ts docs/api/contracts.md

RunResidueCheck \
    "benchmark legacy comment username fields" \
    "benchmark legacy comment username field residue detected" \
    '\b_userName\b|GetProperty[(]["'\'']userName["'\''][)]|["'\'']userName["'\'']|[.]UserName\b' \
    "" \
    benchmarks

RunResidueCheck \
    "frontend unit legacy identity assertions" \
    "frontend unit legacy identity assertion residue detected" \
    '[.]userName\b|toHaveProperty[(][^)]*(?:UserId|userName)|GetProperty[(]["'\'']userName["'\''][)]|expect[(][^)]*(?:UserId|userName)' \
    "" \
    tests/frontend/unit/store tests/frontend/unit/api tests/frontend/unit/adapters/binary

RunResidueCheck \
    "legacy message sender user model" \
    "legacy message sender user-model residue detected" \
    '\b(?:adminUserId|targetUserId|systemTargetUserId|InitiatorUserId|CreatedById|SenderId)\b|public int UserId|Queryable<User>\(\)|[.]Username|目标用户 ID|MessageSenderType[.]User|\bUser[[:space:]]*=[[:space:]]*0,|ConversationSenderValue[.]User|\b(?:GetUserConversationsAsync|GetUserConversationDetailAsync|CreateUserTicketAsync|ReplyAsUserAsync|SendUserTransactionalNoticeAsync|SendUserBannedNoticeAsync|SendUserUnbannedNoticeAsync|PushUserStatusAsync)\b|\b(?:getUserConversations|getUserConversationDetail|createUserConversation|replyUserConversation|useUserMessagesInbox)\b|\bUserConversationRow\b|\bPublishUserConversation|\b(?:UserStatusChanged|UserStatusPayload|UserStatusPayloadPod)\b|mode=["'\'']user["'\'']|messages-bubble-user|contextUserText|context-user-text' \
    "" \
    src/backend/Entities/Message.cs src/backend/Interfaces/IMessageService.cs src/backend/Services/NotificationStream/MessageCenterService.cs src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs src/shared/Contracts/Models/MessagePods.cs src/core/Cache/PodBinaryCodec.Message.cs src/core/Cache/PodBinaryCodec.Notification.cs src/frontend/src/api/message.ts src/frontend/src/composables src/frontend/src/components/user/messages src/frontend/src/views/user/Messages.vue src/frontend/src/services/notificationStreamTypes.ts src/frontend/src/services/notificationStreamRuntime.ts src/frontend/src/store/notificationStream.ts tests/frontend/support/aeds-envelope.mjs tests/frontend/unit/api/message.test.ts tests/frontend/unit/components/user/MessagesStateMachine.test.ts tests/frontend/checks/security/check-permission-matrix.mjs

RunResidueCheck \
    "legacy demo seed password user model" \
    "legacy demo seed password user-model residue detected" \
    'insert into sys_user [(]username,\s*password,\s*role|create_time,\s*user_id,\s*author_mode|reply_to_user_id|moderated_by_user_id|from sys_user|role = ['\''"]admin['\''"]|ChangeMe123!|Admin password|not a password login|never a password|without password' \
    "" \
    docs/development/demo-data.md README.md docs/development.md

RunResidueCheck \
    "legacy password login form" \
    "legacy password login form residue detected" \
    '\b(?:name|type|v-model)=["'\''][^"'\'']*(?:password|Password)|\b(?:passwordLogin|loginWithPassword|handlePasswordLogin)\b|\bFrameType[.]AuthLoginRequest\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/frontend/src/views/auth/Login.vue

RunResidueCheck \
    "legacy user profile credential fields" \
    "legacy user profile credential residue detected" \
    '\b(?:profileOldPassword|profileNewPassword|profileConfirmPassword|deleteAccountPassword|deleteAccountState|passwordForm|updateUsername|updatePassword)\b|账号信息|安全验证' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/frontend/src/views/user/Profile.vue src/frontend/src/views/user/IdentityCenter.vue src/frontend/src/components/user

RunResidueCheck \
    "legacy admin password reset governance" \
    "legacy admin password reset governance residue detected" \
    '\b(?:reset-pwd|AdminResetPwdDto|AdminResetUserPasswordRequest|adminResetPassword|encodeAdminResetPasswordRequest|UserResetPasswordDialog|resetDialog|canSubmitResetPassword|handleResetSubmit)\b|重置密码|新密码' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/frontend/src/views/admin src/frontend/src/components/admin src/frontend/src/composables src/frontend/src/api/admin.ts src/backend/Modules/Endpoints

RunResidueCheck \
    "legacy username public display fallback" \
    "legacy username public display fallback residue detected" \
    '\b(?:PublicHandle|publicHandle|public_handle|AnonymousDisplayName|anonymousDisplayName|anonymous_display_name)\b\s*(?:[?][?]|\|\|)\s*[^;\n]*(?:Username|username)\b|\b(?:Username|username)\b\s*(?:[?][?]|\|\|)\s*[^;\n]*(?:PublicHandle|publicHandle|public_handle)\b|[.]Select[(]u\s*=>\s*u[.]Username[)]|NormalizeToken[(]username' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend/Services/Security src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs src/frontend/src/views src/frontend/src/components src/frontend/src/api/comment.ts

RunResidueCheck \
    "legacy anonymous comment user-bound creation" \
    "legacy anonymous comment user-bound creation residue detected" \
    '\bCreateCommentAsync[(]\s*userId\b|\bCreateCommentV2Async[(]|\b(?:AedsFrameType|FrameType)[.]CommentCreateV2Request\b' \
    "$IDENTITY_MAINTENANCE_ALLOW_PATH_REGEX" \
    src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs src/frontend/src/api/comment.ts

RunResidueCheck \
    "role-based admin authorization checks" \
    "role-based admin authorization residue detected" \
    'IsInRole[(]\s*["'\'']admin["'\''][)]|FindFirst[(]\s*ClaimTypes[.]Role\s*[)]|RequireRole[(]\s*["'\'']admin["'\''][)]|Authorize[(][^)]*Roles\s*=|RolesAuthorizationRequirement|new\s*[(]\s*ClaimTypes[.]Role\s*,\s*["'\'']admin["'\'']|new[(]ClaimTypes[.]Role\s*,\s*["'\'']admin["'\''][)]|PolicyRequiresAdminRole|ContainsAdminRole' \
    "" \
    src/backend

RunResidueCheck \
    "legacy authoring user attribution" \
    "legacy authoring user attribution residue detected" \
    'SaveDraftAsync[(]\s*context[.]GetUserId[(][)]|GetDraftAsync[(]\s*context[.]GetUserId[(][)]|DiscardDraftAsync[(]\s*context[.]GetUserId[(][)]|RollbackRevisionAsync[(]\s*context[.]GetUserId[(][)]|OwnerUserId|owner_user_id|CreatedByUserId|created_by_user_id|createdByUserId' \
    '^(src/migration/Definitions/[^/]+MigrationDefinitions[.]cs)$' \
    src/backend/Modules/Endpoints/AuthoringEndpoints.cs src/backend/Services/Authoring src/backend/Services/ArticleService.cs src/backend/Entities/Article.cs src/backend/Models/Dtos/AuthoringDtos.cs src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs src/migration/Definitions src/frontend/src/api/authoring.ts src/frontend/src/components/admin/article/ArticleRevisionPanel.vue

RunResidueCheck \
    "legacy comment moderation account display fallback" \
    "legacy comment moderation account display fallback residue detected" \
    'Queryable<Comment,\s*Article,\s*User|JoinType[.]Left,\s*c[.]UserId\s*==\s*u[.]Id|JoinType[.]Left,\s*c[.]ReplyToUserId\s*==\s*ru[.]Id|u[.]PublicHandle|ru[.]PublicHandle|u[.]Username|ru[.]Username|row[.]UserName|comment[.]userName|cleanText[(]item[.]userName[)]|accountSearchText' \
    "" \
    src/backend/Services/Authoring src/frontend/src/composables/useCommentModerationQueue.ts

RunResidueCheck \
    "legacy comment moderation user attribution" \
    "legacy comment moderation user attribution residue detected" \
    'ModerateCommentAsync[(]\s*int\s+actorUserId|ModerateCommentsAsync[(][^)]*int\s+actorUserId|ModeratedByUserId|moderatedByUserId|moderated_by_user_id|ModeratedByUserId\s*==\s*actorUserId|ModerateCommentAsync[(]\s*context[.]GetUserId[(][)]|ModerateCommentsAsync[(]\s*context[.]GetUserId[(][)]' \
    '^(src/migration/Definitions/[^/]+MigrationDefinitions[.]cs|tests/backend/Integration/SchemaMigrationIntegrationTests[.]cs)$' \
    src/backend/Entities/Comment.cs src/backend/Services/Authoring src/backend/Modules/Endpoints/AuthoringEndpoints.cs src/backend/Models/Dtos/AuthoringDtos.cs src/migration/Definitions src/frontend/src/api/authoring.ts src/frontend/src/composables/useCommentModerationQueue.ts src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue tests/backend/Integration/SchemaMigrationIntegrationTests.cs

RunResidueCheck \
    "legacy anonymous credential user commitment binding" \
    "legacy anonymous credential user commitment binding residue detected" \
    'public[[:space:]]+int[?]?[[:space:]]+UserId\b|ColumnName[[:space:]]*=[[:space:]]*["'\'']user_id["'\'']|CommitmentHash|commitment_hash|ZkCommitment|zk_commitment|IssueAsync[(][^)]*userId[^)]*commitmentHash|GetActiveCredentialAsync[(]|GetCredentialLevelAsync[(]' \
    "" \
    src/backend/Entities/AnonymousCredential.cs src/backend/Services/Security/AnonymousCredentialService.cs

RunResidueCheck \
    "legacy frontend admin fallbacks" \
    "legacy frontend admin fallback residue detected" \
    'legacy[.]admin|syncLegacyAdminPrincipal|userInfo[.]role\s*={2,3}\s*["'\'']admin["'\'']|user[?]?[.]role\s*={2,3}\s*["'\'']admin["'\'']' \
    "" \
    src/frontend/src

RunResidueCheck \
    "legacy anonymous identity frontend id contract" \
    "legacy anonymous identity frontend id contract residue detected" \
    'internalUserId|InternalUserId|export[[:space:]]+interface[[:space:]]+RecoveryKeyVerifyResponse[[:space:]]*\{[^}]*userId|const[[:space:]]+userId[[:space:]]*=[[:space:]]*readInt32[(]payload,[[:space:]]*0[)]|user[?][.]id' \
    "" \
    src/core/Mapping/Models/ReadModels.cs src/shared/Contracts/Models/UserPods.cs src/backend/Services/UserService.Ports.cs src/core/Cache/PodBinaryCodec.User.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts src/frontend/src/views/user/IdentityCenter.vue

RunResidueCheck \
    "legacy user session raw ip output contract" \
    "legacy user session raw IP output residue detected" \
    '\blastIp\b|session[.]lastIp|formatSessionIp|readFixedUtf8[(]pod,\s*204,\s*64[)]|LastIp[[:space:]]*=[[:space:]]*s[.]LastIp|s[.]LastIp[[:space:]]*[?][?][[:space:]]*"unknown"|IP：' \
    "" \
    src/core/Cache/PodBinaryCodec.User.cs src/backend/Services/UserService.cs src/frontend/src/api/auth.ts src/frontend/src/adapters/binary/authAdapter.ts src/frontend/src/views/user/IdentityCenter.vue

RunResidueCheck \
    "retired cleanup and HumanRead source-reading tests" \
    "retired cleanup/HumanRead source-reading test residue detected" \
    '\b(?:LogCleanupServiceTests|UploadSessionCleanupQueueTests|HumanReadProofServiceTests)\b|\bBackendTestPaths[.](?:ReadAllTextFromRoot|PathFromRoot|FromRoot|RepositoryRoot)\b|\bFile[.](?:ReadAllText(?:Async)?|ReadAllLines(?:Async)?|OpenText)[(]|\b(?:ReadSource|ReadRepoFile|ReadProductionFile)[(]' \
    "" \
    tests/backend/Unit/LogCleanupServiceTests.cs \
    tests/backend/Unit/UploadSessionCleanupQueueTests.cs \
    tests/backend/Unit/HumanReadProofServiceTests.cs \
    tests/backend/Unit/LogCleanupDatabaseBehaviorTests.cs \
    tests/backend/Unit/LogCleanupWorkerBehaviorTests.cs \
    tests/backend/Unit/UploadSessionCleanupQueueBehaviorTests.cs \
    tests/backend/Unit/UploadSessionCleanupWorkerBehaviorTests.cs \
    tests/backend/Unit/HumanReadProofSubmissionBehaviorTests.cs \
    tests/backend/Unit/HumanReadProofRequestBindingTests.cs \
    tests/backend/Unit/HumanReadProofPersistencePrivacyTests.cs \
    tests/backend/Helpers/TestInfrastructure/HumanReadProofTestHarness.cs

RunResidueCheck \
    "human-read visit user binding" \
    "human-read visit user-bound residue detected" \
    'context[.]GetUserId[(][)]|VisitLogMessage[(][^;\n]*UserId|msg[.]UserId|public[[:space:]]+int[?][[:space:]]+UserId\b|new[[:space:]]+VisitLog[[:space:]]*[{][^}]*UserId[[:space:]]*=|\bRegisteredVisits\b|\bAnonymousVisits\b|registeredVisits|anonymousVisits|v[.]UserId' \
    '^(src/migration/Definitions/[^/]+MigrationDefinitions[.]cs|src/backend/Infrastructure/SchemaMigration/SchemaMigrationConsistencyChecker[.]cs)$' \
    src/backend/Entities/VisitLog.cs src/backend/Services/HumanReadProofService.cs src/backend/Services/VisitLog src/backend/Services/StatsService.cs src/backend/Infrastructure/CoreBridge src/backend/Infrastructure/Cache src/shared/Contracts src/core src/frontend/src tests/frontend/fixtures

RunResidueCheck \
    "human-read raw visit ip persistence" \
    "human-read raw visit-ip persistence residue detected" \
    'public[[:space:]]+string[?]?[[:space:]]+IP\b|SugarColumn[(][^;\n]*ColumnName[[:space:]]*=[[:space:]]*["'\'']ip["'\'']|EnsureColumnStep[(][^;\n]*["'\'']sys_visit_log["'\''][^;\n]*["'\'']ip["'\'']|ADD COLUMN IF NOT EXISTS ip\b|new[[:space:]]+VisitLog[[:space:]]*[{][^}]*IP[[:space:]]*=|IP[[:space:]]*=[[:space:]]*(?:msg[.]IP|ip)\b|sys_visit_log[."]ip\b' \
    '^(src/migration/Definitions/[^/]+MigrationDefinitions[.]cs)$' \
    src/backend/Entities/VisitLog.cs src/backend/Services/VisitLog/VisitLogProcessorService.cs src/migration/Definitions

RunResidueCheck \
    "message legacy user identity sync coupling" \
    "message legacy user identity sync residue detected" \
    '(initiatoruserid|senderid|userid).*identity_sync' \
    "" \
    src/backend

RunResidueCheck \
    "stats recent comment user identity" \
    "stats recent comment user identity residue detected" \
    'LeftJoin<User>|u[.]Username|u[.]Id|GetOrdinal[(]["'\'']Username["'\''][)]|RecentCommentStatItemDto[(][^;\n]*(?:UserId|UserName)|RecentCommentCoreModel[(][^;\n]*(?:UserId|UserName)|ProjectRecentComment[(][^;\n]*(?:userId|userName)|UserId = userId|public readonly int UserId;|HasUserId|item[.]UserId|item[.]UserName|reader[.]readSpan[(]32[)]|comment[.]userName|userId:|userName:' \
    '' \
    src/backend/Services/StatsService.cs src/shared/Contracts/Outputs/ServerResponseContracts.cs src/shared/Contracts/Models/StatsPods.cs src/core/Mapping/Models/ReadModels.cs src/core/Mapping/Projectors/PodProjector.cs src/core/Cache/PodBinaryCodec.Stats.cs src/backend/Infrastructure/CoreBridge/Adapters/StatsServiceCoreAdapter.cs src/backend/Infrastructure/CoreBridge/Gateways/StatsCoreGateway.cs src/frontend/src/api/stats.ts src/frontend/src/adapters/binary/statsAdapter.ts src/frontend/src/view-contracts/adminStats.ts

echo "[residue-check] passed"
