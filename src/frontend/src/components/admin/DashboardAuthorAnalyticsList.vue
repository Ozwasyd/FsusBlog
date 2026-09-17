<template>
    <section class="analytics-list">
        <h3 class="analytics-list__title">{{ title }}</h3>
        <p
            v-if="items.length === 0"
            class="analytics-list__empty"
        >
            {{ emptyText }}
        </p>
        <ol
            v-else
            class="analytics-list__items"
        >
            <li
                v-for="(item, index) in items"
                :key="item.label"
                class="analytics-list__item"
            >
                <span class="analytics-list__label">
                    {{ index + 1 }}. {{ item.label }}
                </span>
                <span class="analytics-list__value">
                    {{ item.count }}
                </span>
            </li>
        </ol>
    </section>
</template>

<script setup lang="ts">
import type { AuthorAnalyticsListItem } from '@/view-contracts/adminStats';

defineProps<{
    title: string;
    emptyText: string;
    items: readonly AuthorAnalyticsListItem[];
}>();
</script>

<style scoped>
.analytics-list
 {
    min-width: 0;
    padding: var(--fsus-space-4);
    background: var(--fsusblog-page-bg);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.analytics-list:last-child
 {
    border-bottom: 0;
}

.analytics-list__title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.35;
}

.analytics-list__empty
 {
    margin: var(--fsus-space-3) 0 0;
    padding-top: var(--fsus-space-3);
    border-top: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.5;
}

.analytics-list__items
 {
    display: grid;
    gap: 0;
    margin: var(--fsus-space-3) 0 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--fsusblog-panel-border);
}

.analytics-list__item
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--fsus-space-3);
    align-items: center;
    min-height: 40px;
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.analytics-list__item:last-child
 {
    border-bottom: 0;
}

.analytics-list__label
 {
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.analytics-list__value
 {
    flex: 0 0 auto;
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
}

@media (width >= 1024px)
 {
    .analytics-list
 {
        border-right: 1px solid var(--fsusblog-panel-border);
        border-bottom: 0;
    }

    .analytics-list:last-child
 {
        border-right: 0;
    }
}
</style>
