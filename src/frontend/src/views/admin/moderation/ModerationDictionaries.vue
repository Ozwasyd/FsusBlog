<template>
    <div class="space-y-8">
        <section
            class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
            :class="{
                'blog-motion-task-region--pending': reloading || rollingBack,
                'blog-motion-task-region--settled': isTaskHighlighted('moderation-dictionaries-runtime')
            }"
        >
            <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">运行时词库元数据</h2>
                    <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">敏感词库只展示元数据、校验值、词条数量和证据策略。</p>
                </div>
                <div class="moderation-dictionary-runtime-toolbar">
                    <div
                        class="moderation-dictionary-runtime-status"
                        :class="{ 'moderation-dictionary-runtime-status--danger': snapshot?.lastError }"
                        role="status"
                    >
                        <span
                            class="moderation-dictionary-runtime-status__dot"
                            aria-hidden="true"
                        />
                        <span>{{ snapshot?.lastError ? '载入异常' : '已载入' }}</span>
                    </div>
                    <div class="moderation-dictionary-runtime-actions">
                        <ElButton
                            :icon="Refresh"
                            :loading="loading"
                            @click="loadSnapshot"
                        >刷新</ElButton>
                        <ElButton
                            :icon="RefreshRight"
                            type="warning"
                            :loading="reloading"
                            @click="reloadSnapshot"
                        >重新载入</ElButton>
                        <ElButton
                            :icon="RefreshLeft"
                            type="warning"
                            :loading="rollingBack"
                            @click="rollbackSnapshot"
                        >回滚</ElButton>
                    </div>
                </div>
            </div>

            <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 md:grid-cols-6">
                <ElSelect
                    v-model="filters.scope"
                    clearable
                    placeholder="作用范围"
                    aria-label="作用范围"
                >
                    <ElOption
                        label="全局"
                        value="global"
                    />
                    <ElOption
                        label="地区"
                        value="regional"
                    />
                </ElSelect>
                <ElInput
                    v-model="filters.dictionaryId"
                    clearable
                    placeholder="词库 ID"
                    aria-label="词库 ID"
                />
                <ElSelect
                    v-model="filters.region"
                    clearable
                    placeholder="地区"
                    aria-label="地区"
                >
                    <ElOption
                        v-for="region in regionOptions"
                        :key="region"
                        :label="formatDictionaryRegion(region)"
                        :value="region"
                    />
                </ElSelect>
                <ElSelect
                    v-model="filters.category"
                    clearable
                    placeholder="分类"
                    aria-label="分类"
                >
                    <ElOption
                        v-for="category in categoryOptions"
                        :key="category"
                        :label="formatDictionaryCategory(category)"
                        :value="category"
                    />
                </ElSelect>
                <ElInput
                    v-model="filters.status"
                    clearable
                    placeholder="状态"
                    aria-label="状态"
                />
                <div class="flex items-center">
                    <ElCheckbox
                        v-model="filters.highRiskOnly"
                        aria-label="只看敏感词库"
                    >只看敏感词库</ElCheckbox>
                </div>
            </div>

            <div class="blog-scroll-x-safe moderation-dictionaries-table-scroll">
                <ElTable
                    class="moderation-dictionaries-table"
                    v-loading="loading"
                    :data="filteredDictionaries"
                    row-key="dictionaryId"
                    :row-class-name="rowClassName"
                >
                    <ElTableColumn
                        label="词库 ID"
                        min-width="230"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
                            <div class="font-medium text-[var(--fsusblog-text-primary)]">{{ row.dictionaryId }}</div>
                            <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">
                                {{ formatDictionarySource(row.source) }} / {{ formatDictionaryReviewer(row.reviewedBy) }}
                            </div>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="作用范围"
                        width="110"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatDictionaryScope(row.scope) }}</template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="地区"
                        width="130"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatDictionaryRegion(row.region) }}</template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="分类"
                        min-width="170"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatDictionaryCategory(row.category) }}</template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="版本"
                        width="140"
                        prop="version"
                    />
                    <ElTableColumn
                        label="证据策略"
                        width="150"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
                            <ElTag :type="evidenceType(row.evidencePolicy)">{{ formatEvidencePolicy(row.evidencePolicy) }}</ElTag>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="词条数"
                        width="90"
                        align="right"
                        prop="termCount"
                    />
                    <ElTableColumn
                        label="状态"
                        width="110"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
                            <ElTag :type="dictionaryStatusType(row)">{{ dictionaryStatus(row) }}</ElTag>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="校验值"
                        min-width="180"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
                            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="更新时间"
                        width="170"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatTime(row.updatedAtUtc) }}</template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="操作"
                        width="190"
                        align="right"
                        :fixed="isCompactDictionaryTable ? false : 'right'"
                    >
                        <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
                            <ElButton
                                link
                                type="primary"
                                :icon="View"
                                @click="openDetail(row)"
                            >详情</ElButton>
                            <ElButton
                                v-if="isDictionaryDisabled(row)"
                                link
                                type="success"
                                :icon="Check"
                                :loading="runtimeActionId === row.dictionaryId"
                                @click="setDictionaryEnabled(row, true)"
                            >
                                启用
                            </ElButton>
                            <ElButton
                                v-else
                                link
                                type="danger"
                                :icon="Close"
                                :loading="runtimeActionId === row.dictionaryId"
                                @click="setDictionaryEnabled(row, false)"
                            >
                                禁用
                            </ElButton>
                            <ElButton
                                link
                                :icon="CopyDocument"
                                @click="copyChecksum(row)"
                            >复制校验值</ElButton>
                        </template>
                    </ElTableColumn>
                    <template #empty>
                        <AdminInlineEmptyState
                            :title="dictionaryEmptyTitle"
                            :description="dictionaryEmptyDescription"
                        >
                            <template #actions>
                                <ElButton
                                    v-if="hasDictionaryFilters"
                                    link
                                    type="primary"
                                    @click="resetDictionaryFilters"
                                >清除筛选</ElButton>
                                <ElButton
                                    v-else
                                    link
                                    type="primary"
                                    :loading="loading"
                                    @click="loadSnapshot"
                                >刷新词库</ElButton>
                            </template>
                        </AdminInlineEmptyState>
                    </template>
                </ElTable>
            </div>
        </section>

        <ElDrawer
            v-model="detailVisible"
            title="词库元数据"
            size="min(92vw, 32rem)"
        >
            <div
                v-if="detail"
                class="space-y-5"
            >
                <div class="admin-muted-alert admin-muted-alert--warning px-4 py-3 text-[12px] leading-6">
                    原始词条默认不可见；证据策略为 redact 时不会在管理台、toast 或日志中展示敏感词明文。
                </div>
                <dl class="grid grid-cols-1 gap-3">
                    <div
                        v-for="item in detailRows"
                        :key="item.label"
                        class="bg-[var(--fsusblog-page-bg)] p-4"
                    >
                        <dt class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</dt>
                        <dd class="mt-2 break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</dd>
                    </div>
                </dl>
            </div>
        </ElDrawer>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue';

