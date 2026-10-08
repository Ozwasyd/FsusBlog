<template>
    <section
        v-if="visible && selection"
        class="article-bulk-selection"
        aria-label="文章批量选择"
    >
        <p aria-live="polite">已选择 {{ selection.count }} 篇 · {{ articleBulkSelectionLabel(selection.kind) }}</p>
        <ElSelect
            :model-value="operationId ?? undefined"
            aria-label="选择一个文章操作"
            placeholder="选择一个操作"
            :disabled="busy"
            @update:model-value="emit('operation', String($event))"
        >
            <ElOption
                v-for="operation in available"
                :key="operation.id"
                :value="operation.id"
                :label="operation.label"
            />
        </ElSelect>
        <ElButton
            :disabled="busy"
            @click="emit('clear')"
        >清空选择</ElButton>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElOption, ElSelect } from '@ozwasyd/element-plus';
import { computed } from 'vue';


import {
    articleBulkSelectionLabel,
    type ArticleBulkOperationOption,
    type ArticleBulkSelectionSummary
} from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{
    selection: ArticleBulkSelectionSummary | null;
    operations: readonly ArticleBulkOperationOption[];
    operationId: string | null;
    busy: boolean;
}>();
const emit = defineEmits<{
    operation: [id: string];
    clear: [];
}>();
const visible = computed(() => props.selection && Number.isSafeInteger(props.selection.count)
    && props.selection.count > 0 && props.selection.count <= 10_000);
const available = computed(() => props.operations.filter(operation => operation.available));
</script>

<style scoped>
.article-bulk-selection
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-3);
    min-width: 0;
}
</style>
