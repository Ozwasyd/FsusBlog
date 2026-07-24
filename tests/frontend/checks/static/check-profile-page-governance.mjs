#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const profilePath = path.join(repoRoot, 'src/frontend/src/views/user/Profile.vue')
const identityCenterPath = path.join(repoRoot, 'src/frontend/src/views/user/IdentityCenter.vue')
const identityCopyPath = path.join(repoRoot, 'src/frontend/src/locales/zh-CN/identity.ts')
const routerPath = path.join(repoRoot, 'src/frontend/src/router/appRouteRecords.ts')
const accountNavPath = path.join(repoRoot, 'src/frontend/src/layouts/accountNav.ts')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function lineOf(source, token) {
  const index = source.indexOf(token)
  if (index < 0) {
    return 1
  }

  return source.slice(0, index).split(/\r?\n/).length
}

const profile = read(profilePath)
const identityCenter = read(identityCenterPath)
const identityCopy = read(identityCopyPath)
const router = read(routerPath)
const accountNav = read(accountNavPath)

const forbiddenProfileTokens = [
  'eyebrow=',
  '管理身份信息、密码、MFA、通行密钥与活跃会话。',
  'profile-anchor-nav',
  'section-title::before',
  'section-title',
  'MFA',
  'Permanent Deletion',
  'UNKNOWN IP',
  "|| '-'",
  '>尚未注册任何通行密钥。<',
  '账号信息',
  '安全验证',
  'profileOldPassword',
  'profileNewPassword',
  'profileConfirmPassword',
  'deleteAccountPassword',
    'deleteAccountState',
    'passwordForm',
    'updateUsername',
    'updatePassword',
    'ProfileInlineEmptyState',
    'ProfileSettingsPrimitives'
];

for (const token of forbiddenProfileTokens)
{
  if (profile.includes(token)) {
    fail(profilePath, lineOf(profile, token), `Profile page must not include ${token}`)
  }
}

const requiredProfileTokens = [
  'profileCopy.pageTitle',
  'profileCopy.pageDescription',
    'profileCopy.emptyTitle',
    'profileCopy.emptyContent',
    'profileCopy.openIdentityCta',
    'FsusUiEmptyState',
    'size="inline"',
    ':illustration="false"',
    ':description="profileCopy.emptyContent"',
    'router.replace({ name: \'UserIdentityOverview\' })',
    'to="/user/identity"'
];

for (const token of requiredProfileTokens) {
  if (!profile.includes(token)) {
    fail(profilePath, 1, `Profile page contract is missing ${token}`)
  }
}

if (!profile.includes('useI18nText')) {
  fail(profilePath, 1, 'Profile.vue must use locale text via useI18nText')
}

for (const token of [
  'MfaSetupModal',
  'startMfaSetup',
  'verifyMfaSetup',
  'disableMfa',
  'mfaCopy.disableCta',
  '@click="disableTotpMfa"',
  'identity-mfa-status-tag',
  ":type=\"mfaProfile?.enabled ? 'success' : 'warning'\"",
  'PasskeyRegisterModal',
  'createRecoveryKey',
  'rotateRecoveryKey',
  'listSessions',
  'revokeOtherSessions'
]) {
  if (!identityCenter.includes(token)) {
    fail(identityCenterPath, 1, `Identity center contract is missing ${token}`)
    }
}

for (const token of [
    'FsusUiResourceList',
    'FsusUiResourceListItem',
    'FsusUiMetadataRow',
    'FsusUiMetadataItem',
    'FsusUiInlineActions',
    'FsusUiEmptyState',
    'FsusUiDangerZone',
    'FsusUiRiskNotice',
    'FsusUiDestructiveActionPanel',
    ':illustration="false"',
    'copy.lifecycleWarning',
    'deleteCurrentAccount'
])
{
    if (!identityCenter.includes(token))
{
        fail(identityCenterPath, 1, `Identity center FsusUI primitive contract is missing ${token}`);
    }
}

for (const token of [
    'ProfileResourceList',
    'ProfileResourceListItem',
    'ProfileInlineEmptyState',
    'ProfileSettingsPrimitives'
])
{
    if (identityCenter.includes(token))
{
        fail(identityCenterPath, lineOf(identityCenter, token), `Identity center must not keep retired local primitive ${token}`);
    }
}

const plainMfaStatusToken = '<span>{{ mfaProfile?.enabled ? mfaCopy.enabled : mfaCopy.disabled }}</span>';
if (identityCenter.includes(plainMfaStatusToken))
{
    fail(identityCenterPath, lineOf(identityCenter, plainMfaStatusToken), 'MFA enabled/disabled state must use an FsusUI status tag, not plain text');
}

if (identityCenter.includes('mfaCopy.enabledHint')) {
  fail(identityCenterPath, lineOf(identityCenter, 'mfaCopy.enabledHint'), 'MFA enabled state must show direct actions, not repeat the section description')
}