import {
    disableModerationDictionary,
    enableModerationDictionary,
    getModerationDictionarySnapshot,
    getModerationRuntimeStatus,
    reloadModerationDictionaries,
    rollbackModerationDictionaries,
    type ModerationDictionaryRuntimeItem,
    type ModerationDictionaryRuntimeSnapshot,
    type ModerationRuntimeStatusResponse
} from '@/api/authoring';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { promptText, toast } from '@/fsusui/feedback';
import { Check, Close, CopyDocument, Refresh, RefreshLeft, RefreshRight, View } from '@/fsusui/icons';
import { showErrorToast } from '@/utils/errorPresentation';
import { formatModerationRegionName, formatModerationRiskCategory } from '@/utils/moderationRegionDisplay';

const MainlandChangeConfirmPhrase = 'CONFIRM CN-MAINLAND MODERATION CHANGE';

const loading = shallowRef(false);
const reloading = shallowRef(false);
const rollingBack = shallowRef(false);
const runtimeActionId = shallowRef<string | null>(null);
const snapshot = shallowRef<ModerationDictionaryRuntimeSnapshot | null>(null);
const runtime = shallowRef<ModerationRuntimeStatusResponse | null>(null);
const detail = shallowRef<ModerationDictionaryRuntimeItem | null>(null);
const detailVisible = shallowRef(false);
const isCompactDictionaryTable = useMediaQuery('(max-width: 767px)');
const taskFeedback = useAdminTaskFeedback();
const {
    isHighlighted: isTaskHighlighted
} = taskFeedback;

