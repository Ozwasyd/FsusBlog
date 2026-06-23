#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const commentsPath = path.join(repoRoot, 'src/frontend/src/views/user/Comments.vue')
const emptyPath = path.join(repoRoot, 'src/frontend/src/components/user/UserCommentsEmptyState.vue')
const listPath = path.join(repoRoot, 'src/frontend/src/components/user/UserCommentsList.vue')
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

const comments = read(commentsPath)
const empty = read(emptyPath)
const list = read(listPath)

for (const [file, source, tokens] of [
  [commentsPath, comments, ['account-page-eyebrow', '交互', '历史互动', 'comments-filter-bar', 'fade-fast', 'list-fade']],
  [emptyPath, empty, ['<el-empty', '暂无评论记录', '你在文章下发表的评论会显示在这里']],
  [listPath, list, ['<transition', 'transition-group', 'fade-fast', 'list-fade', 'translateY', 'translateX']]
]) {
  for (const token of tokens) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), `User comments workflow must not include ${token}`)
    }
  }
}

const requiredCommentsTokens = [
  '查看、筛选和删除公开发送的评论。',
  '匿名评论不进入账号记录',
  'UserCommentsCollectionToolbar',
  'v-else-if="list.length === 0"',
  'title="暂无公开评论记录"',
  'description="公开发送的评论会显示在这里。匿名评论不会按账号检索。"',
  'title="没有匹配的公开评论"',
  'description="调整关键词或清除筛选。"',
  '清除筛选'
]

for (const token of requiredCommentsTokens) {
  if (!comments.includes(token)) {
    fail(commentsPath, 1, `User comments page contract is missing ${token}`)
  }
}

const requiredEmptyTokens = [
  'defineProps',
  'title: string',
  'description?: string',
  '$slots.actions',
  'role="status"',
  'aria-live="polite"'
]

for (const token of requiredEmptyTokens) {
  if (!empty.includes(token)) {
    fail(emptyPath, 1, `User comments empty state contract is missing ${token}`)
  }
}

for (const token of ['role="list"', 'role="listitem"', 'aria-label="评论历史列表"', 'user-comment-delete-button']) {
  if (!list.includes(token)) {
    fail(listPath, 1, `User comments list contract is missing ${token}`)
  }
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-user-comments-page-governance.mjs'
if (scripts['check:user-comments-page-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:user-comments-page-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:user-comments-page-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:user-comments-page-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[user-comments-page-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[user-comments-page-governance] ok')
