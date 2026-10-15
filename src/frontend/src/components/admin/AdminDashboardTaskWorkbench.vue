<template>
    <div class="account-page dashboard-wrapper account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="站点工作台"
            class="account-task-page-header"
            density="compact"
        >
            <template #actions>
                <details
                    v-if="helpLinks.length > 0"
                    class="dashboard-help-menu"
                >
                    <summary class="dashboard-help-menu__trigger">帮助与反馈</summary>
                    <nav
                        class="dashboard-help-menu__links"
                        aria-label="帮助与反馈入口"
                    >
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
            </template>
        </FsusUiTaskPageHeader>

        <section
            class="dashboard-work-section"
            aria-labelledby="dashboard-today-actions-title"
        >
            <header class="dashboard-work-section__header">
                <FsusUiSectionHeader
                    id="dashboard-today-actions-title"
                    class="dashboard-section-header--flush"
                    title="今日待处理"
                />
            </header>
            <ul
                v-if="pendingActions.length > 0"
                class="dashboard-task-list"
                role="list"
                aria-label="今日待处理任务"
            >
                <li
                    v-for="action in pendingActions"
                    :key="action.key"
                    class="dashboard-task-list__item"
                >
                    <RouterLink
                        :to="action.to"
                        class="dashboard-task-row"
                        :data-state="action.state"
                        :aria-label="`${action.label}：${action.countText}。${action.helper}`"
                    >
                        <span class="dashboard-task-row__copy">
                            <span class="dashboard-task-row__label">{{ action.label }}</span>
                            <span class="dashboard-task-row__helper">{{ action.helper }}</span>
                        </span>
                        <span class="dashboard-task-row__end">
                            <span class="dashboard-task-row__value">{{ action.countText }}</span>
                            <span class="dashboard-task-row__cta">
                                {{ action.state === 'ready' ? '处理' : '检查' }}
                            </span>
                        </span>
                    </RouterLink>
                </li>
            </ul>
            <div
                v-else
                class="dashboard-healthy-empty"
                role="status"
            >
                <span class="dashboard-healthy-empty__copy">
                    <strong>暂无待处理任务</strong>
                    <span>审核、工单与运行队列均已清空，可以继续内容工作。</span>
                </span>
                <RouterLink
                    v-if="writeAction"
                    :to="writeAction.to"
                    class="dashboard-primary-action"
                >
                    写新文章
                </RouterLink>
            </div>
        </section>

        <section
            class="dashboard-changes"
            aria-labelledby="dashboard-recent-changes-title"
        >
            <header class="dashboard-summary__header">
                <h2 id="dashboard-recent-changes-title">最近变更</h2>
                <RouterLink
                    v-if="canViewAuditLog"
                    :to="{ name: 'ManageAuditLog' }"
                    class="dashboard-summary__details"
                >
                    查看审计记录
                </RouterLink>
            </header>

            <div
                v-if="recentChangesLoading"
                class="dashboard-inline-state"
                role="status"
                aria-live="polite"
            >
                正在读取最近变更…
            </div>

            <div
                v-else-if="recentChangesErrorMessage"
                class="dashboard-inline-state dashboard-inline-state--error"
                role="alert"
            >
                <span>最近变更读取失败；任务区仍可继续使用。</span>
                <FsusUiButton
                    native-type="button"
                    link
                    inline-action
                    @click="$emit('refresh-recent-changes')"
                >
                    重新加载变更
                </FsusUiButton>
            </div>

            <ul
                v-else-if="recentChanges.length > 0"
                class="dashboard-change-list"
                role="list"
            >
                <li
                    v-for="change in recentChanges"
                    :key="change.id"
                    class="dashboard-change-list__item"
                >
                    <RouterLink
                        :to="change.to"
                        class="dashboard-change-row"
                    >
                        <span class="dashboard-change-row__category">{{ change.category }}</span>
                        <span class="dashboard-change-row__title">{{ change.title }}</span>
                        <time :datetime="change.occurredAtUtc">{{ formatChangeTime(change.occurredAtUtc) }}</time>
                    </RouterLink>
                </li>
            </ul>

            <div
                v-else
                class="dashboard-inline-state"
                role="status"
            >
                <span>{{ recentChangesLoaded ? '最近变更中暂无新记录。' : '最近变更尚未检查。' }}</span>
                <FsusUiButton
                    v-if="!recentChangesLoaded"
                    native-type="button"
                    link
                    inline-action
                    @click="$emit('refresh-recent-changes')"
                >
                    立即检查
                </FsusUiButton>
            </div>
        </section>

        <section
            class="dashboard-summary"
            aria-labelledby="dashboard-summary-title"
        >
            <header class="dashboard-summary__header">
                <h2 id="dashboard-summary-title">系统状态</h2>
                <nav
                    class="dashboard-summary__links"
                    aria-label="系统状态详情"
                >
                    <RouterLink
                        :to="systemStatus.to"
                        class="dashboard-summary__details"
                    >
                        查看运行诊断
                    </RouterLink>
                    <RouterLink
                        :to="{ name: 'ManageAnalytics' }"
                        class="dashboard-summary__details"
                    >
                        查看详细分析
                    </RouterLink>
                </nav>
            </header>

            <RouterLink
                :to="systemStatus.to"
                class="dashboard-system-status"
                :data-state="systemStatus.state"
            >
                <span class="dashboard-system-status__copy">
                    <strong>{{ systemStatus.label }}</strong>
                    <span>{{ systemStatus.helper }}</span>
                </span>
                <span class="dashboard-system-status__action">
                    {{ systemStatus.state === 'healthy' ? '查看详情' : '检查' }}
                </span>
            </RouterLink>

            <div
                v-if="summaryLoading"
                class="dashboard-inline-state"
                role="status"
                aria-live="polite"
            >
                正在读取站点摘要…
            </div>

            <div
                v-else-if="summaryErrorMessage"
                class="dashboard-inline-state dashboard-inline-state--error"
                role="alert"
            >
                <span>站点摘要读取失败；系统状态不受影响。</span>
                <FsusUiButton
                    native-type="button"
                    link
                    inline-action
                    @click="$emit('refresh-summary')"
                >
                    重新加载摘要
                </FsusUiButton>
            </div>

            <template v-else-if="summaryLoaded">
                <p
                    v-if="!hasSummaryData"
                    class="dashboard-summary__empty"
                    role="status"
                >
                    站点尚未产生内容或互动；发布内容后摘要会自动更新。
                </p>
                <dl
                    class="dashboard-stat-ledger"
                    aria-label="站点统计摘要"
                >
                    <div
                        v-for="item in ledgerItems"
                        :key="item.key"
                        class="dashboard-stat-ledger__item"
                    >
                        <dt>{{ item.label }}</dt>
                        <dd>{{ item.value }}</dd>
                    </div>
                </dl>
            </template>

            <div
                v-else
                class="dashboard-inline-state"
                role="status"
            >
                <span>站点摘要尚未检查。</span>
                <FsusUiButton
                    native-type="button"
                    link
                    inline-action
                    @click="$emit('refresh-summary')"
                >
                    立即检查
                </FsusUiButton>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import type { ConsoleSupportLink } from '@/config/consoleWelcomeCallout';