const filters = reactive({
    scope: '',
    dictionaryId: '',
    region: '',
    category: '',
    status: '',
    highRiskOnly: false
});

const dictionaries = computed(() => snapshot.value?.dictionaries ?? []);
const disabledDictionaryIds = computed(() => new Set(runtime.value?.disabledDictionaryIds ?? []));
const regionOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.region ?? 'GLOBAL'))].sort());
const categoryOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.category))].sort());
const hasDictionaryFilters = computed(() =>
    filters.scope !== ''
    || filters.dictionaryId.trim() !== ''
    || filters.region !== ''
    || filters.category !== ''
    || filters.status.trim() !== ''
    || filters.highRiskOnly
);
const dictionaryEmptyTitle = computed(() => hasDictionaryFilters.value ? '没有匹配的词库' : '暂无运行时词库');
const dictionaryEmptyDescription = computed(() =>
    hasDictionaryFilters.value
        ? '调整作用范围、地区、分类、状态或敏感词库筛选后再查看。'
        : '运行时词库元数据载入后，会在这里显示校验值、词条数量和证据策略。'
);

const dictionaryScopeLabels: Record<string, string> = {
    global: '全局',
    regional: '地区'
};

const evidencePolicyLabels: Record<string, string> = {
    redact: '隐藏明文',
    show_category_only: '仅显示分类',
    show_full: '完整展示'
};

const dictionarySourceLabels: Record<string, string> = {
    internal_review: '内部审核'
};

const dictionaryReviewerLabels: Record<string, string> = {
    'engineering-preset': '工程预设'
};

const formatDictionaryScope = (scope?: string | null): string =>
    scope ? dictionaryScopeLabels[scope] ?? scope : '无';

const formatDictionaryRegion = (region?: string | null): string =>
    formatModerationRegionName(region ?? 'GLOBAL');

const formatDictionaryCategory = (category?: string | null): string =>
    formatModerationRiskCategory(category);

const formatEvidencePolicy = (policy?: string | null): string =>
    policy ? evidencePolicyLabels[policy] ?? policy : '无';

const formatDictionarySource = (source?: string | null): string =>
    source ? dictionarySourceLabels[source] ?? source : '无';

const formatDictionaryReviewer = (reviewer?: string | null): string =>
    reviewer ? dictionaryReviewerLabels[reviewer] ?? reviewer : '无';

const highRiskCategories = new Set([
    'political_sensitive',
    'pornographic',
    'sexual_explicit',
    'national_security_risk',
    'public_order_risk',
    'terrorism_extremism',
    'violence_extreme'
]);

const isHighRisk = (item: ModerationDictionaryRuntimeItem): boolean =>
    item.evidencePolicy === 'redact'
    || item.region === 'CN-MAINLAND'
    || highRiskCategories.has(item.category);

const isDictionaryDisabled = (item: ModerationDictionaryRuntimeItem): boolean =>
    disabledDictionaryIds.value.has(item.dictionaryId);

const dictionaryStatus = (item: ModerationDictionaryRuntimeItem): string =>
    isDictionaryDisabled(item)
        ? '已关闭'
        : item.termCount > 0 && item.checksum.length > 0 ? '已载入' : '异常';

const dictionaryStatusType = (item: ModerationDictionaryRuntimeItem): 'success' | 'danger' | 'info' =>
    isDictionaryDisabled(item)
        ? 'info'
        : item.termCount > 0 && item.checksum.length > 0
            ? 'success'
            : 'danger';

