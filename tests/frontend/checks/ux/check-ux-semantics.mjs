#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  auditAdminSegmentedControlRemoval,
  loadAdminSegmentedControlSources
} from '../static/check-admin-segmented-control-removal.mjs'

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
    'src/frontend/src/components/admin/CollectionWorkbench.vue',
    'src/frontend/src/components/admin/AdminFilterGroup.vue',
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

failures.push(...auditAdminSegmentedControlRemoval(loadAdminSegmentedControlSources(root)))

expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '内容'", 'admin nav must expose content task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '互动'", 'admin nav must expose interaction task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '安全'", 'admin nav must expose security task group')
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '系统'", 'admin nav must expose system task group');
expectIncludes('src/frontend/src/layouts/accountNav.ts', "label: '运维'", 'admin nav must expose ops task group');
expectIncludes('src/frontend/src/layouts/accountNav.ts', 'ACCOUNT_GLOBAL_MODULE_LIMIT = 7', 'account shell must cap persistent first-level modules');
expectIncludes('src/frontend/src/layouts/AccountRouteFrame.vue', 'mobileDrawerVisible', 'mobile nav must use the account frame drawer state');
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', '<RouterView name="accountMobileAction" />', 'mobile nav action must live in the shared header outlet');
expectIncludes('src/frontend/src/layouts/AccountFrameMobileAction.vue', 'account-mobile-drawer-trigger', 'active frame must provide the mobile nav trigger');
expectIncludes('src/frontend/src/layouts/AccountRouteFrame.vue', 'account-shell-area-title', 'account frame area label must be non-heading display text');
expectIncludes('src/frontend/src/layouts/AccountRouteFrame.vue', 'AccountNavigationPanel', 'account frames must share module and local navigation between desktop and mobile');
expectIncludes('src/frontend/src/layouts/AccountLayout.vue', 'AccountHeaderMenu', 'policy and logout actions must live in the account menu');
expectNotIncludes('src/frontend/src/layouts/AccountRouteFrame.vue', 'account-sidebar-scroll', 'desktop sidebar must not scroll because every leaf is flattened');
expectIncludes('src/frontend/src/components/account/AccountNavigationPanel.vue', 'account-global-module-nav', 'account shell must distinguish first-level modules');
expectIncludes('src/frontend/src/components/account/AccountNavigationPanel.vue', 'account-local-navigation', 'account shell must expose current-module local navigation');
expectNotIncludes('src/frontend/src/components/account/AccountNavigationPanel.vue', 'FsusUiSectionNav', 'account module leaves must not become a universal top-tab row');
expectIncludes('src/frontend/src/components/account/AccountHeaderMenu.vue', '使用规范', 'account menu must expose usage guidelines')
expectIncludes('src/frontend/src/components/account/AccountHeaderMenu.vue', '隐私政策', 'account menu must expose privacy policy')
expectIncludes('src/frontend/src/components/account/AccountHeaderMenu.vue', 'command="logout"', 'account menu must expose logout')
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
expectIncludes('src/frontend/src/locales/zh-CN/messages.ts', "replyingToPrefix: '正在回复'", 'message center copy must show current reply context')
expectIncludes('src/frontend/src/locales/zh-CN/messages.ts', "markOpen: '标记为处理中'", 'message status copy must be result-oriented')
expectIncludes('src/frontend/src/locales/zh-CN/messages.ts', "moveToPending: '移回待处理'", 'message status copy must be result-oriented')
expectIncludes('src/frontend/src/locales/zh-CN/messages.ts', "closeConversation: '关闭会话'", 'message close copy must be result-oriented')
expectIncludes('src/frontend/src/locales/zh-CN/messages.ts', "statusChangeWillNotify: '状态变更会通知用户'", 'admin status copy must explain notification consequence')
expectIncludes('src/frontend/src/views/user/Messages.vue', '回复草稿尚未发送', 'mobile back must warn about unsent draft')

expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'AdminDashboardTaskWorkbench', 'dashboard must render the task-first workbench')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '今日待处理', 'dashboard must expose pending task rows')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'dashboard-task-list', 'dashboard pending work must render as a compact task list')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'dashboard-task-row', 'dashboard pending work must use row density instead of marketing cards')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'dashboard-action-card', 'dashboard pending work must not render as large action cards')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '<dl class="dashboard-stat-ledger" aria-label="站点统计摘要">', 'dashboard summary must use definition-list semantics')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '<dt>{{ item.label }}</dt>', 'dashboard ledger must identify each statistic')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '<dd>{{ item.value }}</dd>', 'dashboard ledger must render zero values explicitly')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'dashboard-stat-card', 'dashboard summary must not use KPI cards')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '<el-icon', 'dashboard summary must not use decorative KPI icons')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'grid-template-columns: repeat(3, minmax(0, 1fr));', 'dashboard summary must remain a compact multi-column ledger')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'grid-template-columns: repeat(2, minmax(0, 1fr));', 'dashboard summary must fall back to two compact mobile rows')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'font-size: 14px;', 'dashboard tasks must keep compact typography')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'line-height: 1.35;', 'dashboard task and ledger labels must keep compact line height')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'font-variant-numeric: tabular-nums;', 'dashboard numeric values must use stable tabular figures')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '帮助与反馈', 'dashboard feedback must move behind a help disclosure')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '查看详细分析', 'dashboard must link detailed analytics instead of embedding them')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'GitHub', 'dashboard first view must not show repository branding')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'Issue', 'dashboard first view must not show issue-tracker copy')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '累计阅读', 'dashboard summary must keep reading analysis on its dedicated page')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', ':deep(.el-metric-item', 'dashboard summary must not pierce FsusUI metric internals')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '工作区', 'dashboard must not duplicate the top-level account navigation as a workspace block')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'workspaceEntries', 'dashboard must not maintain a second navigation source for workspace links')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'dashboard-entry-card', 'dashboard must not render duplicate workspace entry cards')
expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', '<FsusUiSectionHeader', 'dashboard sections must use compact section headers')
expectNotIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', 'eyebrow="常用入口"', 'dashboard section headers must not opt into WorkbenchPanel eyebrow')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '<FsusUiSectionHeader', 'author analytics must use the compact dashboard section header')
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读数据、搜索表现与运行状态。', 'author analytics header copy must be short and task-oriented');
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '仅使用站点运行信号，不采集正文输入或账号敏感字段。', 'author analytics privacy text must stay visible as compact note copy');
expectIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', 'dashboard-section-note', 'author analytics header note copy must use the compact note treatment');
expectIncludes('src/frontend/src/assets/admin-workspace.css', 'margin: var(--fsus-space-1) 0 0;', 'dashboard section note spacing must stay compact and tokenized');
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '阅读与性能', 'author analytics must remove eyebrow copy');
expectNotIncludes('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue', '聚合真实阅读证明、公开路由、搜索与 AOT 运行信号，不采集正文输入或账号敏感字段。', 'author analytics must not use long PRD-style header copy');
expectIncludes('src/frontend/src/fsusui/metricPrimitives.ts', 'FsusUiMetricList', 'dashboard metrics must route through FsusUI metric primitives adapter');
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
expectFileMissing('src/frontend/src/components/admin/AdminSegmentedControl.vue', 'generic segmented controls must remain owned by FsusUI')
expectIncludes('src/frontend/src/components/admin/CollectionWorkbench.vue', 'CollectionWorkbench', 'admin collections must use the fixed workbench composition')
expectIncludes('src/frontend/src/components/admin/AdminInlineEmptyState.vue', 'AdminInlineEmptyState', 'admin collection screens must provide compact inline empty-state primitives')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'CollectionWorkbench', 'article list filters and results must share the collection workbench')
expectIncludes('src/frontend/src/views/admin/article/List.vue', 'FsusUiSegmentedControl', 'article status filters must directly consume the FsusUI segmented control')
expectNotIncludes('src/frontend/src/views/admin/article/List.vue', 'AdminSegmentedControl', 'article status filters must not retain the local segmented wrapper')
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
expectIncludes('src/frontend/src/locales/zh-CN/public.ts', '搜索文章、标签或关键词', 'public search placeholder must be specific')
expectIncludes('src/frontend/src/components/public/HomeFeedSurface.vue', '快速入口', 'home sidebar nav must be named quick entry')
expectIncludes('src/frontend/src/components/public/pages/PublicFilterPageContent.vue', '范围：文章、标签、关键词', 'search results must show scope and state')
expectIncludes('src/frontend/src/components/home/HomeArticleEmptyState.vue', '查看归档', 'public empty state must include next action')

if (failures.length > 0) {
  console.error(failures.map((failure) => `[ux-semantics] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[ux-semantics] ok')
