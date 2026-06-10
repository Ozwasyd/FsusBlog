<template>
  <div class="account-page dashboard-wrapper account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / ADMINISTRATION"
      title="站点工作台"
      description="先看关键指标和访问结构，再进入内容、用户与系统处理流程。"
    />

    <section class="mb-12 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="dashboard-today-actions-title">
      <header class="border-b border-[var(--fsusblog-panel-border)] p-6">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">今日待处理 / TODAY</div>
        <h2 id="dashboard-today-actions-title" class="mt-3 text-2xl font-bold text-[var(--fsusblog-text-primary)]">今日待处理</h2>
      </header>
      <div class="grid grid-cols-1 gap-px bg-[var(--fsusblog-panel-bg-soft)] sm:grid-cols-2 xl:grid-cols-4">
        <router-link
          v-for="action in todayActions"
          :key="action.label"
          :to="action.to"
          class="dashboard-action-card"
        >
          <span class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ action.label }}</span>
          <span class="mt-3 text-3xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ action.countText }}</span>
          <span class="mt-3 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">{{ action.helper }}</span>
        </router-link>
      </div>
    </section>

    <DashboardStatCards :view="dashboardView" />

    <DashboardAuthorAnalyticsPanel :view="dashboardView" class="mb-16" />

    <DashboardCommentModerationPanel class="mb-16" />

    <div class="grid grid-cols-1 lg:grid-cols-3 border-y border-[var(--fsusblog-panel-border)] mb-16">
      <section class="lg:col-span-1 border-r border-[var(--fsusblog-panel-border)] last:border-r-0 bg-[var(--fsusblog-page-bg)] p-8 flex flex-col">
        <header class="mb-10">
          <div class="flex items-center justify-between">
            <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">访问分析 / TRAFFIC</div>
            <el-tooltip content="对比注册用户与匿名访客的活跃度" placement="top">
              <span class="text-[var(--fsusblog-text-subtle)] cursor-help hover:text-[var(--fsusblog-color-primary)] transition-colors" aria-hidden="true">
                <el-icon><InfoFilled /></el-icon>
              </span>
            </el-tooltip>
          </div>
          <h3 class="mt-4 text-xl font-bold tracking-normal text-[var(--fsusblog-text-primary)]">访客来源构成</h3>
          <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">判断当前活跃主要来自注册用户还是匿名访问。</p>
        </header>
        <div class="flex-1">
          <div v-if="!loading && !hasVisitChartData" class="flex h-75 items-center justify-center">
            <el-empty description="暂无访问来源数据" />
          </div>
          <div v-else ref="visitChartRef" class="h-75 w-full" role="img" :aria-label="visitChartSummary" v-loading="loading"></div>
        </div>
      </section>

      <section class="lg:col-span-2 bg-[var(--fsusblog-page-bg)] p-8 flex flex-col">
        <header class="mb-10">
          <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">访问分析 / GEOGRAPHY</div>
          <h3 class="mt-4 text-xl font-bold tracking-normal text-[var(--fsusblog-text-primary)]">地域访问分布 (Top 10)</h3>
          <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">查看站点流量集中区域，辅助判断内容传播与读者来源。</p>
        </header>
        <div class="flex-1">
          <div v-if="!loading && !hasRegionChartData" class="flex h-75 items-center justify-center">
            <el-empty description="暂无地域访问数据" />
          </div>
          <div v-else ref="regionChartRef" class="h-75 w-full" role="img" :aria-label="regionChartSummary" v-loading="loading"></div>
        </div>
      </section>
    </div>

    <WorkbenchPanel
      class="mb-16 border-y-0 bg-transparent"
      eyebrow="工作流 / WORKFLOW"
      title="运营工作区"
      caption="集中处理内容表现、近期互动和常用管理入口。"
      title-id="dashboard-workflow-title"
      :title-level="2"
      header-class="px-0 pt-0"
    >
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-px bg-[var(--fsusblog-panel-bg-soft)] border-y border-[var(--fsusblog-panel-border)]">
        <DashboardOperationsPanel :view="dashboardView" />
        <DashboardPopularArticles :view="dashboardView" :loading="loading" />
        <DashboardRecentComments :view="dashboardView" :loading="loading" />
      </div>
    </WorkbenchPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { InfoFilled } from '@/fsusui/icons'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import DashboardAuthorAnalyticsPanel from '@/components/admin/DashboardAuthorAnalyticsPanel.vue'
import DashboardCommentModerationPanel from '@/components/admin/DashboardCommentModerationPanel.vue'
import DashboardOperationsPanel from '@/components/admin/DashboardOperationsPanel.vue'
import DashboardStatCards from '@/components/admin/DashboardStatCards.vue'
import DashboardRecentComments from '@/components/admin/DashboardRecentComments.vue'
import DashboardPopularArticles from '@/components/admin/DashboardPopularArticles.vue'
import { useAdminDashboard } from '@/composables/useAdminDashboard'
import { useCommentModerationQueue } from '@/composables/useCommentModerationQueue'
import { CommentModerationStatus } from '@/api/authoring'
import { messageApi } from '@/api/message'
import { showErrorToast } from '@/utils/errorPresentation'

const { loading, dashboardView, visitChartRef, regionChartRef } = useAdminDashboard()
void visitChartRef
void regionChartRef
const pendingTicketsCount = ref(0)
const cacheIncidentCount = ref(0)
const { counters: moderationCounters, refreshQueue: refreshModerationQueue } = useCommentModerationQueue({
  initialStatus: CommentModerationStatus.Pending,
  limit: 1
})
const hasVisitChartData = computed(() =>
  dashboardView.value.visitChart.registeredVisits > 0 || dashboardView.value.visitChart.anonymousVisits > 0
)
const hasRegionChartData = computed(() => dashboardView.value.regionChart.labels.length > 0)
const visitChartSummary = computed(() =>
  `访客来源构成，注册用户 ${dashboardView.value.visitChart.registeredVisits}，匿名访客 ${dashboardView.value.visitChart.anonymousVisits}`
)
const regionChartSummary = computed(() => {
  const items = dashboardView.value.regionChart.labels.map((label, index) => `${label} ${dashboardView.value.regionChart.values[index] ?? 0}`)
  return items.length > 0 ? `地域访问分布：${items.join('，')}` : '地域访问分布暂无数据'
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
</style>
