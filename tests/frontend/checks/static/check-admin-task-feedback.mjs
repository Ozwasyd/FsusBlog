#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`missing ${path}`)
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

requireFile('src/frontend/src/composables/useAdminTaskFeedback.ts')
requireFile('src/frontend/src/components/admin/AdminTaskFeedbackBar.vue')

requireIncludes('src/frontend/src/components/admin/AdminTaskFeedbackBar.vue', [
  'role="status"',
  'aria-live="polite"',
  'role="alert"',
  'data-admin-task-feedback="true"'
])

const requiredSurfaces = [
  ['src/frontend/src/views/admin/article/Write.vue', ['AdminTaskFeedbackBar', 'blog-motion-task-region', 'article-submit']],
  ['src/frontend/src/composables/useAdminArticleWrite.ts', ['taskFeedback.begin', 'taskFeedback.succeed', 'taskFeedback.fail', 'article-prepublish', 'article-revision', 'article-assets']],
  ['src/frontend/src/views/admin/CommentModeration.vue', ['AdminTaskFeedbackBar', 'taskFeedbackHighlightedIds']],
  ['src/frontend/src/composables/useCommentModerationActions.ts', ['正在审核评论', '正在批量审核评论', 'taskFeedback.partial']],
  ['src/frontend/src/views/admin/security/SecurityCrawler.vue', ['AdminTaskFeedbackBar', 'security-crawler-ranges', 'risk:${snapshot.subject}']],
  ['src/frontend/src/views/admin/security/SecurityPow.vue', ['AdminTaskFeedbackBar', 'security-pow-options']],
  ['src/frontend/src/views/admin/Integrity.vue', ['AdminTaskFeedbackBar', 'integrity-report', '正在应用安全修复']],
  ['src/frontend/src/views/admin/ContentTools.vue', ['AdminTaskFeedbackBar', 'content-export', 'content-import']],
  ['src/frontend/src/views/admin/Settings.vue', ['AdminTaskFeedbackBar', 'settings-site', 'settings-compliance', 'settings-page']],
  ['src/frontend/src/views/admin/moderation/ModerationDictionaries.vue', ['AdminTaskFeedbackBar', 'moderation-dictionaries-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationModel.vue', ['AdminTaskFeedbackBar', 'moderation-model-runtime']],
  ['src/frontend/src/views/admin/moderation/ModerationDashboard.vue', ['AdminTaskFeedbackBar', 'moderation-global-runtime']],
  ['src/frontend/src/views/user/Messages.vue', ['AdminTaskFeedbackBar', 'isAdminConversationHighlighted']],
  ['src/frontend/src/composables/useAdminMessageCenter.ts', ['taskFeedback.begin', '正在发送站内信回复', '正在发送系统消息']]
]

for (const [path, tokens] of requiredSurfaces) {
  requireIncludes(path, tokens)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[admin-task-feedback] ${error}`)
  }
  process.exit(1)
}

console.log(`[admin-task-feedback] ok surfaces=${requiredSurfaces.length}`)
