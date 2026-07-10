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
const expectFileMissing = (path, message) => {
  try {
    read(path)
    failures.push(`${path}: ${message}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
const expectAdminCollectionSfcPrimitives = () => {
  const primitivePaths = [
    'src/frontend/src/components/admin/AdminCollectionToolbar.vue',
    'src/frontend/src/components/admin/AdminFilterGroup.vue',
    'src/frontend/src/components/admin/AdminSegmentedControl.vue',
    'src/frontend/src/components/admin/AdminCollectionSummary.vue',
    'src/frontend/src/components/admin/AdminInlineEmptyState.vue'
  ]

  let totalLines = 0
  for (const path of primitivePaths) {
    const content = readForExpectation(path)
    totalLines += content.split(/\r?\n/).length
    if (!content.includes('<template>')) failures.push(`${path}: admin collection primitive must be a template SFC`)
    if (!content.includes('<script setup lang="ts">')) failures.push(`${path}: admin collection primitive must use script setup TypeScript`)
    if (/\bdefineComponent\b|\bh\(/.test(content)) failures.push(`${path}: admin collection primitive must not use render-function helpers`)
  }

  if (totalLines > 200) {
    failures.push(`src/frontend/src/components/admin: admin collection primitive SFCs total ${totalLines} lines; expected <= 200`)
  }
}

expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '内容'", 'admin nav must expose content task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '互动'", 'admin nav must expose interaction task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '系统'", 'admin nav must expose system task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '运维'", 'admin nav must expose ops task group')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'mobileDrawerVisible', 'mobile nav must use the account drawer state')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'account-mobile-drawer-trigger', 'mobile nav trigger must live in header actions')
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'account-shell-area-title', 'account shell area label must be non-heading display text')
expectNotIncludes('src/frontend/src/layouts/AccountLayout.vue', '<h1 class="text-[2.25rem] font-bold leading-[0.9]', 'account shell must not add a second page-level h1')

expectIncludes('src/frontend/src/components/admin/article/ArticleWriteSidebar.vue', '发布', 'writer side panel must use publishing workflow')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '内容检查', 'writer side panel must include content check')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '版本', 'writer side panel must include revision task')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '图片资源和上传策略', 'writer side panel must merge upload and assets into resources')
expectIncludes('src/frontend/src/views/admin/article/Write.vue', '发布前 checklist', 'publish confirmation must be a checklist')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', '全屏写作', 'automatic wide layout must not expose a vague fullscreen mode label')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="SEO"', 'SEO must not remain a top-level writer tab')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="AI"', 'AI must not remain a top-level writer tab')
expectNotIncludes('src/frontend/src/views/admin/article/Write.vue', 'label="上传"', 'upload must not remain a top-level writer tab')

expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue', 'recommendedActionLabel', 'comment queue must show one recommended action')
expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue', '批量审核预演', 'bulk moderation must preview results')
expectIncludes('src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue', 'recommendedActionReason', 'comment detail must carry recommendation reason')

expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', 'threadCopy.replyingToPrefix', 'message center must render the current reply context copy')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', 'threadCopy.markOpen', 'message status action must be copy-driven and result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', 'threadCopy.moveToPending', 'message status action must be copy-driven and result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', 'threadCopy.closeConversation', 'message close action must be copy-driven and result-oriented')
expectIncludes('src/frontend/src/components/user/messages/MessagesThreadPanel.vue', 'threadCopy.statusChangeWillNotify', 'admin status action must render notification consequence copy')
expectIncludes('src/frontend/src/copy/messages.ts', "replyingToPrefix: '正在回复'", 'message center copy must show current reply context')
expectIncludes('src/frontend/src/copy/messages.ts', "markOpen: '标记为处理中'", 'message status copy must be result-oriented')
expectIncludes('src/frontend/src/copy/messages.ts', "moveToPending: '移回待处理'", 'message status copy must be result-oriented')
expectIncludes('src/frontend/src/copy/messages.ts', "closeConversation: '关闭会话'", 'message close copy must be result-oriented')
expectIncludes('src/frontend/src/copy/messages.ts', "statusChangeWillNotify: '状态变更会通知用户'", 'admin status copy must explain notification consequence')
expectIncludes('src/frontend/src/views/user/Messages.vue', '回复草稿尚未发送', 'mobile back must warn about unsent draft')

expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '今日待处理', 'dashboard must expose pending task rows')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-task-list', 'dashboard pending work must render as a compact task list')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-task-row', 'dashboard pending work must use row density instead of marketing cards')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-action-card', 'dashboard pending work must not render as large action cards')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'role="list" aria-label="站点统计"', 'dashboard KPI overview must use explicit list semantics')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-stat-card-value', 'dashboard KPI values must use a local aligned value column')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-stat-card-label', 'dashboard KPI labels must use an aligned icon and text wrapper')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '<el-icon size="16" aria-hidden="true" class="dashboard-stat-card-icon">', 'dashboard KPI icons must use the FsusUI default compact icon size')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '{{ card.value }}', 'dashboard KPI values must render zero values explicitly')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'grid-template-columns: repeat(4, minmax(0, 1fr));', 'dashboard KPI overview must remain a compact multi-column metric grid')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'grid-template-columns: repeat(2, minmax(0, 1fr));', 'dashboard KPI overview must fall back to a compact two-column mobile grid')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'minmax(3ch, auto)', 'dashboard KPI values must use a stable right-aligned numeric column')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'font-size: 0.875rem;', 'dashboard KPI labels and values must share compact typography')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'line-height: 1.35;', 'dashboard KPI labels and values must share compact line height')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'font-variant-numeric: tabular-nums;', 'dashboard KPI numeric values must use stable tabular figures')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', ':deep(.el-metric-item', 'dashboard KPI overview must not pierce FsusUI metric internals')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', ':primary="card.value"', 'dashboard KPI values must not rely on truthy numeric rendering')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', ':meta="card.description"', 'dashboard KPI overview must not repeat explanatory helper copy')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', '工作区', 'dashboard must not duplicate the top-level account navigation as a workspace block')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'workspaceEntries', 'dashboard must not maintain a second navigation source for workspace links')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'dashboard-entry-card', 'dashboard must not render duplicate workspace entry cards')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', '进入专项页面处理数据、内容、互动和系统状态。', 'dashboard must not explain duplicate workspace navigation')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '<FsusUiSectionHeader', 'dashboard sections must use compact section headers')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', '先看关键指标和访问结构，再进入内容、用户与系统处理流程。', 'dashboard page description must not use SaaS dashboard summary copy')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'eyebrow="常用入口"', 'dashboard section headers must not opt into WorkbenchPanel eyebrow')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">今日待处理', 'today actions must not render a repeated eyebrow/title mini hero')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '<FsusUiSectionHeader', 'author analytics must use the compact dashboard section header')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读数据、搜索表现与运行状态。', 'author analytics header copy must be short and task-oriented')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '仅使用站点运行信号，不采集正文输入或账号敏感字段。', 'author analytics privacy text must stay visible as compact note copy')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'dashboard-section-note', 'author analytics header note copy must use the compact note treatment')
expectIncludes('src/frontend/src/assets/account-shell.css', 'margin: 2px 0 0;', 'dashboard section note spacing must stay compact')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读与性能', 'author analytics must remove eyebrow copy')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '聚合真实阅读证明、公开路由、搜索与 AOT 运行信号，不采集正文输入或账号敏感字段。', 'author analytics must not use long PRD-style header copy')
expectIncludes('src/frontend/src/fsusui/metricPrimitives.ts', 'FsusUiMetricList', 'dashboard metrics must route through FsusUI metric primitives adapter')
expectIncludes('src/frontend/src/fsusui/metricPrimitives.ts', 'FsusUiDistributionBarRow', 'dashboard distributions must route through FsusUI distribution primitives adapter')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'AdminStatusMatrix', 'technical summary metrics must use FsusBlog compact admin status density')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'dashboard-rum-metric', 'Core Web Vitals rows must use local compact technical metric rows')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'FsusUiMetricList', 'technical metrics must not use the generic FsusUI MetricList control in this admin surface')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'FsusUiMetricItem', 'technical metrics must not use the generic FsusUI MetricItem control in this admin surface')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'FsusUiDistributionBarRow', 'distribution lists must use FsusUI proportional bars')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'FsusUiEmptyState', 'technical metric empty states must use FsusUI compact inline empty state')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '有运行时样本后将在这里显示 P75 和平均值。', 'technical metric empty states must stay single-line when the title is self-explanatory')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '有访问记录后将在这里显示分布。', 'RUM page empty states must stay single-line when the title is self-explanatory')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '有 AOT 运行记录后将在这里显示分布。', 'AOT source empty states must stay single-line when the title is self-explanatory')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'formatRumMetricName', 'RUM metric raw keys must be mapped to readable labels')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'formatDistributionLabel', 'RUM distribution raw labels must be mapped to readable labels')
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'h(\'span\', { class: \'min-w-0 truncate text-xs font-bold text-[var(--fsusblog-text-secondary)]\' }, item.name)', 'Core Web Vitals must not render raw metric keys directly')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '<FsusUiSectionHeader', 'comment moderation must use the compact dashboard section header')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '处理待审评论；高风险操作需要二次确认。', 'comment moderation header must use direct task wording')
expectIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', 'dashboard-inline-empty', 'comment moderation empty state must be compact and inline')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '待审摘要', 'comment moderation must not render a large secondary title')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '最新待审评论优先呈现，高风险处置保持管理员二次验证边界。', 'comment moderation must remove PRD-style long header copy')
expectNotIncludes('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', '<el-empty', 'comment moderation dashboard module must not use full el-empty')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', 'FsusUiDistributionBarRow', 'dashboard visit and region analytics must use FsusUI distribution rows')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', 'FsusUiEmptyState', 'dashboard analytics empty states must use FsusUI inline empty state')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', 'visitSourceRows', 'visit source analytics must be modeled as direct distribution rows')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', 'regionRows', 'region analytics must be modeled as direct distribution rows')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', 'shouldUseRegionChart', 'region analytics must reserve chart treatment for enough comparative data')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', '访客来源', 'visit source header must use short task-oriented copy')
expectIncludes('src/frontend/src/views/admin/Analytics.vue', '地域访问', 'region analytics header must use short task-oriented copy')
expectNotIncludes('src/frontend/src/views/admin/Analytics.vue', '<el-empty', 'dashboard analytics modules must not use full el-empty')
expectNotIncludes('src/frontend/src/views/admin/Analytics.vue', 'description="有访问记录后将在这里显示分布。"', 'dashboard analytics empty states must stay single-line when the title is self-explanatory')
expectNotIncludes('src/frontend/src/views/admin/Analytics.vue', '访客来源构成', 'visit source must not keep old chart-oriented title copy')
expectNotIncludes('src/frontend/src/views/admin/Analytics.vue', '地域访问分布 (Top 10)', 'region analytics must not keep old chart-oriented title copy')
expectAdminCollectionSfcPrimitives()
expectFileMissing('src/frontend/src/components/admin/AdminCollectionPrimitives.ts', 'admin collection primitives must be split into SFC files')
expectIncludes('src/frontend/src/components/admin/AdminCollectionToolbar.vue', 'AdminCollectionToolbar', 'admin collection screens must provide local toolbar primitives compatible with future FsusUI collection API')
expectIncludes('src/frontend/src/components/admin/AdminSegmentedControl.vue', 'AdminSegmentedControl', 'admin collection screens must provide a restrained segmented control primitive')
expectIncludes('src/frontend/src/components/admin/AdminCollectionSummary.vue', 'AdminCollectionSummary', 'admin collection screens must provide compact list-state primitives')
expectIncludes('src/frontend/src/components/admin/AdminInlineEmptyState.vue', 'AdminInlineEmptyState', 'admin collection screens must provide compact inline empty-state primitives')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'AdminCollectionToolbar', 'article list filters and primary action must be one collection toolbar')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'AdminCollectionSummary', 'article list must expose compact result-count state')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'AdminSegmentedControl', 'article status filters must use a restrained local segmented control')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'AdminInlineEmptyState', 'article list empty states must use compact inline semantics')
expectIncludes('src/frontend/src/views/admin/article/List.vue', '检索文章、编辑状态与进入写作流程。', 'article list header copy must be short and task-oriented')
expectIncludes('src/frontend/src/views/admin/article/List.vue', '搜索文章标题', 'article list search placeholder must be direct')
expectIncludes('src/frontend/src/views/admin/article/List.vue', '文章列表 ·', 'article list visible summary must use result-count wording')
expectIncludes('src/frontend/src/views/admin/article/List.vue', '调整筛选条件或新建文章。', 'article list empty state must suggest clear next actions')
expectIncludes('src/frontend/src/views/admin/article/List.vue', '清空筛选', 'article list empty state must include clear-filter action copy')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'article-list-status-filter', 'article list status filter must be a scoped quiet toolbar control')
expectNotIncludes('src/frontend/src/views/admin/article/List.vue', 'account-page-eyebrow', 'article list must remove redundant admin eyebrow')
expectNotIncludes('src/frontend/src/views/admin/article/List.vue', '搜索、预览和维护已发布文章。常用写作入口保留在当前页，便于从列表直接进入编辑流程。', 'article list must remove long PRD-style header copy')
expectNotIncludes('src/frontend/src/views/admin/article/List.vue', '输入博文标题检索...', 'article list must remove old search placeholder')
expectNotIncludes('src/frontend/src/views/admin/article/List.vue', '<el-empty', 'article list empty states must not use full el-empty')
expectNotIncludes('src/frontend/src/composables/useAdminArticleList.ts', '文章列表已刷新', 'article list live status must not expose debug-like refresh copy')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', 'AdminCollectionSummary', 'article trash must use compact list-state primitives')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', 'AdminInlineEmptyState', 'article trash empty states must use compact inline semantics')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '恢复下线文章或执行永久删除。', 'article trash header copy must be short and task-oriented')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '回收站 ·', 'article trash state must use compact count wording')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', '<FsusDialog', 'taxonomy create/edit dialog must use the shared Blog dialog shell')
expectNotIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', '<el-dialog', 'taxonomy create/edit dialog must not set raw Element dialog placement in the page')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '恢复后重新公开；永久删除不可找回。', 'article trash safety copy must live in compact state, not header')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '回收站暂无下线稿件', 'article trash empty state must use direct inline title copy')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '删除或归档的文章会显示在这里。', 'article trash empty state must explain where items appear')
expectIncludes('src/frontend/src/views/admin/article/Trash.vue', '永久删除不可撤销。', 'article trash footer must use concrete operational copy')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', 'account-page-eyebrow', 'article trash must remove redundant admin eyebrow')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', '处理已下线稿件的恢复与永久删除。恢复后会重新对外可见，永久删除后数据不可找回。', 'article trash header must not duplicate safety warning copy')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', '状态概览', 'article trash must remove overview mini-hero')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', '待处理稿件', 'article trash must remove repeated pending copy')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', '<el-empty', 'article trash empty states must not use full el-empty')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', 'footerWatermark', 'article trash must remove product-template footer watermark binding')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', '<el-scrollbar>', 'article trash table must avoid nested scrollbar inside native overflow')
expectNotIncludes('src/frontend/src/views/admin/article/Trash.vue', 'overscroll-behavior-inline: contain', 'article trash must not trap touch or trackpad sliding with inline overscroll containment')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', 'AdminCollectionSummary', 'taxonomy management must use compact collection summary primitives')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', 'AdminCollectionToolbar', 'taxonomy filters and create action must read as one collection toolbar')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', 'AdminInlineEmptyState', 'taxonomy table empty states must use compact inline semantics')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', 'stateText = computed(() => `${props.schema.entityLabel} ·', 'taxonomy state must use natural compact count wording')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', 'resultText = computed(() => `${props.schema.listTitle} ·', 'taxonomy list summary must use result-count wording')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', '引用数', 'taxonomy reference column must use user-facing copy')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', '总引用', 'taxonomy rows must expose total article references in user-facing wording')
expectIncludes('src/frontend/src/components/admin/AdminTaxonomyManageView.vue', '删除判断使用管理端完整引用数', 'taxonomy implementation detail must move into help text')
expectIncludes('src/frontend/src/views/admin/Category.vue', '维护文章分类与归档入口。', 'category header copy must be short and task-oriented')
expectIncludes('src/frontend/src/views/admin/Category.vue', "entityLabel: '分类'", 'category state must use natural compact count wording')
expectIncludes('src/frontend/src/views/admin/Category.vue', '删除前会检查引用关系。', 'category safety copy must be concrete and brief')
expectIncludes('src/frontend/src/views/admin/Category.vue', "listTitle: '分类列表'", 'category list summary must use result-count wording')
expectIncludes('src/frontend/src/views/admin/Category.vue', '暂无分类', 'category base empty state must be localized')
expectIncludes('src/frontend/src/views/admin/Category.vue', '新增分类后可用于文章归档与导航组织。', 'category base empty state must explain next use')
expectIncludes('src/frontend/src/views/admin/Category.vue', '没有匹配的分类', 'category filtered empty state must be distinct')
expectIncludes('src/frontend/src/views/admin/Category.vue', '调整关键词或清除筛选。', 'category filtered empty state must suggest filter recovery')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', 'eyebrow="管理"', 'category page must remove redundant admin eyebrow')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', '<WorkbenchPanel', 'category page must remove mini-hero WorkbenchPanel status block')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', '分类状态', 'category page must remove status eyebrow copy')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', '现有分类', 'category page must remove old inventory mini-hero wording')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', '安全机制：删除判断使用管理端真实引用数，不复用公开分类计数', 'category page must remove implementation-heavy status caption')
expectNotIncludes('src/frontend/src/views/admin/Category.vue', 'label="真实引用"', 'category reference column label must not lead with implementation wording')
expectNotIncludes('src/frontend/src/composables/useAdminTaxonomyManage.ts', '真实引用', 'taxonomy relation copy must not expose raw implementation wording')
expectIncludes('src/frontend/src/views/admin/Tag.vue', '维护文章标签与检索入口。', 'tag header copy must be short and task-oriented')
expectIncludes('src/frontend/src/views/admin/Tag.vue', "entityLabel: '标签'", 'tag state must use natural compact count wording')
expectIncludes('src/frontend/src/views/admin/Tag.vue', "listTitle: '标签列表'", 'tag list summary must use result-count wording')
expectIncludes('src/frontend/src/views/admin/Tag.vue', '暂无标签', 'tag base empty state must be localized')
expectIncludes('src/frontend/src/views/admin/Tag.vue', '新增标签后可用于文章检索与索引。', 'tag base empty state must explain next use')
expectIncludes('src/frontend/src/views/admin/Tag.vue', '没有匹配的标签', 'tag filtered empty state must be distinct')
expectIncludes('src/frontend/src/views/admin/Tag.vue', '调整关键词或清除筛选。', 'tag filtered empty state must suggest filter recovery')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', 'eyebrow="管理"', 'tag page must remove redundant admin eyebrow')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', '<WorkbenchPanel', 'tag page must remove mini-hero WorkbenchPanel status block')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', '索引规模', 'tag page must remove scale eyebrow copy')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', '已存标签', 'tag page must remove old inventory mini-hero wording')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', '删除判断使用管理端真实引用数，高危操作将触发强制算力校验', 'tag page must remove implementation-heavy status caption')
expectNotIncludes('src/frontend/src/views/admin/Tag.vue', 'label="真实引用"', 'tag reference column label must not lead with implementation wording')
expectIncludes('src/frontend/src/public-renderers/publicShellState.ts', '搜索文章、标签或关键词', 'public search placeholder must be specific')
expectIncludes('src/frontend/src/components/public/HomeFeedSurface.vue', '快速入口', 'home sidebar nav must be named quick entry')
expectIncludes('src/frontend/src/components/public/pages/PublicFilterPageContent.vue', '范围：文章、标签、关键词', 'search results must show scope and state')
expectIncludes('src/frontend/src/components/home/HomeArticleEmptyState.vue', '查看归档', 'public empty state must include next action')

if (failures.length > 0) {
  console.error(failures.map((failure) => `[ux-semantics] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[ux-semantics] ok')
