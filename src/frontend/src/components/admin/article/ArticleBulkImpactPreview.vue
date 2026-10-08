<template>
    <section
        ref="region"
        class="article-bulk-impact"
        tabindex="-1"
        aria-label="确认文章操作影响"
    >
        <h3>{{ plan.operationLabel }}</h3>
        <p>{{ plan.selectedCount }} 篇 · {{ articleBulkSelectionLabel(plan.selection.kind) }}</p>
        <p>{{ plan.proposedChange }}</p>
        <p>可执行 {{ plan.eligibleCount }} · 被阻止 {{ plan.blockedCount }} · 冲突 {{ plan.conflictCount }}</p>
        <p data-strategy>{{ articleBulkStrategyLabel(plan.strategy) }}</p>
        <p>计划有效至 <time :datetime="plan.expiresAtUtc">{{ plan.expiresAtUtc }}</time></p>
        <p class="article-bulk-impact__digest">计划摘要：{{ plan.digest.slice(0, 23) }}…</p>
        <p
            v-if="expired"
            role="alert"
        >计划已过期，请重新预览并确认。</p>
        <p
            v-else-if="!plan.executable"
            role="alert"
        >当前计划无法执行，请查看被阻止项并重新预览。</p>
        <ElTable
            v-if="boundPage"
            :data="rows"
            row-key="articleIdentity"
            aria-label="本页文章影响"
        >
            <ElTableColumn
                prop="articleIdentity"
                label="文章标识"
            />
            <ElTableColumn
                prop="currentState"
                label="当前状态"
            />
            <ElTableColumn
                prop="proposedChange"
                label="拟执行变更"
            />
            <ElTableColumn
                prop="reason"
                label="原因"
            />
        </ElTable>
        <div class="article-bulk-impact__actions">
            <ElButton
                v-if="!boundPage"
                :disabled="busy"
                @click="emit('page', plan.impactPageReference)"
            >查看逐项影响</ElButton>
            <ElButton
                v-if="boundPage?.nextReference"
                :disabled="busy"
                @click="emit('page', boundPage.nextReference)"
            >下一页影响</ElButton>
            <ElButton
                :disabled="busy"
                @click="emit('adjust')"
            >返回调整</ElButton>
            <ElButton
                type="primary"
                :disabled="expired || !plan.executable || busy"
                @click="emit('confirm')"
            >
                确认执行此计划
            </ElButton>
        </div>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElTable, ElTableColumn } from '@ozwasyd/element-plus';
import { computed, onMounted, ref } from 'vue';


import {
    articleBulkSelectionLabel,
    articleBulkStrategyLabel,
    type ArticleBulkImpactPage,
    type ArticleBulkPlanSummary
} from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{ plan: ArticleBulkPlanSummary; page?: ArticleBulkImpactPage | null; expired: boolean; busy: boolean; }>();
const emit = defineEmits<{ confirm: []; adjust: []; page: [reference: string]; }>();
const boundPage = computed(() => props.page?.planDigest === props.plan.digest
    && props.page.items.length <= 50 ? props.page : null);
const rows = computed(() => boundPage.value ? [...boundPage.value.items] : []);
const region = ref<HTMLElement | null>(null);
onMounted(() => region.value?.focus());
</script>

<style scoped>
.article-bulk-impact
 {
    display: grid;
    gap: var(--fsus-space-2);
    min-width: 0;
}

.article-bulk-impact__digest
 {
    overflow-wrap: anywhere;
}

.article-bulk-impact__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
}
</style>