import { FsusUiSectionHeader, FsusUiTaskPageHeader } from '@/fsusui';
import { FsusUiButton } from '@/fsusui/button';
import type {
    AdminDashboardLedgerItem,
    AdminDashboardRecentChangeItem,
    AdminDashboardSystemStatus,
    AdminDashboardTaskItem
} from '@/view-contracts/adminDashboard';

defineProps<{
    canViewAuditLog: boolean;
    hasSummaryData: boolean;
    helpLinks: readonly ConsoleSupportLink[];
    ledgerItems: readonly AdminDashboardLedgerItem[];
    pendingActions: readonly AdminDashboardTaskItem<string>[];
    recentChanges: readonly AdminDashboardRecentChangeItem[];
    recentChangesErrorMessage: string;
    recentChangesLoaded: boolean;
    recentChangesLoading: boolean;
    summaryErrorMessage: string;
    summaryLoaded: boolean;
    summaryLoading: boolean;
    systemStatus: AdminDashboardSystemStatus;
    writeAction: AdminDashboardTaskItem<string> | null;
}>();

defineEmits<{
    (e: 'refresh-recent-changes'): void;
    (e: 'refresh-summary'): void;
}>();

const formatChangeTime = (value: string): string =>
{
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
    {
        return '时间未知';
    }
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
};
</script>

<style scoped>
.dashboard-help-menu
 {
    position: relative;
    flex: 0 0 auto;
}