const evidenceType = (policy: string): 'success' | 'warning' | 'danger' | 'info' =>
{
    if (policy === 'redact')
    {
        return 'danger';
    }
    if (policy === 'show_category_only')
    {
        return 'warning';
    }
    if (policy === 'show_full')
    {
        return 'success';
    }
    return 'info';
};

const filteredDictionaries = computed(() => dictionaries.value.filter((item) =>
{
    if (filters.scope && item.scope !== filters.scope)
    {
        return false;
    }
    if (filters.dictionaryId && !item.dictionaryId.includes(filters.dictionaryId.trim()))
    {
        return false;
    }
    if (filters.region && (item.region ?? 'GLOBAL') !== filters.region)
    {
        return false;
    }
    if (filters.category && item.category !== filters.category)
    {
        return false;
    }
    if (filters.status && dictionaryStatus(item) !== filters.status.trim())
    {
        return false;
    }
    if (filters.highRiskOnly && !isHighRisk(item))
    {
        return false;
    }
    return true;
}));

const resetDictionaryFilters = (): void =>
{
    filters.scope = '';
    filters.dictionaryId = '';
    filters.region = '';
    filters.category = '';
    filters.status = '';
    filters.highRiskOnly = false;
};

const detailRows = computed(() =>
{
    if (!detail.value)
    {
        return [];
    }
    const item = detail.value;
    return [
        { label: '词库 ID', value: item.dictionaryId },
        { label: '作用范围', value: formatDictionaryScope(item.scope) },
        { label: '地区', value: formatDictionaryRegion(item.region) },
        { label: '分类', value: formatDictionaryCategory(item.category) },
        { label: '版本', value: item.version },
        { label: '校验值', value: item.checksum },
        { label: '词条数', value: String(item.termCount) },
        { label: '来源', value: formatDictionarySource(item.source) },
        { label: '复核人', value: formatDictionaryReviewer(item.reviewedBy) },
        { label: '更新时间', value: formatTime(item.updatedAtUtc) },
        { label: '证据策略', value: formatEvidencePolicy(item.evidencePolicy) },
        { label: '原始词条', value: '已隐藏' }
    ];
});

const loadSnapshot = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        const [dictionarySnapshot, runtimeStatus] = await Promise.all([
            getModerationDictionarySnapshot(),
            getModerationRuntimeStatus()
        ]);
        snapshot.value = dictionarySnapshot;
        runtime.value = runtimeStatus;
    }
    catch (error)
    {
        showErrorToast(error, '词库元数据加载失败');
    }
    finally
    {
        loading.value = false;
    }
};


const reloadSnapshot = async (): Promise<void> =>
{
    reloading.value = true;
    taskFeedback.begin('正在重新载入词库', '重新加载词库元数据与校验值', 'moderation-dictionaries-runtime');
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await reloadModerationDictionaries({ mfaProofToken });
        taskFeedback.succeed('词库已重新载入', result.snapshotId, 'moderation-dictionaries-runtime');
        toast.success(`词库已重载 ${result.snapshotId}`);
        await loadSnapshot();
    }
    catch (error)
    {
        taskFeedback.fail('词库重新载入失败', error, '词库重新载入失败', 'moderation-dictionaries-runtime');
        showErrorToast(error, '词库重新载入失败');
    }
    finally
    {
        reloading.value = false;
    }
};

const rollbackSnapshot = async (): Promise<void> =>
{
    rollingBack.value = true;
    taskFeedback.begin('正在回滚词库', '恢复上一份可用快照', 'moderation-dictionaries-runtime');
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await rollbackModerationDictionaries({ mfaProofToken });
        snapshot.value = result;
        runtime.value = await getModerationRuntimeStatus();
        taskFeedback.succeed('词库已回滚', result.snapshotId, 'moderation-dictionaries-runtime');
        toast.success(`词库已回滚 ${result.snapshotId}`);
    }
    catch (error)
    {
        taskFeedback.fail('词库回滚失败', error, '词库回滚失败', 'moderation-dictionaries-runtime');
        showErrorToast(error, '词库回滚失败');
    }
    finally
    {
        rollingBack.value = false;
    }
};

