<template>
    <section
        ref="region"
        class="article-bulk-results"
        tabindex="-1"
        aria-label="文章操作结果"
    >
        <h3 aria-live="polite">{{ articleBulkResultLabel(result) }}</h3>
        <p>成功 {{ result.succeededCount }} · 失败 {{ result.failedCount }} · 被阻止 {{ result.blockedCount }} · 未执行 {{ result.notExecutedCount }} · 取消 {{ result.cancelledCount }}</p>
        <p v-if="result.commitOutcome === 'zero-written'">本次未写入任何文章。</p>
        <p
            v-if="result.state === 'recovery-required'"
            role="alert"
        >结果尚未核实。请完成恢复后再发起操作。</p>
        <div
            v-if="boundPage"
            class="article-bulk-results__filters"
        >
            <ElSelect
                v-model="status"
                aria-label="筛选本页结果状态"
                :disabled="busy"
            >
                <ElOption
                    value="all"
                    label="本页所有状态"
                />
                <ElOption
                    v-for="outcome in outcomes"
                    :key="outcome"
                    :value="outcome"
                    :label="articleBulkItemResultLabel(outcome)"
                />
            </ElSelect>
            <ElInput
                v-model="reason"
                aria-label="筛选本页结果原因"
                placeholder="本页原因包含"
                :disabled="busy"
                clearable
            />
        </div>
        <p
            v-if="boundPage"
            role="status"
        >本页显示 {{ rows.length }} / {{ boundPage.items.length }} 项，选择共 {{ result.selectedCount }} 篇；筛选只作用于本页。</p>
        <p v-if="boundPage && rows.length === 0">本页没有匹配项；其余页面尚未筛选。</p>
        <ElSelect
            v-if="result.strategy === 'per-item-isolated' && retryPolicies.length > 0 && result.state !== 'recovery-required'"
            v-model="retryPolicy"
            aria-label="重试版本确认策略"
            placeholder="选择重试版本确认策略"
            :disabled="busy"
        >
            <ElOption
                v-for="policy in retryPolicies"
                :key="policy.reference"
                :value="policy.reference"
                :label="policy.label"
            />
        </ElSelect>
        <ElTable
            v-if="boundPage"
            :data="rows"
            row-key="receiptReference"
            aria-label="本页文章逐项结果"
        >
            <ElTableColumn
                prop="articleIdentity"
                label="文章标识"
            />
            <ElTableColumn label="结果">
                <template #default="scope">
                    {{ articleBulkItemResultLabel(scope.row.outcome) }}
                </template>
            </ElTableColumn>
            <ElTableColumn
                prop="reason"
                label="原因"
            />
            <ElTableColumn label="重试">
                <template #default="scope">
                    <ElButton
                        v-if="scope.row.retryEligible && scope.row.outcome !== 'success' && scope.row.outcome !== 'infra-no-conclusion' && result.strategy === 'per-item-isolated'"
                        :disabled="!canRetry"
                        :aria-label="`重新预览 ${scope.row.articleIdentity}`"
                        @click="retry(scope.row.receiptReference)"
                    >重新预览此项</ElButton>
                </template>
            </ElTableColumn>
        </ElTable>
        <div class="article-bulk-results__actions">
            <ElButton
                v-if="!boundPage"
                :disabled="busy"
                @click="emit('page', result.itemPageReference)"
            >查看逐项结果</ElButton>
            <ElButton
                v-if="previousReference"
                :disabled="busy"
                @click="emit('page', previousReference)"
            >上一页结果</ElButton>
            <ElButton
                v-if="boundPage?.nextReference && boundPage.nextReference !== boundPage.reference"
                :disabled="busy"
                @click="emit('page', boundPage.nextReference)"
            >下一页结果</ElButton>
            <ElButton
                :disabled="busy"
                @click="emit('download')"
            >下载机器可读回执</ElButton>
            <ElButton
                v-if="result.state !== 'recovery-required'"
                :disabled="busy"
                @click="done"
            >返回文章列表</ElButton>
        </div>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElInput, ElOption, ElSelect, ElTable, ElTableColumn } from '@ozwasyd/element-plus';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { useArticleBulkPageNavigation } from '@/composables/useArticleBulkPageNavigation';
import {
    articleBulkResultLabel,
    articleBulkItemResultLabel,
    type ArticleBulkItemPage,
    type ArticleBulkResultSummary
} from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{
    result: ArticleBulkResultSummary;
    page: ArticleBulkItemPage | null;
    retryPolicies: readonly { reference: string; label: string; }[];
    busy: boolean;
    returnFocusTarget?: HTMLElement | null;
}>();
const emit = defineEmits<{
    page: [reference: string];
    retry: [itemReceiptReference: string, expectedRevisionPolicyReference: string];
    download: [];
    done: [];
}>();
const region = ref<HTMLElement | null>(null);
const retryPolicy = ref<string>();
const boundPage = computed(() => props.page?.planDigest === props.result.planDigest
    && props.page.receiptDigest === props.result.receiptDigest && props.page.items.length <= 50 ? props.page : null);
const status = ref('all');
const reason = ref('');
const outcomes = computed(() => [...new Set(boundPage.value?.items.map(item => item.outcome) ?? [])]);
const rows = computed(() => boundPage.value?.items.filter(item =>
    (status.value === 'all' || item.outcome === status.value) && item.reason.includes(reason.value.trim())) ?? []);
const { previousReference } = useArticleBulkPageNavigation(() => boundPage.value
    ? { scopeDigest: props.result.receiptDigest, reference: boundPage.value.reference } : null, region);
watch(() => props.result.receiptDigest, () =>
{
    status.value = 'all';
    reason.value = '';
    retryPolicy.value = undefined;
});
const canRetry = computed(() => !props.busy && props.result.strategy === 'per-item-isolated'
    && props.result.state !== 'recovery-required'
    && props.retryPolicies.some(policy => policy.reference === retryPolicy.value));
function retry(reference: string): void
{
    if (canRetry.value && retryPolicy.value && boundPage.value?.items.some(item => item.receiptReference === reference
        && item.retryEligible && item.outcome !== 'success' && item.outcome !== 'infra-no-conclusion'))
    {
        emit('retry', reference, retryPolicy.value);
    }
}
async function done(): Promise<void>
{
    const target = props.returnFocusTarget;
    emit('done');
    await nextTick();
    target?.focus();
}
onMounted(() => region.value?.focus());
</script>

<style scoped>
.article-bulk-results
 {
    display: grid;
    gap: var(--fsus-space-3);
    min-width: 0;
}

.article-bulk-results__filters,
.article-bulk-results__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
}
</style>
