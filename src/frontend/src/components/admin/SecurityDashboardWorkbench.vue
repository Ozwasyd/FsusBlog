<template>
    <div
        class="security-workbench"
        data-security-dashboard-workbench
    >
        <section
            class="security-workbench__status"
            :data-status="model.status"
            aria-labelledby="security-status-title"
        >
            <div class="security-workbench__status-copy">
                <h2 id="security-status-title">
                    {{ model.status === 'healthy' ? '运行状态正常' : '需要处理安全异常' }}
                </h2>
                <p>{{ model.statusCopy }}</p>
            </div>
            <span
                v-if="model.tasks.length > 0"
                class="security-workbench__count"
                :aria-label="`${model.tasks.length} 类异常`"
            >
                {{ model.tasks.length }}
            </span>
            <span class="security-workbench__checked">检查于 {{ formatTime(model.checkedAtUtc) }}</span>
            <FsusUiButton
                native-type="button"
                class="security-workbench__refresh"
                :disabled="loading"
                @click="$emit('refresh')"
            >
                {{ loading ? '正在刷新' : '刷新状态' }}
            </FsusUiButton>
        </section>

        <p
            v-if="errorMessage"
            class="security-workbench__error"
            role="alert"
        >
            {{ errorMessage }}；仍保留最近一次成功检查结果。
        </p>

        <section
            class="security-workbench__tasks"
            aria-labelledby="security-tasks-title"
        >
            <header class="security-workbench__section-header">
                <h2 id="security-tasks-title">待处理</h2>
                <p>按严重度确认异常，并直接进入对应子系统完成下一步。</p>
            </header>

            <ul
                v-if="model.tasks.length > 0"
                class="security-task-list"
                role="list"
            >
                <li
                    v-for="item in model.tasks"
                    :key="item.key"
                    class="security-task-list__item"
                    :data-severity="item.severity"
                >
                    <span class="security-task-list__severity">{{ item.severityLabel }}</span>
                    <span class="security-task-list__copy">
                        <strong>{{ item.title }}</strong>
                        <span>{{ item.helper }}</span>
                    </span>
                    <time :datetime="item.occurredAt">{{ formatRelativeTime(item.occurredAt) }}</time>
                    <RouterLink
                        :to="item.to"
                        class="security-task-list__action"
                    >
                        {{ item.actionLabel }}
                    </RouterLink>
                </li>
            </ul>

            <div
                v-else
                class="security-workbench__healthy"
                role="status"
            >
                <strong>暂无待处理异常</strong>
                <span>最近一次检查未发现需要人工介入的风险主体、验证失败或自动化来源。</span>
            </div>
        </section>

        <section
            class="security-workbench__trends"
            aria-labelledby="security-trends-title"
        >
            <header class="security-workbench__section-header">
                <h2 id="security-trends-title">关键趋势</h2>
            </header>
            <dl
                class="security-trend-ledger"
                aria-label="安全关键趋势"
            >
                <div
                    v-for="trend in model.trends"
                    :key="trend.key"
                    class="security-trend-ledger__item"
                >
                    <dt>{{ trend.label }}</dt>
                    <dd>{{ trend.value }}</dd>
                </div>
            </dl>
        </section>

        <section
            class="security-workbench__changes"
            aria-labelledby="security-changes-title"
        >
            <header class="security-workbench__section-header">
                <h2 id="security-changes-title">最近策略变化</h2>
            </header>
            <ul
                v-if="model.changes.length > 0"
                class="security-change-list"
                role="list"
            >
                <li
                    v-for="change in model.changes"
                    :key="change.key"
                >
                    <span>
                        <strong>{{ change.label }}</strong>
                        <span>由 {{ change.actor }} 更新为 {{ formatMode(change.value) }}</span>
                    </span>
                    <time :datetime="change.occurredAt">{{ formatTime(change.occurredAt) }}</time>
                </li>
            </ul>
            <p
                v-else
                class="security-workbench__quiet-state"
            >近期没有记录到策略变化。</p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';

import { FsusUiButton } from '@/fsusui/button';
import type { SecurityDashboardModel } from '@/view-contracts/securityDashboard';

defineProps<{
    errorMessage: string;
    loading: boolean;
    model: SecurityDashboardModel;
}>();

defineEmits<(event: 'refresh') => void>();

const formatTime = (value: string): string =>
    value ? new Date(value).toLocaleString() : '未记录';

const formatRelativeTime = (value: string): string =>
{
    if (!value)
    {
        return '未记录';
    }
    const deltaMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
    if (deltaMinutes < 1)
    {
        return '刚刚';
    }
    if (deltaMinutes < 60)
    {
        return `${deltaMinutes} 分钟前`;
    }
    if (deltaMinutes < 1_440)
    {
        return `${Math.floor(deltaMinutes / 60)} 小时前`;
    }
    return formatTime(value);
};

const modeLabels: Record<string, string> = {
    disabled: '关闭',
    observe: '观察',
    enforce: '执行',
    strict: '严格',
    lockdown: '锁定'
};

const formatMode = (value: string): string => modeLabels[value] ?? value;
</script>

<style scoped>
.security-workbench
 {
    display: grid;
    gap: var(--fsus-space-7);
    min-width: 0;
}

.security-workbench__status
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--fsus-space-4);
    min-width: 0;
    padding: var(--fsus-space-4) var(--fsus-space-5);
    border-block: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg-soft);
}

.security-workbench__status[data-status="attention"]
 {
    border-inline-start: 3px solid var(--fsusblog-color-warning);
}

.security-workbench__status[data-status="healthy"]
 {
    border-inline-start: 3px solid var(--fsusblog-color-primary);
}

