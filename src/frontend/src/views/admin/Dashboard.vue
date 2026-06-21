<template>
  <div class="account-page dashboard-wrapper account-motion-enter w-full">
    <FsusUiPageHeader
      title="站点工作台"
      content="待处理事项、内容状态、访问数据与系统配置。"
    />

    <ConsoleWelcomeCallout
      class="mb-12"
      :user-key="consoleWelcomeUserKey"
    />

    <section class="mb-12 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="dashboard-today-actions-title">
      <header class="border-b border-[var(--fsusblog-panel-border)] px-6 py-5">
        <FsusUiSectionHeader
          id="dashboard-today-actions-title"
          class="dashboard-section-header--flush"
          title="今日待处理"
        />
      </header>
      <div class="grid grid-cols-1 gap-3 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <router-link
          v-for="action in todayActions"
          :key="action.label"
          :to="action.to"
          class="dashboard-action-card"
        >
          <span class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ action.label }}</span>
          <span class="mt-3 text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ action.countText }}</span>
          <span class="mt-3 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">{{ action.helper }}</span>
        </router-link>
      </div>
    </section>

    <FsusUiKpiGroup class="dashboard-stat-cards">
      <FsusUiMetricItem
        v-for="card in dashboardView.statCards"
        :key="card.key"
        :label="card.label"
        :primary="card.value"
        :meta="card.description"
      >
        <template #label>
          <span class="dashboard-stat-card-label">
            <el-icon size="18" aria-hidden="true">
              <component :is="statCardIconMap[card.iconName]" />
            </el-icon>
            {{ card.label }}
          </span>
        </template>
      </FsusUiMetricItem>
    </FsusUiKpiGroup>

    <DashboardAuthorAnalyticsPanel :view="dashboardView" class="mb-16" />

    <DashboardCommentModerationPanel class="mb-16" />

    <div class="grid grid-cols-1 lg:grid-cols-3 border-y border-[var(--fsusblog-panel-border)] mb-16">
      <section class="lg:col-span-1 border-r border-[var(--fsusblog-panel-border)] last:border-r-0 bg-[var(--fsusblog-page-bg)] p-8 flex flex-col">
        <header class="mb-6">
          <h3 class="dashboard-card-title">访客来源</h3>
          <p class="dashboard-card-description">注册用户与匿名访问分布。</p>
        </header>
        <div class="flex-1">
          <FsusUiEmptyState
            v-if="!loading && !hasVisitSourceData"
            class="mt-5 border-t border-[var(--fsusblog-panel-border)] pt-4"
            role="status"
            title="暂无访问来源数据"
            description="有访问记录后将在这里显示分布。"
          />
          <FsusUiDistributionList v-else class="mt-1" density="compact" v-loading="loading">
            <FsusUiDistributionBarRow
              v-for="item in visitSourceRows"
              :key="item.label"
              density="compact"
              :label="item.label"
              :value="item.value"
              :ratio="item.ratio"
            />
          </FsusUiDistributionList>
        </div>
      </section>

      <section class="lg:col-span-2 bg-[var(--fsusblog-page-bg)] p-8 flex flex-col">
        <header class="mb-6">
          <h3 class="dashboard-card-title">地域访问</h3>
          <p class="dashboard-card-description">流量来源区域分布。</p>
        </header>
        <div class="flex-1">
          <FsusUiEmptyState
            v-if="!loading && !hasRegionData"
            class="mt-5 border-t border-[var(--fsusblog-panel-border)] pt-4"
            role="status"
            title="暂无地域访问数据"
            description="有访问记录后将在这里显示分布。"
          />
          <div
            v-else-if="shouldUseRegionChart"
            ref="regionChartRef"
            class="h-75 w-full"
            role="img"
            :aria-label="regionChartSummary"
            v-loading="loading"
          ></div>
          <FsusUiDistributionList v-else class="mt-1" density="compact" v-loading="loading">
            <FsusUiDistributionBarRow
              v-for="item in regionRows"
              :key="item.label"
              density="compact"
              :rank="item.rank"
              :label="item.label"
              :value="item.value"
              :ratio="item.ratio"
            />
          </FsusUiDistributionList>
        </div>
      </section>
    </div>

    <FsusUiSettingsSection
      class="mb-16 border-y-0 bg-transparent"
      title="运营工作区"
      description="内容表现、近期互动和常用管理入口。"
      id="dashboard-workflow-title"
      :title-tag="'h2'"
    >
      <div class="grid grid-cols-1 gap-3 border-y border-[var(--fsusblog-panel-border)] py-3 xl:grid-cols-3">
        <DashboardOperationsPanel :view="dashboardView" />
        <DashboardPopularArticles :view="dashboardView" :loading="loading" />
        <DashboardRecentComments :view="dashboardView" :loading="loading" />
      </div>
    </FsusUiSettingsSection>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import {
  FsusUiDistributionBarRow,
  FsusUiDistributionList,
  FsusUiEmptyState,
  FsusUiKpiGroup,
  FsusUiMetricItem,
  FsusUiPageHeader,
  FsusUiSectionHeader,
  FsusUiSettingsSection
} from '@/fsusui'
import { ChatDotRound, Delete, Document, View } from '@/fsusui/icons'
import ConsoleWelcomeCallout from '@/components/admin/ConsoleWelcomeCallout.vue'
import DashboardAuthorAnalyticsPanel from '@/components/admin/DashboardAuthorAnalyticsPanel.vue'
import DashboardCommentModerationPanel from '@/components/admin/DashboardCommentModerationPanel.vue'
import DashboardOperationsPanel from '@/components/admin/DashboardOperationsPanel.vue'
import DashboardRecentComments from '@/components/admin/DashboardRecentComments.vue'
import DashboardPopularArticles from '@/components/admin/DashboardPopularArticles.vue'
import { useAdminDashboard } from '@/composables/useAdminDashboard'
import { useCommentModerationQueue } from '@/composables/useCommentModerationQueue'
import { CommentModerationStatus } from '@/api/authoring'
import { messageApi } from '@/api/message'
import { useUserStore } from '@/store/user'
import { showErrorToast } from '@/utils/errorPresentation'

