<template>
    <section
        class="article-bulk-progress"
        aria-label="文章操作进度"
        aria-busy="true"
    >
        <p role="status">{{ progress.state === 'cancelling' ? '正在停止接收新文章，请等待已开始的处理结束。' : '正在处理已确认的文章。' }}</p>
        <p>{{ progress.selectedCount }} 篇 · {{ articleBulkStrategyLabel(progress.strategy) }}</p>
        <p>成功 {{ progress.succeededCount }} · 失败 {{ progress.failedCount }} · 取消 {{ progress.cancelledCount }}</p>
        <p v-if="!progress.cancelAllowed">当前提交阶段需要等待核实结果。</p>
        <div class="article-bulk-progress__actions">
            <ElButton
                :disabled="busy"
                @click="emit('refresh')"
            >查看最新进度</ElButton>
            <ElButton
                :disabled="busy || !progress.cancelAllowed || progress.state === 'cancelling'"
                @click="emit('cancel')"
            >请求取消</ElButton>
        </div>
    </section>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';

import { articleBulkStrategyLabel, type ArticleBulkProgress } from '@/services/authoring/articleBulkPresentation';

defineProps<{ progress: ArticleBulkProgress; busy: boolean; }>();
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