.security-workbench__status-copy
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.security-workbench__status-copy h2,
.security-workbench__section-header h2
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 18px;
    font-weight: 700;
    line-height: 1.3;
}

.security-workbench__status-copy p,
.security-workbench__section-header p
 {
    margin: 0;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.5;
}

.security-workbench__count
 {
    display: inline-flex;
    min-width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    padding-inline: var(--fsus-space-2);
    border: 1px solid var(--fsusblog-color-warning);
    color: var(--fsusblog-text-primary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
}

.security-workbench__checked
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
}

.security-task-list__action
 {
    display: inline-flex;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    padding-inline: var(--fsus-space-3);
    border: 1px solid var(--fsusblog-panel-border-strong);
    color: var(--fsusblog-text-primary);
    background: transparent;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.3;
    cursor: pointer;
}

.security-task-list__action:hover
 {
    border-color: var(--fsusblog-color-primary);
    color: var(--fsusblog-color-primary);
}

.security-task-list__action:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.security-workbench__error
 {
    margin: calc(var(--fsus-space-4) * -1) 0 0;
    padding: var(--fsus-space-3) var(--fsus-space-4);
    border-inline-start: 3px solid var(--fsusblog-color-error);
    color: var(--fsusblog-text-primary);
    background: var(--fsusblog-page-bg-soft);
    font-size: 14px;
    line-height: 1.5;
}

.security-workbench__tasks,
.security-workbench__trends,
.security-workbench__changes
 {
    display: grid;
    gap: var(--fsus-space-4);
    min-width: 0;
}

.security-workbench__section-header
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.security-task-list,
.security-change-list
 {
    display: grid;
    min-width: 0;
    margin: 0;
    padding: 0;
    border-block: 1px solid var(--fsusblog-panel-border);
    list-style: none;
}

.security-task-list__item
 {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr) 6rem auto;
    align-items: center;
    gap: var(--fsus-space-3);
    min-height: 52px;
    padding: var(--fsus-space-1) var(--fsus-space-4);
}

.security-task-list__item + .security-task-list__item,
.security-change-list li + li
 {
    border-top: 1px solid var(--fsusblog-panel-border);
}

.security-task-list__severity
 {
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
}

.security-task-list__item[data-severity="critical"] .security-task-list__severity::before,
.security-task-list__item[data-severity="warning"] .security-task-list__severity::before,
.security-task-list__item[data-severity="attention"] .security-task-list__severity::before,
.security-task-list__item[data-severity="unavailable"] .security-task-list__severity::before
 {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-inline-end: var(--fsus-space-2);
    border-radius: var(--fsus-radius-pill);
    background: currentcolor;
    vertical-align: middle;
}

.security-task-list__item[data-severity="critical"] .security-task-list__severity
 {
    color: var(--fsusblog-color-error);
}

.security-task-list__item[data-severity="warning"] .security-task-list__severity
 {
    color: var(--fsusblog-color-warning);
}

.security-task-list__item[data-severity="attention"] .security-task-list__severity
 {
    color: var(--fsusblog-color-primary);
}

.security-task-list__copy
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.security-task-list__copy strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

.security-task-list__copy span,
.security-change-list span span
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.4;
}

.security-task-list time,
.security-change-list time
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
}

.security-workbench__healthy,
.security-workbench__quiet-state
 {
    margin: 0;
    padding: var(--fsus-space-4) var(--fsus-space-5);
    border-block: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-secondary);
    background: var(--fsusblog-page-bg);
    font-size: 14px;
    line-height: 1.5;
}

.security-workbench__healthy
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.security-workbench__healthy strong
 {
    color: var(--fsusblog-text-primary);
}

.security-trend-ledger
 {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
    border-block: 1px solid var(--fsusblog-panel-border);
}

.security-trend-ledger__item
 {
    display: grid;
    gap: var(--fsus-space-1);
    min-width: 0;
    padding: var(--fsus-space-3) var(--fsus-space-4);
}

.security-trend-ledger__item + .security-trend-ledger__item
 {
    border-inline-start: 1px solid var(--fsusblog-panel-border);
}

.security-trend-ledger dt
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.4;
}

.security-trend-ledger dd
 {
    overflow: hidden;
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.security-change-list li
 {
    display: flex;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    padding: var(--fsus-space-2) var(--fsus-space-4);
}

.security-change-list li > span
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.security-change-list strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

@media (width <= 767px)
 {
    .security-workbench
 {
        gap: var(--fsus-space-6);
    }

    .security-workbench__status
 {
        grid-template-columns: minmax(0, 1fr) auto;
        padding-inline: var(--fsus-space-4);
    }

    .security-workbench__checked
 {
        grid-column: 1;
    }

    .security-workbench__refresh
 {
        grid-column: 2;
        grid-row: 2;
    }

    .security-task-list__item
 {
        grid-template-columns: minmax(0, 1fr) auto;
        padding-inline: var(--fsus-space-3);
    }

    .security-task-list__severity,
    .security-task-list time
 {
        grid-column: auto;
    }

    .security-task-list__copy
 {
        grid-column: 1 / -1;
        grid-row: 2;
    }

    .security-task-list__action
 {
        grid-column: 1 / -1;
        justify-self: stretch;
    }

    .security-trend-ledger
 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .security-trend-ledger__item:nth-child(odd)
 {
        border-inline-start: 0;
    }

    .security-trend-ledger__item:nth-child(n + 3)
 {
        border-top: 1px solid var(--fsusblog-panel-border);
    }

    .security-change-list li
 {
        align-items: start;
        flex-direction: column;
        gap: var(--fsus-space-2);
    }
}
</style>