const { loading, dashboardView, regionChartRef } = useAdminDashboard()
void regionChartRef

const statCardIconMap = {
  document: Document,
  comments: ChatDotRound,
  views: View,
  trash: Delete
} as const

const userStore = useUserStore()
const pendingTicketsCount = ref(0)
const cacheIncidentCount = ref(0)
const { counters: moderationCounters, refreshQueue: refreshModerationQueue } = useCommentModerationQueue({
  initialStatus: CommentModerationStatus.Pending,
  limit: 1
})
type DistributionRow = Readonly<{
  label: string
  value: string
  ratio: number
  rank: number
}>

const toDistributionRows = (items: readonly { label: string; count: number }[]): readonly DistributionRow[] => {
  const maxCount = Math.max(0, ...items.map((item) => Number(item.count) || 0))
  return items.map((item, index) => {
    const count = Number(item.count) || 0
    return {
      label: item.label,
      value: String(count),
      ratio: maxCount > 0 ? count / maxCount : 0,
      rank: index + 1
    }
  })
}

const hasVisitSourceData = computed(() =>
  dashboardView.value.visitChart.articleReads > 0
    || dashboardView.value.visitChart.siteReads > 0
    || dashboardView.value.visitChart.humanVerifiedReads > 0
    || dashboardView.value.visitChart.uniqueViewerKeyEstimate > 0
)
const visitSourceRows = computed(() => toDistributionRows([
  { label: '文章阅读', count: dashboardView.value.visitChart.articleReads },
  { label: '站点阅读', count: dashboardView.value.visitChart.siteReads },
  { label: '真人 proof', count: dashboardView.value.visitChart.humanVerifiedReads },
  { label: '独立 viewer key', count: dashboardView.value.visitChart.uniqueViewerKeyEstimate }
]))
const regionRows = computed(() => toDistributionRows(
  dashboardView.value.regionChart.labels.map((label, index) => ({
    label,
    count: dashboardView.value.regionChart.values[index] ?? 0
  }))
))
const hasRegionData = computed(() => regionRows.value.length > 0)
const shouldUseRegionChart = computed(() => regionRows.value.length >= 3)
const consoleWelcomeUserKey = computed(() => (
  userStore.userInfo?.publicHandle || userStore.userInfo?.accountId || 'local'
))
const regionChartSummary = computed(() => {
  const items = regionRows.value.map((item) => `${item.label} ${item.value}`)
  return items.length > 0 ? `地域访问：${items.join('，')}` : '地域访问暂无数据'
})

const pendingCommentCount = computed(() =>
  moderationCounters.value.find((item) => item.label === '待审')?.value ?? 0
)

const todayActions = computed<ReadonlyArray<{
  label: string
  countText: string
  helper: string
  to: RouteLocationRaw
}>>(() => [
  {
    label: '评论待审',
    countText: `${pendingCommentCount.value}`,
    helper: pendingCommentCount.value > 0 ? '进入评论审核队列' : '评论队列已处理完成',
    to: { name: 'ManageModerationComments' }
  },
  {
    label: '工单待处理',
    countText: `${pendingTicketsCount.value}`,
    helper: pendingTicketsCount.value > 0 ? '进入站内信处理待办' : '暂无待处理工单',
    to: { name: 'ManageMessages' }
  },
  {
    label: '缓存异常',
    countText: `${cacheIncidentCount.value}`,
    helper: cacheIncidentCount.value > 0 ? '查看缓存诊断' : '缓存状态暂无异常',
    to: { name: 'ManageCacheDiagnostics' }
  },
  {
    label: '写新文章',
    countText: '新稿',
    helper: '进入写作流程',
    to: { name: 'ManageWriteArticle' }
  }
])

const loadPendingTicketCount = async (): Promise<void> => {
  try {
    const page = await messageApi.adminGetConversations(1, 1, 'pending')
    pendingTicketsCount.value = Number(page.total) || 0
  } catch (error) {
    showErrorToast(error, '待处理工单数量加载失败')
  }
}

onMounted(() => {
  void refreshModerationQueue()
  void loadPendingTicketCount()
})
</script>

<style scoped>
.word-break-all {
  word-break: break-all;
  overflow-wrap: break-word;
}

.dashboard-action-card {
  display: flex;
  min-width: 0;
  min-height: 9rem;
  flex-direction: column;
  justify-content: center;
  background: var(--fsusblog-page-bg);
  padding: 1.5rem;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard), background var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-action-card:hover,
.dashboard-action-card:focus-visible {
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-color-primary);
  outline: none;
}

.dashboard-card-title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: 0;
  line-height: 1.35;
}

.dashboard-card-description {
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.6;
}
</style>
