<template>
    <section
        class="moderation-audit-index"
        aria-labelledby="moderation-audit-title"
    >
        <header class="moderation-audit-index__header">
            <div>
                <h2 id="moderation-audit-title">事件索引</h2>
            </div>
            <p>动作类型 / 审计入口</p>
        </header>

        <div
            class="moderation-audit-index__list"
            role="list"
        >
            <div
                class="moderation-audit-index__row moderation-audit-index__row--head"
                aria-hidden="true"
            >
                <span>域</span>
                <span>事件</span>
                <span>动作代码</span>
                <span>入口</span>
            </div>
            <RouterLink
                v-for="event in events"
                :key="event.action"
                :to="{ name: 'ManageAuditLog', query: { action: event.action } }"
                class="moderation-audit-index__row"
                role="listitem"
            >
                <span class="moderation-audit-index__kind">{{ event.kind }}</span>
                <span class="moderation-audit-index__main">
                    <strong>{{ readAuditActionText(event.action) }}</strong>
                    <small>{{ event.detail }}</small>
                </span>
                <code><AuditActionLabel :value="event.action" /></code>
                <span class="moderation-audit-index__action">查看</span>
            </RouterLink>
        </div>
    </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';

import AuditActionLabel from '@/components/admin/AuditActionLabel.vue';
import { formatAuditAction } from '@/view-contracts/auditActionLabels';

const events = [
    { kind: '词库', action: 'dictionary_loaded', detail: '词库快照加载成功。' },
    { kind: '词库', action: 'dictionary_reload_failed', detail: '保留旧快照。' },
    { kind: '词库', action: 'dictionary_checksum_changed', detail: '校验值发生变化。' },
    { kind: '地区', action: 'region_policy_loaded', detail: '地区策略加载成功。' },
    { kind: '地区', action: 'region_policy_reload_failed', detail: '地区策略重新载入失败。' },
    { kind: '地区', action: 'region_policy_replay_started', detail: '回放预览或执行开始。' },
    { kind: '地区', action: 'region_policy_replay_completed', detail: '回放预览或执行完成。' },
    { kind: '模型', action: 'model_moderation_scored', detail: '模型风险信号评分完成。' },
    { kind: '地区', action: 'region_moderation_rejected', detail: '地区策略拒绝发布。' },
    { kind: '地区', action: 'region_moderation_geo_blocked', detail: '产生访问地区拦截。' }
] as const;

const readAuditActionText = (value: string): string =>
{
    const display = formatAuditAction(value);
    return display.kind === 'label'
        ? display.text
        : display.namespace
            ? `${display.namespace} · ${display.name}`
            : display.name;
};
</script>

<style scoped>
.moderation-audit-index
 {
    display: grid;
    gap: var(--fsus-space-3);
    min-width: 0;
}

.moderation-audit-index__header
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-3);
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding-bottom: var(--fsus-space-3);
}

.moderation-audit-index__header div
 {
    min-width: 0;
}

.moderation-audit-index__header h2
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.35;
}

.moderation-audit-index__header p
 {
    margin: 0;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    text-align: right;
}

.moderation-audit-index__list
 {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-page-bg);
}

.moderation-audit-index__row
 {
    display: grid;
    grid-template-columns: 4.5rem minmax(12rem, 1fr) minmax(18rem, 1.1fr) 3rem;
    gap: var(--fsus-space-3);
    align-items: center;
    min-width: 0;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-2) var(--fsus-space-3);
    color: inherit;
    text-decoration: none;
    transition:
        background-color var(--fsus-motion-control, 220ms) var(--fsus-motion-standard, ease),
        color var(--fsus-motion-control, 220ms) var(--fsus-motion-standard, ease);
}

.moderation-audit-index__row:first-child
 {
    border-top: 0;
}

.moderation-audit-index__row--head
 {
    color: var(--fsusblog-text-muted);
    background: color-mix(in srgb, var(--fsusblog-panel-bg) 62%, transparent);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    letter-spacing: 0;
    text-transform: none;
}

.moderation-audit-index__row:hover,
.moderation-audit-index__row:focus-visible
 {
    background: var(--fsusblog-page-bg-soft);
}

.moderation-audit-index__row:focus-visible
 {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring, var(--link-hover, #2A599C));
}

.moderation-audit-index__kind
 {
    width: fit-content;
    border: 0;
    border-radius: 0;
    padding: 0;
    color: var(--fsusblog-text-secondary);
    background: transparent;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
}

.moderation-audit-index__main
 {
    display: flex;
    align-items: baseline;
    gap: var(--fsus-space-2);
    min-width: 0;
}

.moderation-audit-index__main strong
 {
    flex: 0 0 auto;
    overflow: hidden;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.moderation-audit-index__main small
 {
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.moderation-audit-index__row code
 {
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace));
    font-size: 12px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.moderation-audit-index__action
 {
    color: var(--fsusblog-color-primary, var(--link-hover, #2A599C));
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
}

@media (width <= 767px)
 {
    .moderation-audit-index__header
 {
        display: grid;
        align-items: start;
    }

    .moderation-audit-index__header p
 {
        max-width: none;
        text-align: left;
    }

    .moderation-audit-index__row
 {
        grid-template-columns: 3.5rem minmax(0, 1fr) 2.5rem;
        align-items: center;
        padding: var(--fsus-space-3);
    }

    .moderation-audit-index__row--head
 {
        display: none;
    }

    .moderation-audit-index__row code,
    .moderation-audit-index__action
 {
        grid-column: 2;
    }

    .moderation-audit-index__row code
 {
        grid-column: 2 / 4;
    }

    .moderation-audit-index__action
 {
        grid-column: 3;
        grid-row: 1;
        justify-self: end;
    }

    .moderation-audit-index__main strong,
    .moderation-audit-index__main small,
    .moderation-audit-index__row code
 {
        white-space: normal;
    }
}
</style>
