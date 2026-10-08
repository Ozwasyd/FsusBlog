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
            v-if="invalidation"
            role="alert"
        >{{ invalidation === 'permission-changed' ? '权限已变化' : invalidation === 'revision-changed' ? '文章版本已变化' : '操作参数已变化' }}，请重新预览并确认。</p>
        <p
            v-else-if="expired"
            role="alert"
        >计划已过期，请重新预览并确认。</p>
        <p
            v-else-if="!plan.executable"
            role="alert"
        >当前计划无法执行，请查看被阻止项并重新预览。</p>
        <div
            v-if="boundPage"
            class="article-bulk-impact__filters"
        >
            <ElSelect
                v-model="status"
                aria-label="筛选本页影响状态"
                :disabled="busy"
            >
                <ElOption
                    value="all"
                    label="本页所有状态"
                />
                <ElOption
                    value="eligible"
                    label="本页可执行项"
                />
                <ElOption
                    value="blocked"
                    label="本页被阻止项"
                />
            </ElSelect>
            <ElInput
                v-model="reason"
                aria-label="筛选本页影响原因"
                placeholder="本页原因包含"
                :disabled="busy"
                clearable
            />
        </div>
        <p
            v-if="boundPage"
            role="status"
        >本页显示 {{ rows.length }} / {{ boundPage.items.length }} 项，选择共 {{ plan.selectedCount }} 篇；筛选只作用于本页。</p>
        <p v-if="boundPage && rows.length === 0">本页没有匹配项；其余页面尚未筛选。</p>
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
                v-if="previousReference"
                :disabled="busy"
                @click="emit('page', previousReference)"
            >上一页影响</ElButton>
            <ElButton
                v-if="boundPage?.nextReference && boundPage.nextReference !== boundPage.reference"
                :disabled="busy"
                @click="emit('page', boundPage.nextReference)"
            >下一页影响</ElButton>
            <ElButton
                :disabled="busy"
                @click="adjust"
            >返回调整</ElButton>
            <ElButton
                type="primary"
                :disabled="expired || !!invalidation || !plan.executable || busy"
                @click="confirm"
            >
                确认执行此计划
            </ElButton>
        </div>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElInput, ElOption, ElSelect, ElTable, ElTableColumn } from '@ozwasyd/element-plus';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { useArticleBulkPageNavigation } from '@/composables/useArticleBulkPageNavigation';
import {
    articleBulkSelectionLabel,
    articleBulkStrategyLabel,
    type ArticleBulkImpactPage,
    type ArticleBulkPlanSummary,
    type ArticleBulkPlanConfirmation,
    type ArticleBulkPlanInvalidation
} from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{
    plan: ArticleBulkPlanSummary;
    page?: ArticleBulkImpactPage | null;
    expired: boolean;
    busy: boolean;
    invalidation?: ArticleBulkPlanInvalidation | null;
    returnFocusTarget?: HTMLElement | null;
}>();
const emit = defineEmits<{ confirm: [confirmation: ArticleBulkPlanConfirmation]; adjust: []; page: [reference: string]; }>();
const boundPage = computed(() => props.page?.planDigest === props.plan.digest
    && props.page.items.length <= 50 ? props.page : null);
const status = ref('all');
const reason = ref('');
const rows = computed(() => boundPage.value?.items.filter(item =>
    (status.value === 'all' || item.eligible === (status.value === 'eligible'))
    && item.reason.includes(reason.value.trim())) ?? []);
const region = ref<HTMLElement | null>(null);
const { previousReference } = useArticleBulkPageNavigation(() => boundPage.value
    ? { scopeDigest: props.plan.digest, reference: boundPage.value.reference } : null, region);
watch(() => props.plan.digest, () =>
{
    status.value = 'all';
    reason.value = '';
});
function confirm(): void
{
    if (!props.busy && !props.expired && !props.invalidation && props.plan.executable)
    {
        emit('confirm', { planReference: props.plan.reference, planDigest: props.plan.digest });
    }
}
async function adjust(): Promise<void>
{
    const target = props.returnFocusTarget;
    emit('adjust');
    await nextTick();
    target?.focus();
}
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

.article-bulk-impact__filters,
.article-bulk-impact__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
}
</style>
