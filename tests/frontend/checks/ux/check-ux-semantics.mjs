#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('../../../..', import.meta.url).pathname)
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const failures = []
const expectIncludes = (path, needle, message) => {
  if (!read(path).includes(needle)) failures.push(`${path}: ${message}`)
}
const expectNotIncludes = (path, needle, message) => {
  if (read(path).includes(needle)) failures.push(`${path}: ${message}`)
}

expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '内容'", 'admin nav must expose content task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '互动'", 'admin nav must expose interaction task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '系统'", 'admin nav must expose system task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '运维'", 'admin nav must expose ops task group')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'openMobileGroupKey', 'mobile nav must keep one active task group expanded')

expectIncludes('src/frontend/src/views/admin/article/Write.vue', '发布设置', 'writer side panel must use publishing workflow')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '内容检查', 'writer side panel must include content check')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '历史版本', 'writer side panel must include revision task')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="资源"', 'writer side panel must merge upload and assets into resources')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '发布前 checklist', 'publish confirmation must be a checklist')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '全屏：最大化编辑区，可按 Esc 退出', 'layout mode must explain fullscreen escape')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="SEO"', 'SEO must not remain a top-level writer tab')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="AI"', 'AI must not remain a top-level writer tab')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="上传"', 'upload must not remain a top-level writer tab')

expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue', 'recommendedActionLabel', 'comment queue must show one recommended action')
expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue', '批量审核预演', 'bulk moderation must preview results')
expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue', 'recommendedActionReason', 'comment detail must carry recommendation reason')

expectIncludes('src/frontend/src/views/user/Messages.vue', '正在回复：', 'message center must show current reply context')
expectIncludes('src/frontend/src/views/user/Messages.vue', '标记为处理中', 'message status action must be result-oriented')
expectIncludes('src/frontend/src/views/user/Messages.vue', '移回待处理', 'message status action must be result-oriented')
expectIncludes('src/frontend/src/views/user/Messages.vue', '关闭会话', 'message close action must be result-oriented')
expectIncludes('src/frontend/src/views/user/Messages.vue', '状态变更会通知用户', 'admin status action must explain notification consequence')
expectIncludes('src/frontend/src/views/user/Messages.vue', '回复草稿尚未发送', 'mobile back must warn about unsent draft')

expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '今日待处理', 'dashboard must expose action cards')
expectIncludes('src/frontend/src/public-renderers/publicShellState.ts', '搜索文章、标签或关键词', 'public search placeholder must be specific')
expectIncludes('src/frontend/src/components/public/pages/PublicHomePageContent.vue', '快速入口', 'home sidebar nav must be named quick entry')
expectIncludes('src/frontend/src/components/public/pages/PublicFilterPageContent.vue', '搜索范围：全站文章、标签或关键词', 'search results must show scope and state')
expectIncludes('src/frontend/src/components/home/HomeArticleEmptyState.vue', '查看归档', 'public empty state must include next action')

if (failures.length > 0) {
  console.error(failures.map((failure) => `[ux-semantics] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[ux-semantics] ok')
