#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []
const textExtensions = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs'])

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`missing ${path}`)
  }
}

function forbidFile(path) {
  if (existsSync(resolve(repoRoot, path))) {
    errors.push(`unexpected ${path}`)
  }
}

function requireIncludes(path, tokens) {
  const source = read(path)
  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push(`${path}: missing ${token}`)
    }
  }
}

function forbidIncludes(path, tokens) {
  const source = read(path)
  for (const token of tokens) {
    if (source.includes(token)) {
      errors.push(`${path}: forbidden ${token}`)
    }
  }
}

function scanTextFiles(rootPath, callback) {
  const absoluteRoot = resolve(repoRoot, rootPath)
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      scanTextFiles(absolutePath, callback)
      continue
    }

    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) {
      continue
    }

    const relativePath = absolutePath.slice(repoRoot.length + 1)
    callback(relativePath, readFileSync(absolutePath, 'utf8'))
  }
}

requireFile('src/frontend/src/composables/useAdminTaskFeedback.ts')
forbidFile('src/frontend/src/components/admin/AdminTaskFeedbackBar.vue')

requireIncludes('src/frontend/src/fsusui/feedback.ts', [
  'detail?: string',
  'aria-live',
  'partial:',
  "type: 'warning'",
  'formatToastMessage'
])

requireIncludes('src/frontend/src/composables/useAdminTaskFeedback.ts', [
  "import { toast } from '@/fsusui/feedback'",
  'toast.info({',
  'toast.success({',
  'toast.partial({',
  'toast.error({',
  'DEFAULT_TOAST_DURATION_MS'
])

const requiredSurfaces = [
  ['src/frontend/src/views/admin/article/Write.vue', ['blog-motion-task-region', 'article-submit']],
  ['src/frontend/src/composables/useAdminArticleWrite.ts', ['taskFeedback.begin', 'taskFeedback.succeed', 'taskFeedback.fail', 'article-prepublish', 'article-revision', 'article-assets']],
  ['src/frontend/src/views/admin/CommentModeration.vue', ['taskFeedbackHighlightedIds']],
  ['src/frontend/src/composables/useCommentModerationActions.ts', ['正在审核评论', '正在批量审核评论', 'taskFeedback.partial']],
  ['src/frontend/src/views/admin/security/SecurityCrawler.vue', ['security-crawler-ranges', 'risk:${snapshot.subject}']],
  ['src/frontend/src/views/admin/security/SecurityPow.vue', ['security-pow-options']],
  ['src/frontend/src/views/admin/Integrity.vue', ['integrity-report', '正在应用安全修复']],
  ['src/frontend/src/views/admin/ContentTools.vue', ['content-export', 'content-import']],
  ['src/frontend/src/views/admin/Settings.vue', ['settings-site', 'settings-compliance', 'settings-page']],
  ['src/frontend/src/views/admin/moderation/ModerationDictionaries.vue', ['moderation-dictionaries-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationModel.vue', ['moderation-model-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationDashboard.vue', ['moderation-global-runtime']],
  ['src/frontend/src/views/user/Messages.vue', ['isAdminConversationHighlighted']],
  ['src/frontend/src/composables/useAdminMessageCenter.ts', ['taskFeedback.begin', '正在发送站内信回复', '正在发送系统消息']]
]

for (const [path, tokens] of requiredSurfaces) {
  requireIncludes(path, tokens)
  forbidIncludes(path, ['AdminTaskFeedbackBar'])
}

scanTextFiles('src/frontend/src', (path, source) => {
  if (source.includes('AdminTaskFeedbackBar')) {
    errors.push(`${path}: forbidden AdminTaskFeedbackBar`)
  }
})

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[admin-task-feedback] ${error}`)
  }
  process.exit(1)
}

console.log(`[admin-task-feedback] ok surfaces=${requiredSurfaces.length}`)
