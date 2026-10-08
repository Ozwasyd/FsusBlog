#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const checkerPath = path.join(repoRoot, 'tools/check-historical-residue.sh');
const runtimeBridgePath = `/_fsus/internal/${'binary-bridge'}/author`;
const runtimeBridgeError = ['authoring', 'legacy', 'envelope', 'invalid'].join('_');
const runtimeBridgeMethod = ['BridgeToLegacy', 'Authoring', 'EndpointAsync'].join('');

const violationCases = [
    {
        name: 'forced client account override in a frontend comment object',
        expected: 'retired comment-create account override residue detected',
        files: {
            'src/frontend/src/api/comment.ts': 'const request = { articleId: 42, content: "reply", replyToUserId: 7 }; createComment(request);'
        }
    },
    {
        name: 'retired account slot restored in the canonical request model',
        expected: 'retired comment-create account override residue detected',
        files: {
            'src/core/Mapping/Models/CommentCreateRequest.Generated.cs': 'public readonly record struct CommentCreateRequestCoreModel(long? ReplyToUserId);'
        }
    },
    {
        name: 'retired JSON comment writer behind a canonical function name',
        expected: 'old comment-create V1 residue detected',
        files: {
            'src/frontend/src/api/comment.ts': `export function createComment(dto) { return fetch('/api/Comment', { method: 'POST', body: JSON.stringify(dto) }); }`
        }
    },
    {
        name: 'versioned current comment alias',
        expected: 'old comment-create V1 residue detected',
        files: {
            'src/frontend/src/api/comment.ts': 'export type CommentCreateV2Dto = CommentCreateDto;'
        }
    },
    {
        name: 'legacy runtime bridge names',
        expected: 'legacy runtime bridge residue detected',
        files: {
            'src/backend/Compatibility/RuntimeBridgeResidue.cs': `
namespace FsusBlog.Server.Compatibility;
internal static class RuntimeBridgeResidue
{
    private const string AuthoringPrefix = "${runtimeBridgePath}";
    private const string Error = "${runtimeBridgeError}";
    private static void ${runtimeBridgeMethod}() {}
}
`
        }
    },
    {
        name: 'old comment-create V1 paths',
        expected: 'old comment-create V1 residue detected',
        files: {
            'src/frontend/src/api/commentV1.ts': `
export const COMMENT_V1_PATH = '/api/Comment'
export type CommentCreateRequest = { articleId: string; content: string }
export function createCommentV1(dto: CommentCreateRequest) {
  return fetch(COMMENT_V1_PATH, { method: 'POST', body: JSON.stringify(dto) })
}
`
        }
    },
    {
        name: 'notification stream legacy target names',
        expected: 'notification stream legacy target residue detected',
        files: {
            'src/backend/Infrastructure/NotificationStream/NotificationStreamTargets.cs': `
namespace FsusBlog.Server.Infrastructure.NotificationStream;
internal static class NotificationStreamTargets
{
    public const string Legacy = "authenticated-users";
    public const string Group = "NotificationStreamGroups";
}
`
        }
    },
    {
        name: 'frontend retired identifiers',
        expected: 'frontend retired identifier residue detected',
        files: {
            'src/frontend/src/store/retiredExports.ts': `
export const setUserInfo = () => undefined
export interface RiskControlPolicyUpdateRequest { poSpaceV1Enabled: boolean }
export const createComment = () => undefined
export const retiredPage = 'About.vue'
`
        }
    },
    {
        name: 'retired persisted binary transport toggle',
        expected: 'retired persisted binary transport toggle residue detected',
        files: {
            'src/frontend/src/store/article.ts': `
export const persistedTransportKey = ['fsus', 'transport', 'binary'].join('.')
export const useBinary = readBinaryFlag(persistedTransportKey)
export const store = useArticleBinaryStore('article-binary')
`
        }
    },
    {
        name: 'retired backend cleanup symbols',
        expected: 'retired backend cleanup symbol residue detected',
        files: {
            'src/backend/Infrastructure/Cache/LegacyMessageCache.cs': `
public sealed record CreateConversationRequest(long RecipientId)
public sealed record SearchArticlesRequest(string Query)
public Task DecrementUnreadAsync(long accountId) => Task.CompletedTask;
public const CachePolicyId Policy = CachePolicyId.MessageGlobalVersion;
`
        }
    },
    {
        name: 'old author-mode aliases',
        expected: 'old author-mode alias residue detected',
        files: {
            'src/frontend/src/components/article/AuthorModeAlias.ts': `
export const authorModeAliases = {
  authorMode: 'guest',
  defaultAuthorMode: 'incognito'
}
`
        }
    },
    {
        name: 'old UI fixture fallbacks',
        expected: 'old UI fixture fallback residue detected',
        files: {
            'tests/frontend/fixtures/legacy-ui-fixture-fallback.ts': `
export const uiFixtureFallback = 'legacy-ui-fixture-fallback'
export const fallbackComponentRoot = 'src/frontend/src/components/ui/FsusUiFallbackFixtures'
`
        }
    },
    {
        name: 'old local package type shims',
        expected: 'old local package type shim residue detected',
        files: {
            'src/frontend/src/types/fsusui-local-shim.d.ts': `
${'declare'} module '@ozwasyd/element-plus' {
  export const LocalPackageTypeShim: unknown
}
`
        }
    },
    {
        name: 'old algorithm fallback switches',
        expected: 'old algorithm fallback switch residue detected',
        files: {
            'src/backend/Infrastructure/Helpers/Security/LegacyModernAcAutomaton.cs': `
namespace FsusBlog.Server.Infrastructure.Helpers.Security;
internal sealed class LegacyModernAcAutomaton
{
    private const string LegacyFeatureSwitchName = "FsusBlog.Security.ModernAcAutomaton.UseLegacyChildRange";
    private const string LegacyFeatureEnvName = "FSUSBLOG_SECURITY_MODERN_AC_USE_LEGACY_CHILD_RANGE";
}
`
        }
    },
    {
        name: 'legacy anonymous account auth contracts',
        expected: 'legacy anonymous account auth contract residue detected',
        files: {
            'src/frontend/src/api/authLegacy.ts': `
import { FrameType } from '@wasm/protocol/frame'
export interface LoginDto { username: string; password: string }
export function loginWithPassword() {
  return { binaryUrl: '/api/binary/auth/login', frameType: FrameType.AuthLoginRequest }
}
export function registerWithPassword() {
  return { binaryUrl: '/api/binary/auth/register', frameType: FrameType.AuthRegisterRequest }
}
`
        }
    },
    {
        name: 'legacy password auth protocol frames',
        expected: 'legacy password auth protocol frame residue detected',
        files: {
            'src/shared/Contracts/Validation/aeds-protocol.json': `
{
  "schemaVersion": 1,
  "header": { "size": 16, "magic": "0x53444541", "version": 2 },
  "frameTypes": [
    { "name": "AuthLoginRequest", "value": 43 },
    { "name": "AuthRegisterRequest", "value": 44 },
    { "name": "AuthUpdatePasswordRequest", "value": 46 }
  ]
}
`,
            'src/frontend/src/api/auth.ts': `
export function encodeAuthUpdatePasswordRequest(data) {
  return encodeStringMutationRequest(data.newUsername)
}
`
        }
    },
    {
        name: 'passkey sensitive frontend logs',
        expected: 'passkey sensitive frontend log residue detected',
        files: {
            'src/frontend/src/composables/usePasskeyLogin.ts': `
export async function loginWithPasskey() {
  const beginResp = await passkeyLoginBegin()
  console.log('[Passkey] beginResp:', beginResp)
  console.log('[Passkey] startAuthentication with options:', beginResp.options)
  const assertion = await startAuthentication(beginResp.options)
  console.log('[Passkey] assertion received:', assertion)
  alert('通行密钥启动失败：WebAuthn low-level detail')
}
`,
            'src/frontend/src/composables/usePasskeyManagement.ts': `
export async function addPasskey() {
  const rawList = await listPasskeys()
  console.log('[Passkey] list raw:', rawList)
  const beginResp = await passkeyRegisterBegin()
  console.log('[Passkey] register beginResp:', beginResp)
  console.error('[Passkey] startRegistration error:', new Error('attestation'))
}
`
        }
    },
    {
        name: 'frontend public handle username semantics',
        expected: 'frontend public handle username-semantic residue detected',
        files: {
            'src/frontend/src/views/auth/Register.vue': `
<template>
  <el-input
    v-model="publicHandle"
    name="publicHandle"
    autocomplete="username"
  />
</template>
`,
            'src/frontend/src/composables/useAnonymousOnboarding.ts': `
import { USERNAME_CONSTRAINT, validateUsername } from '@/utils/contentFilter'

export function validatePublicProfile(value) {
  return validateUsername(value).message || USERNAME_CONSTRAINT.patternMessage
}
`
        }
    },
    {
        name: 'legacy plain auth cookie fallback',
        expected: 'legacy plain auth cookie fallback residue detected',
        files: {
            'src/backend/Infrastructure/Auth/AuthCookieService.cs': `
namespace FsusBlog.Server.Infrastructure.Auth;
internal sealed class AuthCookieService
{
    private const string RefreshTokenCookieName = "RefreshToken";
    private const string HostRefreshTokenCookieName = "__Host-RefreshToken";
    public string? ReadRefreshToken(HttpContext context)
        => ReadCookie(context, RefreshTokenCookieName, HostRefreshTokenCookieName);
}
`,
            'src/backend/Infrastructure/Helpers/JwtHelper.cs': `
namespace FsusBlog.Server.Infrastructure.Helpers;
internal static class JwtHelper
{
    public static void Read(HttpContext context)
    {
        if (context.Request.Cookies.TryGetValue("AccessToken", out var token)) {}
        if (context.Request.Cookies.TryGetValue("AdminAccessToken", out var adminToken)) {}
    }
}
`
        }
    },
    {
        name: 'message legacy user identity sync coupling',
        expected: 'message legacy user identity sync residue detected',
        files: {
            'src/backend/Infrastructure/SchemaMigration/MessageLegacyIdentitySyncResidue.cs': `
namespace FsusBlog.Server.Infrastructure.SchemaMigration;
internal static class MessageLegacyIdentitySyncResidue
{
    private const string Sql = "initiatoruserid still feeds identity_sync";
}
`
        }
    },
    {
        name: 'legacy password login form',
        expected: 'legacy password login form residue detected',
        files: {
            'src/frontend/src/views/auth/Login.vue': `
<template>
  <form @submit.prevent="handlePasswordLogin">
    <el-input v-model="username" name="username" />
    <el-input v-model="password" name="password" type="password" />
  </form>
</template>
`
        }
    },
    {
        name: 'legacy user profile credential fields',
        expected: 'legacy user profile credential residue detected',
        files: {
            'src/frontend/src/views/user/Profile.vue': `
<script setup lang="ts">
const passwordForm = { profileOldPassword: '', profileNewPassword: '', profileConfirmPassword: '' }
const updatePassword = () => passwordForm.profileNewPassword
</script>
`
        }
    },
    {
        name: 'legacy shared user snapshot contract',
        expected: 'legacy shared user snapshot contract residue detected',
        files: {
            'src/shared/Contracts/AuthSystem/AuthSystemContracts.cs': `
namespace FsusBlog.Shared.Contracts.AuthSystem;
public readonly record struct UserSnapshotContract(
    int Id,
    string Username,
    string Role,
    string? LastLoginIp);
`
        }
    },
    {
        name: 'legacy sys_user identity field names',
        expected: 'legacy sys_user identity field residue detected',
        files: {
            'src/backend/Entities/User.cs': `
using SqlSugar;
namespace FsusBlog.Server.Entities;
public class User
{
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string Role { get; set; } = "guest";
    public DateTime? LastUsernameUpdateTime { get; set; }
}
`
        }
    },
    {
        name: 'legacy appsettings admin identity fields',
        expected: 'legacy appsettings admin identity field residue detected',
        files: {
            'appsettings.Production.json': `
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=db;Database=fsusblog;Username=fsusblog;Password=secret"
  },
  "Admin": {
    "Username": "admin",
    "Password": "legacy-password",
    "Role": "admin"
  }
}
`,
            'src/backend/appsettings.Flattened.json': `
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=db;Database=fsusblog;Username=fsusblog;Password=secret"
  },
  "Admin:Username": "admin",
  "Admin__Password": "legacy-password",
  "Admin:Role": "admin"
}
`
        }
    },
    {
        name: 'legacy role admin account protection',
        expected: 'legacy sys_user identity field residue detected',
        files: {
            'src/backend/Services/UserService.cs': `
namespace FsusBlog.Server.Services;
internal sealed class UserService
{
    public bool Protect(User user) => user.Role == "admin";
}
`
        }
    },
    {
        name: 'role-based admin authorization checks',
        expected: 'role-based admin authorization residue detected',
        files: {
            'src/backend/Infrastructure/Helpers/JwtHelper.cs': `
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization.Infrastructure;
namespace FsusBlog.Server.Infrastructure.Helpers;
internal static class JwtHelperRoleResidue
{
    private static readonly Claim Role = new(ClaimTypes.Role, "admin");
    private static bool PolicyRequiresAdminRole(RolesAuthorizationRequirement requirement)
        => requirement.AllowedRoles.Contains("admin");
}
`,
            'src/backend/Modules/Endpoints/Binary/RoleAdminResidue.cs': `
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
namespace FsusBlog.Server.Modules.Endpoints.Binary;
[Authorize(Roles = "admin")]
internal static class RoleAdminResidue
{
    public static void Map(IEndpointRouteBuilder group)
    {
        group.MapGet("/role-admin", () => "bad")
            .RequireAuthorization(policy => policy.RequireRole("admin"));
        _ = new RolesAuthorizationRequirement(new[] { "admin" });
        _ = new Claim(ClaimTypes.Role, "admin");
    }
}
`
        }
    },
    {
        name: 'legacy authoring user attribution',
        expected: 'legacy authoring user attribution residue detected',
        files: {
            'src/backend/Services/Authoring/AuthoringWorkflowService.cs': `
internal sealed class AuthoringWorkflowService
{
    public void Save(ArticleDraft draft, ArticleRevision revision)
    {
        draft.OwnerUserId = 7;
        revision.CreatedByUserId = 7;
    }
}
`,
            'src/backend/Modules/Endpoints/AuthoringEndpoints.cs': `
internal static class AuthoringEndpoints
{
    public static void Map(HttpContext context, AuthoringWorkflowService service)
    {
        service.SaveDraftAsync(context.GetUserId(), request, token);
        service.RollbackRevisionAsync(context.GetUserId(), articleId, revisionId, token);
    }
}
`,
            'src/frontend/src/api/authoring.ts': `
export interface ArticleRevisionSummaryResponse {
  createdByUserId: number
}
`,
            'src/frontend/src/components/admin/article/ArticleRevisionPanel.vue': `
<template>{{ revision.createdByUserId }}</template>
`
        }
    },
    {
        name: 'legacy comment moderation account display fallback',
        expected: 'legacy comment moderation account display fallback residue detected',
        files: {
            'src/backend/Services/Authoring/AuthoringWorkflowService.cs': `
internal sealed class AuthoringWorkflowService
{
    private object Load()
        => db.Queryable<Comment, Article, User, User>((c, a, u, ru) => new object[]
        {
            JoinType.Left, c.UserId == u.Id,
            JoinType.Left, c.ReplyToUserId == ru.Id
        })
        .Select((c, a, u, ru) => new
        {
            UserName = c.AnonymousDisplayName ?? c.PublicHandle ?? u.PublicHandle,
            ReplyToUserName = ru.PublicHandle
        });

    private string Notify(Row row) => row.UserName;
}
`,
            'src/frontend/src/components/admin/DashboardCommentModerationPanel.vue': `
<template>{{ comment.userName }}</template>
`,
            'src/frontend/src/composables/useCommentModerationQueue.ts': `
const actorDisplayName = cleanText(item.userName) ?? '未署名用户'
const accountSearchText = item.userName ?? ''
`
        }
    },
    {
        name: 'legacy public comment read identity fields',
        expected: 'legacy public comment read identity field residue detected',
        files: {
            'src/shared/Contracts/Outputs/ServerResponseContracts.cs': `
namespace FsusBlog.Shared.Contracts.Outputs;
public readonly record struct CommentReplyItemDto(
    string Id,
    string Content,
    string UserName,
    int? ReplyToUserId,
    string? ReplyToUserName);
`,
            'src/frontend/src/view-contracts/commentDetail.ts': `
export interface CommentThreadItemContract {
  readonly userName?: string
}
`
        }
    },
    {
        name: 'docs api contracts legacy identity json examples',
        expected: 'docs api contracts legacy identity JSON example residue detected',
        files: {
            'docs/api/contracts.md': `
### IdentityAccountSnapshot

\`\`\`json
{
  "accountId": 42,
  "internalUserId": 42
}
\`\`\`

### CommentReplyItemDto

\`\`\`json
{
  "id": "202",
  "userName": "bob",
  "replyToUserName": "alice"
}
\`\`\`
`
        }
    },
    {
        name: 'legacy comment moderation user attribution',
        expected: 'legacy comment moderation user attribution residue detected',
        files: {
            'src/backend/Services/Authoring/AuthoringWorkflowService.cs': `
internal sealed class AuthoringWorkflowService
{
    public Task<bool> ModerateCommentAsync(int actorUserId, long commentId, CommentModerationRequest request)
        => db.Updateable<Comment>()
            .SetColumns(it => it.ModeratedByUserId == actorUserId)
            .ExecuteCommandAsync();
}
`,
            'src/backend/Modules/Endpoints/AuthoringEndpoints.cs': `
internal static class AuthoringEndpoints
{
    public static Task Handle(HttpContext context, AuthoringWorkflowService service)
        => service.ModerateCommentAsync(context.GetUserId(), 1, request);
}
`,
            'src/frontend/src/api/authoring.ts': `
export interface CommentModerationItemResponse {
  moderatedByUserId: number | null
}
`
        }
    },
    {
        name: 'legacy anonymous credential user commitment binding',
        expected: 'legacy anonymous credential user commitment binding residue detected',
        files: {
            'src/backend/Entities/AnonymousCredential.cs': `
public sealed class AnonymousCredential
{
    [SugarColumn(ColumnName = "user_id")]
    public int? UserId { get; set; }
    public string CommitmentHash { get; set; } = "";
}

public static class AnonymousCredentialTypes
{
    public const string ZkCommitment = "zk_commitment";
}
`,
            'src/backend/Services/Security/AnonymousCredentialService.cs': `
public interface IAnonymousCredentialService
{
    Task<AnonymousCredential> IssueAsync(int? userId, string commitmentHash);
    Task<AnonymousCredential?> GetActiveCredentialAsync(int? userId, string? commitmentHash = null);
    Task<string?> GetCredentialLevelAsync(int? userId, string? commitmentHash = null);
}
`
        }
    },
    {
        name: 'legacy admin password reset governance',
        expected: 'legacy admin password reset governance residue detected',
        files: {
            'src/frontend/src/views/admin/UserManage.vue': `
<script setup lang="ts">
const adminResetPassword = () => '重置密码'
const dialog = 'UserResetPasswordDialog'
</script>
`
        }
    },
    {
        name: 'legacy username public display fallback',
        expected: 'legacy username public display fallback residue detected',
        files: {
            'src/backend/Services/Security/CommentActorResolver.cs': `
namespace FsusBlog.Server.Services.Security;
internal static class CommentActorResolver
{
    public static string Resolve(User user) => user.PublicHandle ?? user.Username;
}
`
        }
    },
    {
        name: 'legacy anonymous comment user-bound creation',
        expected: 'legacy anonymous comment user-bound creation residue detected',
        files: {
            'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs': `
namespace FsusBlog.Server.Modules.Endpoints.Binary;
internal static class BinaryEndpoints
{
    private static Task<bool> HandleAnonymousCommentCreateAsync(ICommentService service, int userId, int articleId, string content)
        => service.CreateCommentAsync(userId, articleId, content);
}
`
        }
    },
    {
        name: 'legacy message center user vocabulary',
        expected: 'legacy message sender user-model residue detected',
        files: {
            'src/backend/Services/NotificationStream/MessageCenterService.cs': `
namespace FsusBlog.Server.Services.NotificationStream;
internal sealed class MessageCenterService
{
    public Task CreateUserTicketAsync(int accountId) => Task.CompletedTask;
    public Task ReplyAsUserAsync(int accountId) => Task.CompletedTask;
    private const string Sender = "MessageSenderType.User";
}
`,
            'src/frontend/src/api/message.ts': `
export const messageApi = {
  getUserConversations() {},
  createUserConversation() {}
}
`
        }
    },
    {
        name: 'legacy anonymous identity frontend id contract',
        expected: 'legacy anonymous identity frontend id contract residue detected',
        files: {
            'src/frontend/src/api/auth.ts': `
export interface CurrentUserSnapshot {
  accountId: number
  internalUserId: number
}

export interface RecoveryKeyVerifyResponse {
  userId: number
  recoverySessionToken: string
}
`,
            'src/frontend/src/adapters/binary/authAdapter.ts': `
export function mapRecoveryKeyVerifyResponseFromPayload(payload: Uint8Array) {
  const userId = readInt32(payload, 0)
  return { userId }
}
`,
            'src/frontend/src/views/user/IdentityCenter.vue': `
const accountId = user?.id ?? 0
`
        }
    },
    {
        name: 'retired cleanup HumanRead mixed suite',
        expected: 'retired cleanup/HumanRead source-reading test residue detected',
        files: {
            'tests/backend/Unit/UploadSessionCleanupQueueTests.cs': `
namespace FsusBlog.Tests.Unit;
public sealed class UploadSessionCleanupQueueTests
{
    public void SourceUsesWaitModeAndRetriesOverflowAfterCleanup() {}
}
`
        }
    },
    {
        name: 'cleanup HumanRead behavior source reader',
        expected: 'retired cleanup/HumanRead source-reading test residue detected',
        files: {
            'tests/backend/Unit/HumanReadProofSubmissionBehaviorTests.cs': `
namespace FsusBlog.Tests.Unit;
public sealed class HumanReadProofSubmissionBehaviorTests
{
    public string ReadImplementation() => File.ReadAllText(
        BackendTestPaths.PathFromRoot("src", "backend", "Services", "HumanReadProofService.cs"));
}
`
        }
    },
    {
        name: 'human-read visit user binding',
        expected: 'human-read visit user-bound residue detected',
        files: {
            'src/backend/Entities/VisitLog.cs': `
namespace FsusBlog.Server.Entities;
public class VisitLog
{
    public int? UserId { get; set; }
}
`
        }
    },
    {
        name: 'human-read raw visit ip persistence',
        expected: 'human-read raw visit-ip persistence residue detected',
        files: {
            'src/backend/Entities/VisitLog.cs': `
namespace FsusBlog.Server.Entities;
public class VisitLog
{
    public string? IP { get; set; }
}
`
        }
    }
];