.dashboard-help-menu__trigger,
.dashboard-help-menu__link
 {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    font-weight: 700;
}

.dashboard-help-menu__trigger
 {
    justify-content: center;
    cursor: pointer;
    list-style: none;
    padding-inline: var(--fsus-space-2);
}

.dashboard-help-menu__trigger::-webkit-details-marker
 {
    display: none;
}

.dashboard-help-menu__trigger::after
 {
    content: '＋';
    margin-inline-start: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
}

.dashboard-help-menu[open] .dashboard-help-menu__trigger::after
 {
    content: '−';
}

.dashboard-help-menu__trigger:hover,
.dashboard-help-menu__link:hover
 {
    color: var(--fsusblog-color-primary);
}

.dashboard-help-menu__trigger:focus-visible,
.dashboard-help-menu__link:focus-visible
 {
    color: var(--fsusblog-color-primary);
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.dashboard-help-menu__links
 {
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
    padding-block: var(--fsus-space-1);
}

.dashboard-help-menu__link
 {
    padding-inline: var(--fsus-space-3);
}

.dashboard-work-section,
.dashboard-changes,
.dashboard-summary
 {
    border-block: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
}

.dashboard-work-section,
.dashboard-changes
 {
    margin-bottom: var(--fsus-space-6);
}

.dashboard-work-section__header,
.dashboard-summary__header
 {
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-3) var(--fsus-space-5);
}

.dashboard-task-list
 {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
}

.dashboard-task-list__item
 {
    min-width: 0;
    margin: 0;
}

.dashboard-task-list__item + .dashboard-task-list__item
 {
    border-top: 1px solid var(--fsusblog-panel-border);
}

.dashboard-task-row
 {
    display: grid;
    min-width: 0;
    min-height: 3.25rem;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fsus-space-4);
    padding: var(--fsus-space-2) var(--fsus-space-4);
    color: inherit;
    transition:
        background var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.dashboard-task-row:hover,
.dashboard-task-row:focus-visible
 {
    background: var(--fsusblog-panel-bg);
    color: var(--fsusblog-color-primary);
}

.dashboard-task-row:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.dashboard-task-row__copy
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.dashboard-task-row__label
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

.dashboard-task-row__helper
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.4;
}

.dashboard-task-row__value
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
    text-align: end;
    white-space: nowrap;
}

.dashboard-task-row__end
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-3);
}

.dashboard-task-row__cta,
.dashboard-primary-action,
.dashboard-system-status__action
 {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.2;
    padding-inline: var(--fsus-space-3);
    white-space: nowrap;
}

.dashboard-task-row:hover .dashboard-task-row__cta,
.dashboard-task-row:focus-visible .dashboard-task-row__cta,
.dashboard-primary-action:hover,
.dashboard-primary-action:focus-visible,
.dashboard-system-status:hover .dashboard-system-status__action,
.dashboard-system-status:focus-visible .dashboard-system-status__action
 {
    border-color: var(--fsusblog-color-primary);
    color: var(--fsusblog-color-primary);
}

.dashboard-primary-action:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.dashboard-task-row[data-state="loading"] .dashboard-task-row__value,
.dashboard-task-row[data-state="idle"] .dashboard-task-row__value
 {
    color: var(--fsusblog-text-muted);
}

.dashboard-task-row[data-state="error"] .dashboard-task-row__value
 {
    color: var(--fsusblog-color-error);
}

.dashboard-healthy-empty
 {
    display: flex;
    min-height: 4rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    padding: var(--fsus-space-2) var(--fsus-space-4);
}

.dashboard-healthy-empty__copy,
.dashboard-system-status__copy
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.45;
}

.dashboard-healthy-empty__copy strong,
.dashboard-system-status__copy strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 500;
}

.dashboard-summary
 {
    margin-bottom: var(--fsus-space-8);
}

.dashboard-summary__header
 {
    display: flex;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
}

.dashboard-summary__header h2
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

.dashboard-summary__links
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
}

.dashboard-summary__details
 {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--fsusblog-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    padding: 0 var(--fsus-space-1);
}

.dashboard-summary__details:hover
 {
    color: var(--fsusblog-color-primary);
}

