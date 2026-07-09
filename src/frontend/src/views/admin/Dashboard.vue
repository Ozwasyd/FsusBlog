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
      <div class="dashboard-task-list" aria-label="今日待处理任务">
        <router-link
          v-for="action in todayActions"
          :key="action.label"
          :to="action.to"
          class="dashboard-task-row"
        >
          <span class="dashboard-task-row__copy">
            <span class="dashboard-task-row__label">{{ action.label }}</span>
            <span class="dashboard-task-row__helper">{{ action.helper }}</span>
          </span>
          <span class="dashboard-task-row__value">{{ action.countText }}</span>
        </router-link>
      </div>
    </section>

    <div class="dashboard-stat-cards" role="list" aria-label="站点统计">
      <div
        v-for="card in dashboardView.statCards"
        :key="card.key"
        class="dashboard-stat-card"
        role="listitem"
      >
        <span class="dashboard-stat-card-label">
          <el-icon size="16" aria-hidden="true" class="dashboard-stat-card-icon">
            <component :is="statCardIconMap[card.iconName]" />
          </el-icon>
          {{ card.label }}
        </span>
        <strong class="dashboard-stat-card-value">{{ card.value }}</strong>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import {
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
    label: '评论审核',
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

.dashboard-task-list {
  display: grid;
  background: var(--fsusblog-page-bg);
}

.dashboard-task-row {
  display: grid;
  min-width: 0;
  min-height: 3.5rem;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 0.875rem 1.5rem;
  color: inherit;
  transition: background var(--fsus-motion-control-fast) var(--fsus-motion-standard), color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-task-row:first-child {
  border-top: 0;
}

.dashboard-task-row:hover,
.dashboard-task-row:focus-visible {
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-color-primary);
  outline: 2px solid var(--fsusblog-color-primary);
  outline-offset: -2px;
}

.dashboard-task-row__copy {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}

.dashboard-task-row__label {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1.4;
}

.dashboard-task-row__helper {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.dashboard-task-row__value {
  color: var(--fsusblog-text-primary);
  font-size: 1rem;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.dashboard-stat-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin-bottom: 2rem;
  border-block: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.dashboard-stat-card {
  display: grid;
  min-height: 4rem;
  grid-template-columns: minmax(0, 1fr) minmax(3ch, auto);
  align-items: center;
  gap: 1rem;
  min-width: 0;
  padding: 0.875rem 1.125rem;
  border-left: 1px solid var(--fsusblog-panel-border);
}

.dashboard-stat-card:nth-child(4n + 1) {
  border-left: 0;
}

.dashboard-stat-card-label {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.375rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  font-weight: 680;
  line-height: 1.35;
  white-space: nowrap;
}

.dashboard-stat-card-icon {
  flex: 0 0 auto;
  color: var(--fsusblog-text-muted);
}

.dashboard-stat-card-value {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  overflow-wrap: normal;
  text-align: end;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .dashboard-stat-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard-stat-card {
    gap: 0.75rem;
    padding-inline: 0.875rem;
    border-top: 1px solid var(--fsusblog-panel-border);
  }

  .dashboard-stat-card:nth-child(-n + 2) {
    border-top: 0;
  }

  .dashboard-stat-card:nth-child(odd) {
    border-left: 0;
  }

  .dashboard-stat-card:nth-child(even) {
    border-left: 1px solid var(--fsusblog-panel-border);
  }
}
</style>
