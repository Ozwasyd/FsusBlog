<template>
    <div
        class="messages-empty-state"
        role="status"
        aria-live="polite"
    >
        <div class="messages-empty-state__title">{{ title }}</div>
        <p
            v-if="description"
            class="messages-empty-state__description"
        >{{ description }}</p>
        <div
            v-if="$slots.action"
            class="messages-empty-state__action"
        >
            <slot name="action" />
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    title: string;
    description?: string;
}>();
</script>

<style scoped>
@reference "@/assets/main.css";

.messages-empty-state
 {
    width: 100%;
    min-width: 0;
    border-left: 2px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg-soft);
    padding: 1.25rem 1.25rem 1.35rem;
}

.messages-empty-state__title
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.5;
}

.messages-empty-state__description
 {
    margin: 0.35rem 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.7;
}

.messages-empty-state__action
 {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 1rem;
}
</style>
