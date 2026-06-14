#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const pagePath = path.join(repoRoot, 'src/frontend/src/views/admin/UserManage.vue')
const headerPath = path.join(repoRoot, 'src/frontend/src/components/admin/users/UserManageHeader.vue')
const tablePath = path.join(repoRoot, 'src/frontend/src/components/admin/users/UserManageTable.vue')
const composablePath = path.join(repoRoot, 'src/frontend/src/composables/useAdminUserManage.ts')
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

const page = read(pagePath)
const header = read(headerPath)
const table = read(tablePath)
const composable = read(composablePath)

for (const [file, source, tokens] of [
  [pagePath, page, ['account-page-eyebrow', '执行封禁、解封与密码重置等高风险操作']],
  [headerPath, header, ['>管理</div>', 'text-2xl', 'sm:text-3xl']],
  [tablePath, table, ['<el-empty', 'user-mobile-card', 'hover:bg-[var(--fsusblog-panel-bg)]']],
  [composablePath, composable, ["lastLoginText: item.lastLoginTime ? TimeUtils.toFullLocalString(item.lastLoginTime) : '--'", "return '--'"]]
]) {
  for (const token of tokens) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), `Admin user management must not include ${token}`)
    }
  }
}

const requiredPageTokens = [
  '管理账户状态、密码重置与封禁操作。',
  "const userTableHasActiveFilters = computed(() => activeFilterChips.value.length > 0)",
  "userTableEmptyTitle = computed(() => userTableHasActiveFilters.value ? '没有匹配的用户' : '暂无用户记录')",
  "userTableHasActiveFilters.value",
  '创建或导入用户后会显示在这里。',
  ':has-active-filters="userTableHasActiveFilters"',
  '@reset-filters="resetFilters"'
]

for (const token of requiredPageTokens) {
  if (!page.includes(token)) {
    fail(pagePath, 1, `Admin user management page contract is missing ${token}`)
  }
}

const requiredHeaderTokens = [
  '用户筛选',
  'text-[15px]',
  '强制算力校验'
]

for (const token of requiredHeaderTokens) {
  if (!header.includes(token)) {
    fail(headerPath, 1, `Admin user management header contract is missing ${token}`)
  }
}

const requiredTableTokens = [
  'hasActiveFilters?: boolean',
  "emit('reset-filters')",
  '清除筛选',
  'role="list"',
  'role="listitem"',
  'user-resource-list',
  'user-resource-list-item',
  '重置用户密码：',
  '变更用户状态：',
  'row.lastLoginText'
]

for (const token of requiredTableTokens) {
  if (!table.includes(token)) {
    fail(tablePath, 1, `Admin user management table contract is missing ${token}`)
  }
}

const requiredComposableTokens = [
  "lastLoginText: item.lastLoginTime ? TimeUtils.toFullLocalString(item.lastLoginTime) : '从未登录'",
  'statusText: `${statusLabel} / ${statusCode}`',
  "return '用户'"
]

for (const token of requiredComposableTokens) {
  if (!composable.includes(token)) {
    fail(composablePath, 1, `Admin user management composable contract is missing ${token}`)
  }
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-user-manage-governance.mjs'
if (scripts['check:admin-user-manage-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:admin-user-manage-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-user-manage-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-user-manage-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-user-manage-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-user-manage-governance] ok')
