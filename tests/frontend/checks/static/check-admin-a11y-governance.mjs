#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []
const adminAccountRoots = [
  'src/frontend/src/views/admin',
  'src/frontend/src/views/user',
  'src/frontend/src/components/admin',
  'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir))

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

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

function requireToken(file, source, token, message) {
  if (!source.includes(token)) {
    fail(file, 1, message)
  }
}

function forbidToken(file, source, token, message) {
  if (source.includes(token)) {
    fail(file, lineOf(source, token), message)
  }
}

function assertEveryElIconHidden(file) {
  const source = read(file)
  const pattern = /<el-icon\b(?![^>]*\baria-hidden=["']true["'])/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    fail(file, lineOf(source, match[0]), 'decorative el-icon must declare aria-hidden="true"')
  }
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }

  return files
}

function assertSwitchesDoNotUseVisibleStateText(file) {
  const source = read(file)
  for (const token of ['active-text=', 'inactive-text=']) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), 'admin/account switches must not use visible active/inactive text; use row labels plus aria-label')
    }
  }
}

const messageCenterPath = path.join(repoRoot, 'src/frontend/src/views/admin/MessageCenter.vue')
const messageCenter = read(messageCenterPath)
requireToken(
  messageCenterPath,
  messageCenter,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  'MessageCenter list/detail focus-visible ring must use --fsusblog-color-focus-ring'
)
forbidToken(
  messageCenterPath,
  messageCenter,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-primary, Highlight);',
  'MessageCenter list/detail focus-visible ring must not use primary color'
)

const articleRevisionPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleRevisionPanel.vue')
const articleRevision = read(articleRevisionPath)
forbidToken(articleRevisionPath, articleRevision, ':aria-pressed=', 'revision list item must use aria-current, not aria-pressed')
forbidToken(articleRevisionPath, articleRevision, ':aria-label="`选择修订版本', 'revision button accessible name must come from visible text')
requireToken(
  articleRevisionPath,
  articleRevision,
  ':aria-current="selectedRevision?.id === revision.id ? \'true\' : undefined"',
  'revision list item must keep aria-current state'
)

const messagesConversationListPath = path.join(repoRoot, 'src/frontend/src/components/user/messages/MessagesConversationList.vue')
const messagesConversationList = read(messagesConversationListPath)
forbidToken(messagesConversationListPath, messagesConversationList, ':aria-pressed=', 'conversation list item must use aria-current, not aria-pressed')
requireToken(
  messagesConversationListPath,
  messagesConversationList,
  ':aria-current="item.conversationId === selectedConversationId ? \'true\' : undefined"',
  'conversation list item must keep aria-current state'
)

const userManageTablePath = path.join(repoRoot, 'src/frontend/src/components/admin/users/UserManageTable.vue')
const userManageTable = read(userManageTablePath)
forbidToken(userManageTablePath, userManageTable, '<article', 'compact user table rows must not use article card shells')
forbidToken(userManageTablePath, userManageTable, 'px-4 py-5', 'compact user table rows must use table-density padding')
forbidToken(userManageTablePath, userManageTable, 'gap-6', 'compact user table rows must avoid card-like spacing')
requireToken(
  userManageTablePath,
  userManageTable,
  '<div\n          class="user-resource-list-item border-b border-[var(--fsusblog-panel-border)] px-4 py-3"',
  'compact user table rows must render as flat div rows'
)
requireToken(
  userManageTablePath,
  userManageTable,
  'py-3',
  'compact user table rows must use 12px vertical padding'
)

const commentQueuePath = path.join(repoRoot, 'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue')
const commentQueue = read(commentQueuePath)
forbidToken(commentQueuePath, commentQueue, '<article', 'compact comment moderation rows must not use article card shells')
forbidToken(commentQueuePath, commentQueue, 'bg-[var(--fsusblog-page-bg)] p-6', 'compact comment moderation rows must not use card background padding')
requireToken(
  commentQueuePath,
  commentQueue,
  'border-b border-[var(--fsusblog-panel-border)] py-3',
  'compact comment moderation rows must use flat divider rows with table-density padding'
)

for (const file of [
  'src/frontend/src/components/admin/AdminTaxonomyManageView.vue',
  'src/frontend/src/components/admin/users/UserManageHeader.vue',
  'src/frontend/src/components/admin/article/AdminArticleCompactCard.vue',
  'src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue',
  'src/frontend/src/views/admin/Settings.vue',
  'src/frontend/src/views/auth/Login.vue',
  'src/frontend/src/views/admin/article/List.vue',
  'src/frontend/src/views/admin/article/Trash.vue'
].map((entry) => path.join(repoRoot, entry))) {
  assertEveryElIconHidden(file)
}

for (const file of [
  'src/frontend/src/components/ui/MfaSetupModal.vue',
  'src/frontend/src/components/ui/PasskeyRegisterModal.vue',
  'src/frontend/src/components/admin/users/UserBanDialog.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue',
  'src/frontend/src/views/admin/article/Write.vue',
  'src/frontend/src/views/admin/Settings.vue'
].map((entry) => path.join(repoRoot, entry))) {
  const source = read(file)
  for (const token of ['520px', '480px', '460px', '420px', 'min(95vw, 480px)']) {
    forbidToken(file, source, token, 'admin/security dialog widths must use approved compact steps')
  }
}

const settingsPath = path.join(repoRoot, 'src/frontend/src/views/admin/Settings.vue')
const settings = read(settingsPath)
const adminWorkspacePath = path.join(repoRoot, 'src/frontend/src/assets/admin-workspace.css')
const adminWorkspace = read(adminWorkspacePath)
forbidToken(settingsPath, settings, '--fsusblog-admin-status-warning', 'settings warning icon must use the Element Plus warning semantic')
requireToken(settingsPath, settings, 'text-[var(--el-color-warning)]', 'settings warning icon must use --el-color-warning')
forbidToken(adminWorkspacePath, adminWorkspace, '--fsusblog-admin-status-warning', 'admin warning alerts must not create a custom mixed warning semantic')
requireToken(adminWorkspacePath, adminWorkspace, '--fsusblog-admin-alert-accent: var(--el-color-warning);', 'admin warning alerts must use --el-color-warning for the accent')
requireToken(adminWorkspacePath, adminWorkspace, 'background: color-mix(in srgb, var(--el-color-warning) 8%, var(--fsusblog-page-bg));', 'admin warning alerts must use the restrained warning tint')
requireToken(settingsPath, settings, '<button', 'settings dropzone empty state must be a real button')
requireToken(settingsPath, settings, 'type="button"', 'settings dropzone empty state button must not submit forms')
requireToken(settingsPath, settings, 'aria-label="上传预览图"', 'settings dropzone button must expose an accessible name')
requireToken(settingsPath, settings, '<el-icon :size="20" aria-hidden="true"><Plus /></el-icon>', 'settings dropzone icon must be decorative and 20px')
  forbidToken(settingsPath, settings, '<el-icon size="24"><Plus /></el-icon>', 'settings dropzone must not use a decorative 24px placeholder icon')

for (const file of adminAccountRoots.flatMap((dir) => walk(dir))) {
  assertSwitchesDoNotUseVisibleStateText(file)
}

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-a11y-governance.mjs'
if (scripts['check:admin-a11y-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:admin-a11y-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-a11y-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-a11y-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-a11y-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-a11y-governance] ok')
