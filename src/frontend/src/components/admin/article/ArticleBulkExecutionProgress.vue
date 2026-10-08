<template>
    <section
        ref="region"
        tabindex="-1"
        class="article-bulk-progress"
        aria-label="文章操作进度"
        aria-busy="true"
    >
        <p role="status">{{ progress.state === 'cancelling' ? progress.strategy === 'all-or-nothing' ? '正在核实准备阶段的取消结果。' : '正在停止接收新文章，请等待已开始的处理结束。' : '正在处理已确认的文章。' }}</p>
        <p>{{ progress.selectedCount }} 篇 · {{ articleBulkStrategyLabel(progress.strategy) }}</p>
        <p v-if="progress.strategy === 'per-item-isolated'">成功 {{ progress.succeededCount }} · 失败 {{ progress.failedCount }} · 取消 {{ progress.cancelledCount }}</p>
        <p v-else>准备中，尚无已确认提交结果。</p>
        <p>{{ progress.strategy === 'per-item-isolated' ? '取消仅停止尚未开始项，已开始项等待回执。' : '仅准备阶段可请求安全取消；提交开始后需等待权威结论。' }}</p>
        <p v-if="!progress.cancelAllowed">当前提交阶段需要等待核实结果。</p>
        <div class="article-bulk-progress__actions">
            <ElButton
                :disabled="busy"
                @click="emit('refresh')"
            >查看最新进度</ElButton>
            <ElButton
                data-bulk-cancel
                :disabled="busy || !progress.cancelAllowed || progress.state === 'cancelling'"
                @click="emit('cancel')"
            >请求取消</ElButton>
        </div>
    </section>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';
import { nextTick, onMounted, ref, watch } from 'vue';

import { articleBulkStrategyLabel, type ArticleBulkProgress } from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{ progress: ArticleBulkProgress; busy: boolean; }>();
const region = ref<HTMLElement | null>(null);
watch(() => [props.busy, props.progress.cancelAllowed, props.progress.state], async () =>
{
    const focusedCancel = region.value?.querySelector('[data-bulk-cancel]') === document.activeElement;
    if (focusedCancel && (props.busy || !props.progress.cancelAllowed || props.progress.state === 'cancelling'))
    {
        await nextTick();
        region.value?.focus();
    }
});
onMounted(() => region.value?.focus());
const emit = defineEmits<{ cancel: []; refresh: []; }>();
</script>

<style scoped>
.article-bulk-progress
 {
    display: grid;
    gap: var(--fsus-space-3);
    min-width: 0;
}

.article-bulk-progress__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
}
</style>