const securityInvariantFixture = {
    'security/matrices/privacy-zk-comment.yml': `
requiredCases:
  - tamper-root
  - tamper-revocation-root
  - tamper-scope
  - tamper-non-current-layout
requiredFields:
  - tamper-scope
  - tamper-root
  - tamper-revocation-root
  - tamper-non-current-layout
`,
    'security/zk/contracts/comment-v5-tamper-cases.manifest.json': `
{
  "tamper_cases": [
    { "id": "tamper-root", "expected": "reject" },
    { "id": "tamper-revocation-root", "expected": "reject" },
    { "id": "tamper-scope", "expected": "reject" },
    { "id": "tamper-non-current-layout", "expected": "reject" }
  ]
}
`
};

const allowedMaintenanceFixture = {
    'appsettings.Production.example.json': `
{
  "ConnectionStrings": {
    "_Comment": "PostgreSQL Username=/Password= are Npgsql connection string aliases, not application identity fields.",
    "DefaultConnection": "Host=db;Database=fsusblog;Username=fsusblog;Password=secret",
    "_LibpqUrlExample": "postgresql://fsusblog:secret@db:5432/fsusblog"
  }
}
`,
    'docs/database-migration.md': `
Legacy migration notes may mention /api/binary/auth/login, AuthLoginRequest, username, password, and sys_user while documenting residue removal.
`,
    'tools/db/verify-legacy-upgrade-20260517.sh': `
#!/usr/bin/env bash
set -euo pipefail
: "\${FSUS_LEGACY_20260517_DUMP_GZ:?legacy dump required}"
`,
    'tests/backend/Fixtures/legacy-20260517-minimal.sql': `
CREATE TABLE sys_user(id bigint primary key);
`,
    'src/backend/Infrastructure/NotificationStream/NotificationStreamTargets.cs': `
namespace FsusBlog.Server.Infrastructure.NotificationStream;
internal static class NotificationStreamTargetCollections
{
    public const string ContentFeed = "content-feed";
    public const string AdminUsers = "admin-users";
}
`,
    'src/backend/Infrastructure/NotificationStream/NotificationStreamAudienceResolver.cs': `
namespace FsusBlog.Server.Infrastructure.NotificationStream;
internal sealed class NotificationStreamAudienceResolver
{
    private static readonly string[] Targets = [NotificationStreamTargetCollections.ContentFeed];
}
`,
    'src/backend/Modules/Endpoints/NotificationStreamDrillEndpoints.cs': `
namespace FsusBlog.Server.Modules.Endpoints;
internal static class NotificationStreamDrillEndpoints
{
    private const string Target = "content-feed";
}
`,
    'src/frontend/src/api/comment.ts': `
export const createComment = () => undefined
export const createPublicComment = () => undefined
`,
    'src/frontend/src/public-renderers/publicRouteRegistry.ts': `
export const publicAboutRoute = {
  component: () => import('@/views/PublicDynamicPage.vue')
}
`,
    'tests/backend/Unit/HumanReadProofSubmissionBehaviorTests.cs': `
namespace FsusBlog.Tests.Unit;
public sealed class HumanReadProofSubmissionBehaviorTests
{
    public void SubmitAsync_ValidArticleProofWritesExactlyOneEvent() {}
}
`
};