.dashboard-summary__details:focus-visible
 {
    color: var(--fsusblog-color-primary);
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.dashboard-change-list
 {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
}

.dashboard-change-list__item + .dashboard-change-list__item
 {
    border-top: 1px solid var(--fsusblog-panel-border);
}

.dashboard-change-row
 {
    display: grid;
    min-height: 3.25rem;
    min-width: 0;
    grid-template-columns: 3rem minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fsus-space-3);
    color: inherit;
    padding: var(--fsus-space-2) var(--fsus-space-4);
}

.dashboard-change-row:hover,
.dashboard-change-row:focus-visible
 {
    background: var(--fsusblog-page-bg-soft);
}

.dashboard-change-row:focus-visible,
.dashboard-system-status:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.dashboard-change-row__category
 {
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.45;
}

.dashboard-change-row__title
 {
    overflow: hidden;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dashboard-change-row time
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.45;
    white-space: nowrap;
}

.dashboard-system-status
 {
    display: grid;
    min-height: 3.5rem;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fsus-space-4);
    border-bottom: 1px solid var(--fsusblog-panel-border);
    color: inherit;
    padding: var(--fsus-space-2) var(--fsus-space-4);
}

.dashboard-system-status[data-state="attention"] .dashboard-system-status__copy strong,
.dashboard-system-status[data-state="error"] .dashboard-system-status__copy strong
 {
    color: var(--fsusblog-color-error);
}

.dashboard-summary__empty,
.dashboard-inline-state
 {
    margin: 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.45;
    padding: var(--fsus-space-3) var(--fsus-space-5);
}

.dashboard-inline-state
 {
    display: flex;
    min-height: 3.25rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
}

.dashboard-inline-state:last-child
 {
    border-bottom: 0;
}

.dashboard-inline-state--error
 {
    color: var(--fsusblog-color-error);
}

.dashboard-stat-ledger
 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 0;
}

.dashboard-stat-ledger__item
 {
    display: flex;
    min-width: 0;
    min-height: 3.25rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-3);
    border-left: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-3) var(--fsus-space-4);
}

.dashboard-stat-ledger__item:first-child
 {
    border-left: 0;
}

.dashboard-stat-ledger dt,
.dashboard-stat-ledger dd
 {
    margin: 0;
    font-size: 14px;
    line-height: 1.35;
}

.dashboard-stat-ledger dt
 {
    min-width: 0;
    color: var(--fsusblog-text-secondary);
    font-weight: 700;
    white-space: nowrap;
}

.dashboard-stat-ledger dd
 {
    color: var(--fsusblog-text-primary);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: end;
}

@media (width <= 639px)
 {
    .dashboard-help-menu
 {
        align-self: flex-start;
    }

    .dashboard-help-menu__links
 {
        right: auto;
        left: 0;
    }

    .dashboard-work-section__header,
    .dashboard-summary__header,
    .dashboard-task-row,
    .dashboard-change-row,
    .dashboard-system-status,
    .dashboard-healthy-empty,
    .dashboard-summary__empty,
    .dashboard-inline-state
 {
        padding-inline: var(--fsus-space-3);
    }

    .dashboard-task-row
 {
        gap: var(--fsus-space-3);
    }

    .dashboard-task-row__end
 {
        gap: var(--fsus-space-2);
    }

    .dashboard-task-row__cta,
    .dashboard-primary-action,
    .dashboard-system-status__action
 {
        min-height: 2.75rem;
    }

    .dashboard-healthy-empty
 {
        align-items: stretch;
        flex-direction: column;
    }

    .dashboard-change-row
 {
        grid-template-columns: auto minmax(0, 1fr);
    }

    .dashboard-change-row time
 {
        grid-column: 2;
    }

    .dashboard-system-status
 {
        align-items: stretch;
        grid-template-columns: 1fr;
    }

    .dashboard-stat-ledger
 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .dashboard-stat-ledger__item
 {
        border-top: 1px solid var(--fsusblog-panel-border);
        padding-inline: var(--fsus-space-3);
    }

    .dashboard-stat-ledger__item:nth-child(-n + 2)
 {
        border-top: 0;
    }

    .dashboard-stat-ledger__item:nth-child(odd)
 {
        border-left: 0;
    }

    .dashboard-stat-ledger__item:nth-child(even)
 {
        border-left: 1px solid var(--fsusblog-panel-border);
    }

    .dashboard-inline-state
 {
        align-items: flex-start;
        flex-direction: column;
        gap: var(--fsus-space-1);
    }
}
</style>
