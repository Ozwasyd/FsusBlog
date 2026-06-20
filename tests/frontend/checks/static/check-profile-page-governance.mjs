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
const routerPath = path.join(repoRoot, 'src/frontend/src/router/index.ts')
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
  'updatePassword'
]

for (const token of forbiddenProfileTokens) {
  if (profile.includes(token)) {
    fail(profilePath, lineOf(profile, token), `Profile page must not include ${token}`)
  }
}

const requiredProfileTokens = [
  '资料页已迁移到身份中心。',
  'router.replace({ name: \'UserIdentityOverview\' })',
  'to="/user/identity"',
  '打开身份中心'
]

for (const token of requiredProfileTokens) {
  if (!profile.includes(token)) {
    fail(profilePath, 1, `Profile page contract is missing ${token}`)
  }
}

for (const token of [
  'MfaSetupModal',
  'startMfaSetup',
  'verifyMfaSetup',
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
