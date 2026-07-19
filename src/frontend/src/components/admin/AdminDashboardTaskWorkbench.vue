<template>
  <div class="account-page dashboard-wrapper account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact dashboard-page-header">
      <div class="dashboard-page-header__copy">
        <h1 class="account-page-title">站点工作台</h1>
        <p class="account-page-description">先处理今天的内容、互动与运行待办。</p>
      </div>

      <details v-if="helpLinks.length > 0" class="dashboard-help-menu">
        <summary class="dashboard-help-menu__trigger">帮助与反馈</summary>
        <nav class="dashboard-help-menu__links" aria-label="帮助与反馈入口">
          <a
            v-for="link in helpLinks"
            :key="link.key"
            class="dashboard-help-menu__link"
            :href="link.href"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ link.label }}
          </a>
        </nav>
      </details>
    </header>

    <section class="dashboard-work-section" aria-labelledby="dashboard-today-actions-title">
      <header class="dashboard-work-section__header">
        <FsusUiSectionHeader
          id="dashboard-today-actions-title"
          class="dashboard-section-header--flush"
          title="今日待处理"
        />
      </header>
      <ul class="dashboard-task-list" role="list" aria-label="今日待处理任务">
        <li
          v-for="action in todayActions"
          :key="action.key"
          class="dashboard-task-list__item"
        >
          <router-link
            :to="action.to"
            class="dashboard-task-row"
            :data-state="action.state"
            :aria-label="`${action.label}：${action.countText}。${action.helper}`"
          >
            <span class="dashboard-task-row__copy">
              <span class="dashboard-task-row__label">{{ action.label }}</span>
              <span class="dashboard-task-row__helper">{{ action.helper }}</span>
            </span>
            <span class="dashboard-task-row__value">{{ action.countText }}</span>
          </router-link>
        </li>
      </ul>
    </section>

    <section class="dashboard-summary" aria-labelledby="dashboard-summary-title">
      <header class="dashboard-summary__header">
        <h2 id="dashboard-summary-title">站点摘要</h2>
        <router-link :to="{ name: 'ManageAnalytics' }" class="dashboard-summary__details">
          查看详细分析
        </router-link>
      </header>

      <div v-if="summaryLoading" class="dashboard-inline-state" role="status" aria-live="polite">
        正在读取站点摘要…
      </div>

      <div v-else-if="summaryErrorMessage" class="dashboard-inline-state dashboard-inline-state--error" role="alert">
        <span>站点摘要读取失败；请重新加载。</span>
        <button type="button" class="dashboard-inline-action" @click="$emit('refresh-summary')">
          重新加载摘要
        </button>
      </div>

      <template v-else-if="summaryLoaded">
        <p v-if="!hasSummaryData" class="dashboard-summary__empty" role="status">
          站点尚未产生内容或互动；先写新文章，发布后摘要会自动更新。
        </p>
        <dl class="dashboard-stat-ledger" aria-label="站点统计摘要">
          <div v-for="item in ledgerItems" :key="item.key" class="dashboard-stat-ledger__item">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
      </template>

      <div v-else class="dashboard-inline-state" role="status">
        <span>站点摘要尚未检查。</span>
        <button type="button" class="dashboard-inline-action" @click="$emit('refresh-summary')">
          立即检查
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { FsusUiSectionHeader } from '@/fsusui'
import type { ConsoleSupportLink } from '@/config/consoleWelcomeCallout'
import type {
  AdminDashboardLedgerItem,
  AdminDashboardTaskItem
} from '@/view-contracts/adminDashboard'

defineProps<{
  hasSummaryData: boolean
  helpLinks: readonly ConsoleSupportLink[]
  ledgerItems: readonly AdminDashboardLedgerItem[]
  summaryErrorMessage: string
  summaryLoaded: boolean
  summaryLoading: boolean
  todayActions: readonly AdminDashboardTaskItem[]
}>()

defineEmits<{
  (e: 'refresh-summary'): void
}>()
</script>

<style scoped>
.dashboard-page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.dashboard-page-header__copy {
  min-width: 0;
}

.dashboard-help-menu {
  position: relative;
  flex: 0 0 auto;
}

.dashboard-help-menu__trigger,
.dashboard-help-menu__link {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  color: var(--fsusblog-text-secondary);
  font-size: 0.8125rem;
  font-weight: 700;
}

.dashboard-help-menu__trigger {
  justify-content: center;
  cursor: pointer;
  list-style: none;
  padding-inline: 0.5rem;
}

.dashboard-help-menu__trigger::-webkit-details-marker {
  display: none;
}

.dashboard-help-menu__trigger::after {
  content: '＋';
  margin-inline-start: 0.375rem;
  color: var(--fsusblog-text-muted);
}

.dashboard-help-menu[open] .dashboard-help-menu__trigger::after {
  content: '−';
}

