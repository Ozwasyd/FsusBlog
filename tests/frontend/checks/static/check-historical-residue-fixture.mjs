#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const checkerPath = path.join(repoRoot, 'tools/check-historical-residue.sh')
const runtimeBridgePath = `/_fsus/internal/${'binary-bridge'}/author`
const runtimeBridgeError = ['authoring', 'legacy', 'envelope', 'invalid'].join('_')
const runtimeBridgeMethod = ['BridgeToLegacy', 'Authoring', 'EndpointAsync'].join('')

const violationCases = [
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
  }
]

const allowedMaintenanceFixture = {
  'docs/database-migration.md': `
Legacy migration notes may mention /api/binary/auth/login, AuthLoginRequest, username, password, and sys_user while documenting residue removal.
`,
  'src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation.cs': `
namespace FsusBlog.Server.Infrastructure.Operations;
internal sealed class LegacyIdentityColdStartResetOperation
{
    private const string Confirmation = "FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS";
}
`,
  'tools/db/verify-legacy-upgrade-20260517.sh': `
#!/usr/bin/env bash
set -euo pipefail
: "\${FSUS_LEGACY_20260517_DUMP_GZ:?legacy dump required}"
`,
  'tests/backend/Fixtures/legacy-20260517-minimal.sql': `
CREATE TABLE sys_user(id bigint primary key);
`
}

function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content.trimStart())
  }
}

function runChecker(root) {
  return spawnSync('bash', [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_HISTORICAL_RESIDUE_ROOT: root
    }
  })
}

function fail(message, result) {
  console.error(`[historical-residue-fixture] ${message}`)
  if (result) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    if (output) {
      console.error(output)
    }
  }
  process.exit(1)
}

function createFixtureRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name.replaceAll(/\W+/g, '-')}-`))
}

for (const testCase of violationCases) {
  const fixtureRoot = createFixtureRoot(testCase.name)
  writeFiles(fixtureRoot, testCase.files)
  const result = runChecker(fixtureRoot)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status === 0) {
    fail(`expected ${testCase.name} fixture to fail`, result)
  }
  if (!output.includes(testCase.expected)) {
    fail(`expected ${testCase.name} output to include "${testCase.expected}"`, result)
  }
}

const allowedRoot = createFixtureRoot('allowed-maintenance')
writeFiles(allowedRoot, allowedMaintenanceFixture)
const allowedResult = runChecker(allowedRoot)
if (allowedResult.status !== 0) {
  fail('expected identity reset and database migration maintenance fixture to pass', allowedResult)
}

console.log(`[historical-residue-fixture] ok cases=${violationCases.length}`)