function writeFiles(root, files)
{
    for (const [relativePath, content] of Object.entries(files))
    {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content.trimStart());
    }
}

function runChecker(root)
{
    return spawnSync('bash', [checkerPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_HISTORICAL_RESIDUE_ROOT: root
        }
    });
}

function fail(message, result)
{
    console.error(`[historical-residue-fixture] ${message}`);
    if (result)
    {
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
        if (output)
        {
            console.error(output);
        }
    }
    process.exit(1);
}

function createFixtureRoot(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name.replaceAll(/\W+/g, '-')}-`));
}

for (const testCase of violationCases)
{
    const fixtureRoot = createFixtureRoot(testCase.name);
    writeFiles(fixtureRoot, securityInvariantFixture);
    writeFiles(fixtureRoot, testCase.files);
    const result = runChecker(fixtureRoot);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0)
    {
        fail(`expected ${testCase.name} fixture to fail`, result);
    }
    if (!output.includes(testCase.expected))
    {
        fail(`expected ${testCase.name} output to include "${testCase.expected}"`, result);
    }
}

const allowedRoot = createFixtureRoot('allowed-maintenance');
writeFiles(allowedRoot, securityInvariantFixture);
writeFiles(allowedRoot, allowedMaintenanceFixture);
const allowedResult = runChecker(allowedRoot);
if (allowedResult.status !== 0)
{
    fail('expected identity reset and database migration maintenance fixture to pass', allowedResult);
}

console.log(`[historical-residue-fixture] ok cases=${violationCases.length}`);