.dashboard-help-menu__trigger:hover,
.dashboard-help-menu__trigger:focus-visible,
.dashboard-help-menu__link:hover,
.dashboard-help-menu__link:focus-visible {
  color: var(--fsusblog-color-primary);
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: 2px;
}

.dashboard-help-menu__links {
  position: absolute;
  z-index: 10;
  top: calc(100% + 0.375rem);
  right: 0;
  display: grid;
  width: max-content;
  min-width: 9rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-panel-bg);
  box-shadow: var(--fsus-shadow-floating);
  padding-block: 0.25rem;
}

.dashboard-help-menu__link {
  padding-inline: 0.75rem;
}

.dashboard-work-section,
.dashboard-summary {
  border-block: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.dashboard-work-section {
  margin-bottom: 1.5rem;
}

.dashboard-work-section__header,
.dashboard-summary__header {
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding: 0.75rem 1.25rem;
}

.dashboard-task-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dashboard-task-list__item {
  min-width: 0;
  margin: 0;
}

.dashboard-task-list__item + .dashboard-task-list__item {
  border-top: 1px solid var(--fsusblog-panel-border);
}

.dashboard-task-row {
  display: grid;
  min-width: 0;
  min-height: 3.25rem;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 0.625rem 1.25rem;
  color: inherit;
  transition:
    background var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-task-row:hover,
.dashboard-task-row:focus-visible {
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-color-primary);
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: -2px;
}

.dashboard-task-row__copy {
  display: grid;
  min-width: 0;
  gap: 0.125rem;
}

.dashboard-task-row__label {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.35;
}

.dashboard-task-row__helper {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.4;
}

.dashboard-task-row__value {
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  text-align: end;
  white-space: nowrap;
}

.dashboard-task-row[data-state="loading"] .dashboard-task-row__value,
.dashboard-task-row[data-state="idle"] .dashboard-task-row__value {
  color: var(--fsusblog-text-muted);
}

.dashboard-task-row[data-state="error"] .dashboard-task-row__value {
  color: var(--fsusblog-color-error);
}

.dashboard-summary {
  margin-bottom: 2rem;
}

.dashboard-summary__header {
  display: flex;
  min-height: 3rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.dashboard-summary__header h2 {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.35;
}

.dashboard-summary__details,
.dashboard-inline-action {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--fsusblog-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 700;
  padding: 0 0.25rem;
}

.dashboard-summary__details:hover,
.dashboard-summary__details:focus-visible,
.dashboard-inline-action:hover,
.dashboard-inline-action:focus-visible {
  color: var(--fsusblog-color-primary);
  outline: 2px solid var(--fsusblog-color-focus-ring);
  outline-offset: 2px;
}

.dashboard-summary__empty,
.dashboard-inline-state {
  margin: 0;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.45;
  padding: 0.75rem 1.25rem;
}

.dashboard-inline-state {
  display: flex;
  min-height: 3.25rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.dashboard-inline-state:last-child {
  border-bottom: 0;
}

.dashboard-inline-state--error {
  color: var(--fsusblog-color-error);
}

.dashboard-stat-ledger {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}

.dashboard-stat-ledger__item {
  display: flex;
  min-width: 0;
  min-height: 3.25rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-left: 1px solid var(--fsusblog-panel-border);
  padding: 0.75rem 1rem;
}

.dashboard-stat-ledger__item:first-child {
  border-left: 0;
}

.dashboard-stat-ledger dt,
.dashboard-stat-ledger dd {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.35;
}

.dashboard-stat-ledger dt {
  min-width: 0;
  color: var(--fsusblog-text-secondary);
  font-weight: 700;
  white-space: nowrap;
}

.dashboard-stat-ledger dd {
  color: var(--fsusblog-text-primary);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: end;
}

@media (max-width: 640px) {
  .dashboard-page-header {
    align-items: stretch;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dashboard-help-menu {
    align-self: flex-start;
  }

  .dashboard-help-menu__links {
    right: auto;
    left: 0;
  }

  .dashboard-work-section__header,
  .dashboard-summary__header,
  .dashboard-task-row,
  .dashboard-summary__empty,
  .dashboard-inline-state {
    padding-inline: 0.875rem;
  }

  .dashboard-task-row {
    gap: 0.75rem;
  }

  .dashboard-stat-ledger {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard-stat-ledger__item {
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-inline: 0.875rem;
  }

  .dashboard-stat-ledger__item:nth-child(-n + 2) {
    border-top: 0;
  }

  .dashboard-stat-ledger__item:nth-child(odd) {
    border-left: 0;
  }

  .dashboard-stat-ledger__item:nth-child(even) {
    border-left: 1px solid var(--fsusblog-panel-border);
  }

  .dashboard-inline-state {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.25rem;
  }
}
</style>
