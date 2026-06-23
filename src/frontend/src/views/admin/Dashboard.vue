<template>
  <div class="account-page dashboard-wrapper account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact">
      <h1 class="account-page-title">站点工作台</h1>
      <p class="account-page-description">待处理事项、内容状态、访问数据与系统配置。</p>
    </header>

    <ConsoleWelcomeCallout
      class="mb-8"
      :user-key="consoleWelcomeUserKey"
    />

    <section class="mb-8 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="dashboard-today-actions-title">
      <header class="border-b border-[var(--fsusblog-panel-border)] px-6 py-4">
        <FsusUiSectionHeader
          id="dashboard-today-actions-title"
          class="dashboard-section-header--flush"
          title="今日待处理"
        />
      </header>
      <div class="grid grid-cols-1 gap-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <router-link
          v-for="action in todayActions"
          :key="action.label"
          :to="action.to"
          class="dashboard-action-card"
        >
          <span class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ action.label }}</span>
          <span class="mt-2 text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ action.countText }}</span>
          <span class="mt-2 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">{{ action.helper }}</span>
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

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="dashboard-workspaces-title">
      <header class="border-b border-[var(--fsusblog-panel-border)] px-6 py-5">
        <FsusUiSectionHeader
          id="dashboard-workspaces-title"
          class="dashboard-section-header--flush"
          title="工作区"
          description="进入专项页面处理数据、内容、互动和系统状态。"
        />
      </header>
      <div class="grid grid-cols-1 gap-5 py-5 sm:grid-cols-2 xl:grid-cols-4">
        <router-link
          v-for="entry in workspaceEntries"
          :key="entry.label"
          :to="entry.to"
          class="dashboard-entry-card"
        >
          <span class="dashboard-entry-card__title">{{ entry.label }}</span>
          <span class="dashboard-entry-card__description">{{ entry.description }}</span>
          <span class="dashboard-entry-card__action">{{ entry.action }}</span>
        </router-link>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import {
  FsusUiKpiGroup,
  FsusUiMetricItem,
  FsusUiSectionHeader
} from '@/fsusui'
import { ChatDotRound, Delete, Document, View } from '@/fsusui/icons'
import ConsoleWelcomeCallout from '@/components/admin/ConsoleWelcomeCallout.vue'
import { useAdminDashboard } from '@/composables/useAdminDashboard'
import { useCommentModerationQueue } from '@/composables/useCommentModerationQueue'
import { CommentModerationStatus } from '@/api/authoring'
import { messageApi } from '@/api/message'
import { useUserStore } from '@/store/user'
import { showErrorToast } from '@/utils/errorPresentation'

const { dashboardView } = useAdminDashboard()

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
const consoleWelcomeUserKey = computed(() => (
  userStore.userInfo?.publicHandle || userStore.userInfo?.accountId || 'local'
))

const pendingCommentCount = computed(() =>
  moderationCounters.value.find((item) => item.label === '待审')?.value ?? 0
)

const todayActions = computed<Array<{
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
    helper: cacheIncidentCount.value > 0 ? '查看缓存与索引' : '缓存状态暂无异常',
    to: { name: 'ManageCacheDiagnostics' }
  },
  {
    label: '写新文章',
    countText: '新稿',
    helper: '进入写作流程',
    to: { name: 'ManageWriteArticle' }
  }
])

const workspaceEntries: ReadonlyArray<{
  label: string
  description: string
  action: string
  to: RouteLocationRaw
}> = [
  {
    label: '数据概览',
    description: '阅读、搜索、运行指标与访问来源。',
    action: '查看数据',
    to: { name: 'ManageAnalytics' }
  },
  {
    label: '评论审核',
    description: '处理待审评论和审核记录。',
    action: '进入审核',
    to: { name: 'ManageModerationComments' }
  },
  {
    label: '缓存与索引',
    description: '检查公开缓存、索引与热榜状态。',
    action: '查看状态',
    to: { name: 'ManageCacheDiagnostics' }
  },
  {
    label: '内容管理',
    description: '管理文章、分类、标签和资产。',
    action: '管理内容',
    to: { name: 'ManageArticleList' }
  }
]

const loadPendingTicketCount = async (): Promise<void> => {
  try {
    const page = await messageApi.adminGetConversations(1, 1, 'pending')
    pendingTicketsCount.value = Number(page.total) || 0
  } catch (error) {
    showErrorToast(error, '待处理工单数量加载失败')
  }
}

onMounted(() => {
  refreshModerationQueue().catch((error: unknown) => showErrorToast(error, '评论待审数量加载失败'))
  loadPendingTicketCount().catch((error: unknown) => showErrorToast(error, '待处理工单数量加载失败'))
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
  min-height: 7rem;
  flex-direction: column;
  justify-content: center;
  background: var(--fsusblog-page-bg);
  padding: 1.25rem 1.5rem;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard), background var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-action-card:hover,
.dashboard-action-card:focus-visible {
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-color-primary);
  outline: none;
}

.dashboard-entry-card {
  display: flex;
  min-width: 0;
  min-height: 8rem;
  flex-direction: column;
  justify-content: space-between;
  background: var(--fsusblog-page-bg);
  padding: 1.5rem;
  transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard), background var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-entry-card:hover,
.dashboard-entry-card:focus-visible {
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-color-primary);
  outline: none;
}

.dashboard-entry-card__title {
  color: var(--fsusblog-text-primary);
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: 0;
  line-height: 1.35;
}

.dashboard-entry-card__description {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.dashboard-entry-card__action {
  color: var(--fsusblog-text-secondary);
  font-size: 0.8125rem;
  font-weight: 680;
  line-height: 1.4;
}
</style>
