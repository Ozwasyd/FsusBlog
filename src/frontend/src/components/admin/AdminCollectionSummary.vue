<template>
    <header class="admin-collection-summary flex flex-col gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
            <h2
                :id="id"
                class="m-0 text-[14px] font-bold leading-snug text-[var(--fsusblog-text-primary)]"
            >
                <slot name="title">{{ title }}</slot>
            </h2>
            <p
                v-if="$slots.meta || meta || description"
                class="mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]"
            >
                <slot name="meta">{{ meta || description }}</slot>
            </p>
            <p
                v-if="meta && description"
                class="mt-1 text-[12px] leading-relaxed text-[var(--fsusblog-text-tertiary)]"
            >
                {{ description }}
            </p>
        </div>
        <div
            v-if="$slots.actions"
            class="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto"
        >
            <slot name="actions" />
        </div>
    </header>
</template>

<script setup lang="ts">
defineOptions({ name: 'AdminCollectionSummary' });

withDefaults(defineProps<{
    title: string;
    description?: string;
    id?: string;
    meta?: string;
}>(), {
    description: '',
    id: undefined,
    meta: ''
});
</script>