if (identityCenter.includes('recoveryKeyCopy.emptyState')) {
  fail(identityCenterPath, lineOf(identityCenter, 'recoveryKeyCopy.emptyState'), 'Recovery Key page must not render one-line guidance as an empty-state box')
}

if (!identityCopy.includes('创建或轮换后立即保存；之后不会再次显示。')) {
  fail(identityCopyPath, 1, 'Recovery Key copy must explain the one-time display behavior in the section hint')
}

for (const token of [
  'emptyState: \'明文不保存；仅创建或轮换后显示。\'',
  '明文不保存；仅创建或轮换后显示。'
]) {
  if (identityCopy.includes(token)) {
    fail(identityCopyPath, lineOf(identityCopy, token), `Recovery Key copy must not keep redundant empty-state text ${token}`)
  }
}

for (const token of [
  'identity-profile-form',
  'identity-profile-summary identity-policy-grid',
  'publicSendOptionState',
  'publicSendOptionValue',
  'publicProfileCopy.summaryAriaLabel',
  'publicProfileCopy.publicSendOptionLabel'
]) {
  if (!identityCenter.includes(token)) {
    fail(identityCenterPath, 1, `Identity public-profile page is missing structured status UI ${token}`)
  }
}

for (const token of [
  'publicProfileCopy.publicSendOptionPrefix',
  'publicProfileCopy.currentDraftPrefix',
  'publicHandleDraftDisplay',
  'clearPublicHandle',
  'publicProfileCopy.clearCta'
]) {
  if (identityCenter.includes(token)) {
    fail(identityCenterPath, lineOf(identityCenter, token), `Identity public-profile page must not use redundant status copy ${token}`)
  }
}

for (const token of [
  'publicSendOptionPrefix',
  'currentDraftPrefix',
  '当前草稿',
  'clearCta',
  '清空公开称呼'
]) {
  if (identityCopy.includes(token)) {
    fail(identityCopyPath, lineOf(identityCopy, token), `Identity public-profile copy must not keep redundant status text ${token}`)
  }
}

for (const token of [
  'commentRecordPolicyItems',
  'identity-policy-grid',
  'identity-policy-state',
  'identity-policy-state__dot',
  "type IdentityPolicyState = 'open' | 'active' | 'closed' | 'muted'",
  "anonymousCommentGovernanceAvailable ? 'active' : 'closed'",
  '.identity-policy-state--active .identity-policy-state__dot',
  '.identity-policy-state--muted .identity-policy-state__dot',
  'background: transparent',
  'commentRecordsCopy.value.policyPublicSendLabel',
  'commentRecordsCopy.value.policyAnonymousLabel',
  'commentRecordsCopy.value.policyZkLabel',
  'commentRecordsCopy.value.policyGovernanceLabel',
  'commentRecordsCopy.value.policyOpen',
  'commentRecordsCopy.value.policyClosed',
  'commentRecordsCopy.value.policyActive',
  'commentRecordsCopy.value.policyUnavailable',
  'UserCommentsEmptyState',
  'UserCommentsErrorState',
  'UserCommentsList',
  'useUserCommentsPage({ autoload: false })',
  'ensureCommentRecordsLoaded',
  'commentRecordsCopy.emptyTitle',
  'commentRecordsCopy.emptyDescription'
]) {
  if (!identityCenter.includes(token)) {
    fail(identityCenterPath, 1, `Identity comment-records policy summary is missing ${token}`)
  }
}

for (const token of [
  'identity-inline-link',
  'commentRecordsCopy.viewLink',
  'to="/user/comments"',
  'el-tag :type="item.type"',
  '<el-tag :type="item.type"'
]) {
  if (identityCenter.includes(token)) {
    fail(identityCenterPath, lineOf(identityCenter, token), `Identity comment-records page must not include redundant or badge-like policy UI ${token}`)
  }
}

for (const token of [
  '公开发送的评论记录。',
  '匿名评论按站点策略处理。',
  '查看公开评论记录',
  "policyEnabled: '可用'"
]) {
  if (identityCenter.includes(token)) {
    fail(identityCenterPath, lineOf(identityCenter, token), `Identity comment-records page must not render low-information copy ${token}`)
  }
  if (identityCopy.includes(token)) {
    fail(identityCopyPath, lineOf(identityCopy, token), `Identity copy must not keep low-information comment-records copy ${token}`)
  }
}

if (!router.includes("path: ACCOUNT_ROUTE_PATHS.profileChild") || !router.includes("redirect: { name: 'UserIdentityOverview' }")) {
  fail(routerPath, 1, 'legacy profile route must redirect to UserIdentityOverview')
}

if (accountNav.includes('to: ACCOUNT_ROUTE_PATHS.profile')) {
  fail(accountNavPath, lineOf(accountNav, 'to: ACCOUNT_ROUTE_PATHS.profile'), 'account nav must not link to legacy profile route')
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-profile-page-governance.mjs'
if (scripts['check:profile-page-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:profile-page-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:profile-page-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:profile-page-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[profile-page-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[profile-page-governance] ok')
