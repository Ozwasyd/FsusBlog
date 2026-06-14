#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const failures = []
const readForExpectation = (path) => {
  try {
    return read(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failures.push(`${path}: file is required for UX semantics checks`)
      return ''
    }
    throw error
  }
}
const expectIncludes = (path, needle, message) => {
  if (!readForExpectation(path).includes(needle)) failures.push(`${path}: ${message}`)
}
const expectNotIncludes = (path, needle, message) => {
  if (readForExpectation(path).includes(needle)) failures.push(`${path}: ${message}`)
}

expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '内容'", 'admin nav must expose content task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '互动'", 'admin nav must expose interaction task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '系统'", 'admin nav must expose system task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '运维'", 'admin nav must expose ops task group')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'openMobileGroupKey', 'mobile nav must keep one active task group expanded')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'account-shell-area-title', 'account shell area label must be non-heading display text')
expectNotIncludes('src/frontend/src/layouts/AccountLayout.vue', '<h1 class="text-[2.25rem] font-bold leading-[0.9]', 'account shell must not add a second page-level h1')

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

expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', '正在回复：', 'message center must show current reply context')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', '标记为处理中', 'message status action must be result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', '移回待处理', 'message status action must be result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', '关闭会话', 'message close action must be result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', '状态变更会通知用户', 'admin status action must explain notification consequence')
expectIncludes('src/frontend/src/views/user/Messages.vue', '回复草稿尚未发送', 'mobile back must warn about unsent draft')

expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '今日待处理', 'dashboard must expose action cards')
expectIncludes('src/frontend/src/components/admin/DashboardSectionHeader.vue', 'dashboard-section-title', 'dashboard must define a local compact section header')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '<DashboardSectionHeader', 'dashboard sections must use compact section headers')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', '先看关键指标和访问结构，再进入内容、用户与系统处理流程。', 'dashboard page description must not use SaaS dashboard summary copy')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'eyebrow="常用入口"', 'dashboard section headers must not opt into WorkbenchPanel eyebrow')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">今日待处理', 'today actions must not render a repeated eyebrow/title mini hero')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '<DashboardSectionHeader', 'author analytics must use the compact dashboard section header')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读数据、搜索表现与运行状态。', 'author analytics header copy must be short and task-oriented')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '仅使用站点运行信号，不采集正文输入或账号敏感字段。', 'author analytics privacy text must be demoted to note copy')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读与性能', 'author analytics must remove eyebrow copy')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '聚合真实阅读证明、公开路由、搜索与 AOT 运行信号，不采集正文输入或账号敏感字段。', 'author analytics must not use long PRD-style header copy')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '<DashboardSectionHeader', 'comment moderation must use the compact dashboard section header')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '处理待审评论；高风险操作需要二次确认。', 'comment moderation header must use direct task wording')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', 'dashboard-inline-empty', 'comment moderation empty state must be compact and inline')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '待审摘要', 'comment moderation must not render a large secondary title')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '最新待审评论优先呈现，高风险处置保持管理员二次验证边界。', 'comment moderation must remove PRD-style long header copy')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '<el-empty', 'comment moderation dashboard module must not use full el-empty')
expectIncludes('src/frontend/src/public-renderers/publicShellState.ts', '搜索文章、标签或关键词', 'public search placeholder must be specific')
expectIncludes('src/frontend/src/components/public/HomeFeedSurface.vue', '快速入口', 'home sidebar nav must be named quick entry')
expectIncludes('src/frontend/src/components/public/pages/PublicFilterPageContent.vue', '搜索范围：全站文章、标签或关键词', 'search results must show scope and state')
expectIncludes('src/frontend/src/components/home/HomeArticleEmptyState.vue', '查看归档', 'public empty state must include next action')

if (failures.length > 0) {
  console.error(failures.map((failure) => `[ux-semantics] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[ux-semantics] ok')
