<template>
    <section
        class="collection-workbench"
        :class="`collection-workbench--${density}`"
        :aria-labelledby="titleId"
        :aria-busy="busy ? 'true' : undefined"
    >
        <header
            class="collection-workbench__summary"
            data-workbench-region="summary"
        >
            <div class="min-w-0">
                <h2
                    :id="titleId"
                    class="collection-workbench__title"
                >{{ title }}</h2>
                <p
                    v-if="meta"
                    class="collection-workbench__meta"
                >{{ meta }}</p>
            </div>
        </header>

        <div
            class="collection-workbench__toolbar"
            data-workbench-region="primary-filter"
        >
            <slot name="primary-filter" />
            <div
                v-if="$slots['advanced-filter-trigger']"
                class="collection-workbench__advanced-trigger"
            >
                <slot name="advanced-filter-trigger" />
            </div>
        </div>

        <div
            v-if="selectedCount > 0"
            class="collection-workbench__selection"
            data-workbench-region="selection-actions"
            aria-live="polite"
        >
            <slot name="selection-actions" />
        </div>

        <div
            class="collection-workbench__results"
            data-workbench-region="results"
        >
            <slot :name="state === 'ready' ? 'results' : state" />
        </div>

        <footer
            v-if="$slots.pagination && state === 'ready'"
            class="collection-workbench__pagination"
            data-workbench-region="pagination"
        >
            <slot name="pagination" />
        </footer>
    </section>
</template>

<script setup lang="ts">
defineOptions({ name: 'CollectionWorkbench' });

withDefaults(defineProps<{
    title: string;
    titleId: string;
    meta?: string;
    state?: 'ready' | 'loading' | 'empty' | 'error';
    density?: 'compact' | 'comfortable';
    selectedCount?: number;
    busy?: boolean;
}>(), {
    meta: '',
    state: 'ready',
    density: 'comfortable',
    selectedCount: 0,
    busy: false
});
</script>
