#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const profilePath = path.join(repoRoot, 'src/frontend/src/views/user/Profile.vue')
const securityComposablePath = path.join(repoRoot, 'src/frontend/src/composables/useUserProfileSecurity.ts')
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
const securityComposable = read(securityComposablePath)

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
  '>尚未注册任何通行密钥。<'
]

for (const token of forbiddenProfileTokens) {
  if (profile.includes(token)) {
    fail(profilePath, lineOf(profile, token), `Profile page must not include ${token}`)
  }
}

const forbiddenComposableTokens = [
  '重新绑定 MFA',
  '关闭 MFA',
  'MFA 初始化失败',
  'MFA 已启用',
  'MFA 验证失败',
  'MFA 重新绑定已开始',
  'MFA 已关闭',
  'MFA 操作失败'
]

for (const token of forbiddenComposableTokens) {
  if (securityComposable.includes(token)) {
    fail(securityComposablePath, lineOf(securityComposable, token), `Profile security copy must not include ${token}`)
  }
}

const requiredProfileTokens = [
  '更新账号信息、登录凭据与设备会话。',
  'ProfileSectionNav',
  'ProfileSettingsSection',
  'ProfileResourceList',
  'ProfileResourceListItem',
  'ProfileInlineEmptyState',
  '账号信息',
  '安全验证',
  '登录方式',
  '登录设备',
  '危险操作',
  '二次验证',
  '启用二次验证',
  '关闭二次验证',
  '尚未添加通行密钥',
  '添加后可使用设备生物识别或 PIN 登录。',
  '暂无其他设备会话',
  '当前只有本设备保持登录。',
  '未记录 IP',
  '未记录设备信息',
  '未记录',
  '注销账户',
  '注销后将退出所有设备，账号身份会匿名化处理，且不能恢复。'
]

for (const token of requiredProfileTokens) {
  if (!profile.includes(token)) {
    fail(profilePath, 1, `Profile page contract is missing ${token}`)
  }
}

for (const token of ['重新绑定二次验证', '二次验证已启用', '二次验证已关闭']) {
  if (!securityComposable.includes(token)) {
    fail(securityComposablePath, 1, `Profile security copy is missing ${token}`)
  }
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