const resolveDictionaryConfirmPhrase = async (item: ModerationDictionaryRuntimeItem, enabled: boolean): Promise<string | null> =>
{
    if (enabled || !item.dictionaryId.startsWith('cn-mainland.'))
    {
        return null;
    }

    return await promptText(`输入 ${MainlandChangeConfirmPhrase}`, 'CN-MAINLAND 词库确认', {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        inputPlaceholder: MainlandChangeConfirmPhrase,
        inputValidator: (value: string) => value.trim() === MainlandChangeConfirmPhrase || '确认短语不匹配'
    });
};

const setDictionaryEnabled = async (item: ModerationDictionaryRuntimeItem, enabled: boolean): Promise<void> =>
{
    runtimeActionId.value = item.dictionaryId;
    taskFeedback.begin(enabled ? '正在启用词库' : '正在禁用词库', item.dictionaryId, item.dictionaryId);
    try
    {
        const confirmPhrase = await resolveDictionaryConfirmPhrase(item, enabled);
        if (!enabled && item.dictionaryId.startsWith('cn-mainland.') && confirmPhrase !== MainlandChangeConfirmPhrase)
        {
            taskFeedback.partial('词库变更已取消', '确认短语不匹配', item.dictionaryId);
            return;
        }

        const mfaProofToken = await ensureAdminSensitiveProof();
        runtime.value = enabled
            ? await enableModerationDictionary(item.dictionaryId, { reason: 'dictionary_runtime_enable' }, { mfaProofToken })
            : await disableModerationDictionary(item.dictionaryId, { reason: 'dictionary_runtime_disable', confirmPhrase }, { mfaProofToken });
        taskFeedback.succeed(enabled ? '词库已启用' : '词库已禁用', item.dictionaryId, item.dictionaryId);
        toast.success(`${item.dictionaryId} ${enabled ? '已启用' : '已禁用'}`);
    }
    catch (error)
    {
        taskFeedback.fail(enabled ? '词库启用失败' : '词库禁用失败', error, enabled ? '词库启用失败' : '词库禁用失败', item.dictionaryId);
        showErrorToast(error, enabled ? '词库启用失败' : '词库禁用失败');
    }
    finally
    {
        runtimeActionId.value = null;
    }
};

const openDetail = (item: ModerationDictionaryRuntimeItem): void =>
{
    detail.value = item;
    detailVisible.value = true;
};

const copyChecksum = async (item: ModerationDictionaryRuntimeItem): Promise<void> =>
{
    await navigator.clipboard?.writeText(item.checksum);
    toast.success('校验值已复制');
};

const rowClassName = ({ row }: { row: ModerationDictionaryRuntimeItem; }): string =>
    isTaskHighlighted(row.dictionaryId) ? 'blog-motion-task-region blog-motion-task-region--settled' : 'blog-motion-task-region';

function formatTime(value: string): string
{
    return value ? new Date(value).toLocaleString() : '-';
}

onMounted(() =>
{
    void loadSnapshot();
});
</script>

<style scoped>
.moderation-dictionaries-table-scroll
 {
    max-width: 100%;
    overflow-x: auto;
}

.moderation-dictionary-runtime-toolbar
 {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--fsus-space-3);
}

.moderation-dictionary-runtime-status
 {
    display: inline-flex;
    align-items: center;
    gap: var(--fsus-space-2);
    min-height: 24px;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
}

.moderation-dictionary-runtime-status__dot
 {
    width: 6px;
    height: 6px;
    border-radius: var(--fsus-radius-pill);
    background: var(--fsusblog-color-success);
}

.moderation-dictionary-runtime-status--danger .moderation-dictionary-runtime-status__dot
 {
    background: var(--fsusblog-color-danger);
}

.moderation-dictionary-runtime-actions
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-2);
}

@media (width >= 1024px)
 {
    .moderation-dictionary-runtime-toolbar
 {
        align-items: flex-end;
    }

    .moderation-dictionary-runtime-actions
 {
        justify-content: flex-end;
    }
}


</style>
