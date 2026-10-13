<template>
    <div class="account-page audit-log-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="审计日志"
            class="account-task-page-header"
            density="compact"
        />

        <FsusUiSettingsSection
            class="mb-8"
            title="写入状态"
            description="队列、失败与降级写入指标来自服务端审计状态快照。"
            id="audit-runtime-title"
        >
            <template #title>
                写入状态
                <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ summary?.total ?? total }}</span>
            </template>
            <template #actions>
                <div class="flex flex-wrap items-center justify-end gap-2">
                    <ElTag type="info">队列 {{ runtime.queuedCount }}</ElTag>
                    <ElTag :type="runtime.droppedCount > 0 ? 'danger' : 'success'">丢弃 {{ runtime.droppedCount }}</ElTag>
                    <ElTag :type="runtime.writeFailureCount > 0 ? 'warning' : 'success'">失败 {{ runtime.writeFailureCount }}</ElTag>
                    <ElTag :type="runtime.fallbackWriteCount > 0 ? 'warning' : 'info'">降级写入 {{ runtime.fallbackWriteCount }}</ElTag>
                    <ElButton
                        :icon="Refresh"
                        :loading="loading"
                        @click="loadAudit()"
                    >刷新</ElButton>
                </div>
            </template>
        </FsusUiSettingsSection>

        <section class="border-t border-[var(--fsusblog-panel-border)]">
            <div class="audit-filter-grid grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-4 lg:grid-cols-6">
                <ElInput
                    v-model="filters.actor"
                    clearable
                    placeholder="操作者"
                    aria-label="操作者"
                    :prefix-icon="User"
                />
                <ElInput
                    v-model="filters.action"
                    clearable
                    placeholder="动作代码"
                    aria-label="动作代码"
                    :prefix-icon="Operation"
                />
                <ElInput
                    v-model="filters.targetType"
                    clearable
                    placeholder="目标类型"
                    aria-label="目标类型"
                    :prefix-icon="Aim"
                />
                <ElInput
                    v-model="filters.targetId"
                    clearable
                    placeholder="目标 ID"
                    aria-label="目标 ID"
                />
                <ElSelect
                    v-model="filters.outcome"
                    clearable
                    placeholder="结果"
                    aria-label="结果"
                >
                    <ElOption
                        :label="adminStatusLabel.success"
                        value="success"
                    />
                    <ElOption
                        :label="adminStatusLabel.failure"
                        value="failure"
                    />
                    <ElOption
                        :label="adminStatusLabel.denied"
                        value="denied"
                    />
                    <ElOption
                        :label="adminStatusLabel.unknown"
                        value="unknown"
                    />
                </ElSelect>
                <ElSelect
                    v-model="filters.severity"
                    clearable
                    placeholder="严重度"
                    aria-label="严重度"
                >
                    <ElOption
                        :label="adminStatusLabel.info"
                        value="info"
                    />
                    <ElOption
                        :label="adminStatusLabel.warning"
                        value="warning"
                    />
                    <ElOption
                        :label="adminStatusLabel.error"
                        value="error"
                    />
                    <ElOption
                        :label="adminStatusLabel.critical"
                        value="critical"
                    />
                </ElSelect>
                <ElInput
                    v-model="filters.source"
                    clearable
                    placeholder="来源"
                    aria-label="来源"
                />
                <ElInput
                    v-model="filters.type"
                    clearable
                    placeholder="类型"
                    aria-label="类型"
                />
                <div class="audit-filter-date-cell lg:col-span-2">
                    <ElDatePicker
                        :model-value="dateRange ?? undefined"
                        @update:model-value="updateAuditDateRange"
                        type="datetimerange"
                        start-placeholder="起始时间"
                        end-placeholder="结束时间"
                        aria-label="时间范围"
                    />
                </div>
                <div class="flex items-center gap-2 lg:col-span-2">
                    <ElButton
                        type="primary"
                        :icon="Search"
                        :loading="loading"
                        @click="applyFilters"
                    >查询</ElButton>
                    <ElButton
                        :icon="RefreshLeft"
                        @click="resetFilters"
                    >重置</ElButton>
                </div>
            </div>

            <section class="audit-facet-grid border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)]">
                <div class="audit-facet-grid__col audit-facet-grid__col--actions">
                    <header class="audit-facet-grid__header">动作 ({{ actionFacets.length }})</header>
                    <AdminStatusMatrix
                        :items="actionFacets"
                        clickable
                        :active-value="filters.action"
                        aria-label="动作 facet 过滤"
                        @item-click="(item) => selectFacet('action', String(item.value))"
                    />
                </div>

                <div class="audit-facet-grid__col audit-facet-grid__col--results">
                    <div class="audit-facet-grid__group">
                        <header class="audit-facet-grid__header">结果 ({{ outcomeFacets.length }})</header>
                        <AdminStatusMatrix
                            :items="outcomeFacets"
                            clickable
                            :active-value="filters.outcome"
                            aria-label="结果 facet 过滤"
                            @item-click="(item) => selectFacet('outcome', String(item.value))"
                        />
                    </div>

                    <div class="audit-facet-grid__group">
                        <header class="audit-facet-grid__header">严重度 ({{ severityFacets.length }})</header>
                        <AdminStatusMatrix
                            :items="severityFacets"
                            clickable
                            :active-value="filters.severity"
                            aria-label="严重度 facet 过滤"
                            @item-click="(item) => selectFacet('severity', String(item.value))"
                        />
                    </div>
                </div>
            </section>

            <p
                v-if="auditRowMotion.summary.value"
                class="blog-motion-summary-enter border-b border-[var(--fsusblog-panel-border)] px-4 py-2 text-[11px] font-bold text-[var(--fsusblog-text-muted)]"
                role="status"
                aria-live="polite"
            >
                {{ auditRowMotion.summary.value }}
            </p>

            <div
                v-if="isAuditInitialLoading"
                class="px-4 py-6"
                aria-busy="true"
            >
                <ElSkeleton
                    :rows="6"
                    animated
                />
            </div>

            <ElResponsiveCollection
                v-else
                v-loading="loading"
                :items="items"
                row-key="id"
                compact-query="(max-width: 767px)"
                aria-label="审计日志列表"
            >
                <template #card="{ item }">
                    <article
                        class="audit-compact-row"
                        :class="auditRowClassName({ rowData: item as AuditLogItemResponse })"
                        role="listitem"
                    >
                        <div class="audit-compact-row__main">
                            <div class="audit-compact-row__header">
                                <time
                                    class="audit-compact-row__time"
                                    :datetime="(item as AuditLogItemResponse).occurredAtUtc"
                                >
                                    {{ formatTime((item as AuditLogItemResponse).occurredAtUtc) }}
                                </time>
                                <span class="audit-compact-row__status">
                                    <ElTag
                                        size="small"
                                        :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus((item as AuditLogItemResponse).outcome)])"
                                    >
                                        {{ adminStatusLabel[toAdminSystemStatus((item as AuditLogItemResponse).outcome)] }}
                                    </ElTag>
                                    <ElTag
                                        size="small"
                                        :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus((item as AuditLogItemResponse).severity)])"
                                    >
                                        {{ adminStatusLabel[toAdminSystemStatus((item as AuditLogItemResponse).severity)] }}
                                    </ElTag>
                                </span>
                            </div>

                            <h2 class="audit-compact-row__title">
                                <AuditActionLabel :value="(item as AuditLogItemResponse).action" />
                            </h2>

                            <p class="audit-compact-row__message">
                                {{ (item as AuditLogItemResponse).eventInfo }}
                            </p>

                            <div class="audit-compact-row__meta">
                                <span>操作者 {{ formatAuditActor(item as AuditLogItemResponse) }}</span>
                                <span>目标 {{ formatAuditTarget(item as AuditLogItemResponse) }}</span>
                            </div>
                        </div>

                        <div class="audit-compact-row__actions">
                            <ElTooltip content="校验防篡改证据">
                                <ElButton
                                    class="audit-compact-row__action"
                                    :icon="Lock"
                                    link
                                    :loading="verifyingId === (item as AuditLogItemResponse).id"
                                    aria-label="校验证据"
                                    @click="verifyRow(item as AuditLogItemResponse)"
                                />
                            </ElTooltip>
                            <ElButton
                                class="audit-compact-row__action"
                                link
                                type="primary"
                                :icon="View"
                                aria-label="查看详情"
                                @click="openDetail(item as AuditLogItemResponse)"
                            >查看</ElButton>
                        </div>
                    </article>
                </template>

                <template #empty>
                    <AdminInlineEmptyState
                        :title="auditEmptyTitle"
                        :content="auditEmptyDescription"
                    >
                        <template #actions>
                            <ElButton
                                v-if="hasAuditFilters"
                                link
                                type="primary"
                                @click="resetFilters"
                            >清除筛选</ElButton>
                            <ElButton
                                v-else
                                link
                                type="primary"
                                :loading="loading"
                                @click="loadAudit()"
                            >刷新审计日志</ElButton>
                        </template>
                    </AdminInlineEmptyState>
                </template>

                <template #table>
                    <div class="audit-table-v2-frame">
                        <ElAutoResizer>
                            <template #default="{ height, width }">
                                <ElTableV2
                                    :columns="auditTableColumns"
                                    :data="items"
                                    :width="width"
                                    :height="height"
                                    :row-height="72"
                                    row-key="id"
                                    :row-class="auditRowClassName"
                                    :row-class-name="auditRowClassName"
                                >
                                    <template #cell="{ rowData, column }">
                                        <template v-if="column.key === 'occurredAt'">
                                            <time :datetime="(rowData as AuditLogItemResponse).occurredAtUtc">
                                                {{ formatTime((rowData as AuditLogItemResponse).occurredAtUtc) }}
                                            </time>
                                        </template>

                                        <div
                                            v-else-if="column.key === 'action'"
                                            class="min-w-0"
                                        >
                                            <div class="font-medium text-[var(--fsusblog-text-primary)]">
                                                <AuditActionLabel :value="(rowData as AuditLogItemResponse).action" />
                                            </div>
                                            <p class="mt-1 truncate text-[11px] text-[var(--fsusblog-text-muted)]">
                                                {{ (rowData as AuditLogItemResponse).eventInfo }}
                                            </p>
                                        </div>

                                        <div
                                            v-else-if="column.key === 'actor'"
                                            class="text-xs"
                                        >
                                            <div>{{ (rowData as AuditLogItemResponse).actorType ?? '-' }}</div>
                                            <div class="break-all text-[var(--fsusblog-text-muted)]">
                                                {{ (rowData as AuditLogItemResponse).actorId ?? (rowData as AuditLogItemResponse).actorRole ?? '-' }}
                                            </div>
                                        </div>

                                        <div
                                            v-else-if="column.key === 'target'"
                                            class="text-xs"
                                        >
                                            <div>{{ (rowData as AuditLogItemResponse).targetType ?? '-' }}</div>
                                            <div class="break-all text-[var(--fsusblog-text-muted)]">
                                                {{ (rowData as AuditLogItemResponse).targetId ?? '-' }}
                                            </div>
                                        </div>

                                        <div
                                            v-else-if="column.key === 'outcome'"
                                            class="flex flex-col items-center gap-1"
                                        >
                                            <ElTag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus((rowData as AuditLogItemResponse).outcome)])">
                                                {{ adminStatusLabel[toAdminSystemStatus((rowData as AuditLogItemResponse).outcome)] }}
                                            </ElTag>
                                            <ElTag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus((rowData as AuditLogItemResponse).severity)])">
                                                {{ adminStatusLabel[toAdminSystemStatus((rowData as AuditLogItemResponse).severity)] }}
                                            </ElTag>
                                        </div>

                                        <ElTooltip
                                            v-else-if="column.key === 'evidence'"
                                            content="校验防篡改证据"
                                        >
                                            <ElButton
                                                :icon="Lock"
                                                circle
                                                :loading="verifyingId === (rowData as AuditLogItemResponse).id"
                                                @click="verifyRow(rowData as AuditLogItemResponse)"
                                            />
                                        </ElTooltip>

                                        <ElButton
                                            v-else-if="column.key === 'detail'"
                                            link
                                            type="primary"
                                            :icon="View"
                                            class="audit-table-action"
                                            @click="openDetail(rowData as AuditLogItemResponse)"
                                        >
                                            查看
                                        </ElButton>
                                    </template>

                                    <template #empty>
                                        <AdminInlineEmptyState
                                            :title="auditEmptyTitle"
                                            :content="auditEmptyDescription"
                                        >
                                            <template #actions>
                                                <ElButton
                                                    v-if="hasAuditFilters"
                                                    link
                                                    type="primary"
                                                    @click="resetFilters"
                                                >清除筛选</ElButton>
                                                <ElButton
                                                    v-else
                                                    link
                                                    type="primary"
                                                    :loading="loading"
                                                    @click="loadAudit()"
                                                >刷新审计日志</ElButton>
                                            </template>
                                        </AdminInlineEmptyState>
                                    </template>
                                </ElTableV2>
                            </template>
                        </ElAutoResizer>
                    </div>
                </template>
            </ElResponsiveCollection>

            <div class="admin-audit-pagination-scroll flex justify-end border-t border-[var(--fsusblog-panel-border)] px-4 py-4">
                <ElPagination
                    v-model:current-page="page"
                    v-model:page-size="pageSize"
                    :total="total"
                    :page-sizes="[25, 50]"
                    :pager-count="isCompactPagination ? 5 : 7"
                    :small="isCompactPagination"
                    :layout="isCompactPagination ? 'prev, pager, next' : 'total, sizes, prev, pager, next'"
                    class="admin-audit-pagination"
                    @current-change="loadAudit"
                    @size-change="handleSizeChange"
                />
            </div>
        </section>

        <ElDrawer
            v-model="detailVisible"
            size="min(720px, 100vw)"
            title="审计详情"
        >
            <div
                v-if="detail"
                class="space-y-5"
            >
                <ElDescriptions
                    :column="1"
                    border
                >
                    <ElDescriptionsItem label="ID"><div class="break-all">{{ detail.item.id }}</div></ElDescriptionsItem>
                    <ElDescriptionsItem label="动作代码"><div class="break-all">{{ detail.item.action }}</div></ElDescriptionsItem>
                    <ElDescriptionsItem label="操作者"><div class="break-all">{{ detail.item.actorType ?? '-' }} / {{ detail.item.actorId ?? '-' }}</div></ElDescriptionsItem>
                    <ElDescriptionsItem label="目标"><div class="break-all">{{ detail.item.targetType ?? '-' }} / {{ detail.item.targetId ?? '-' }}</div></ElDescriptionsItem>
                    <ElDescriptionsItem label="Trace ID"><div class="break-all">{{ detail.item.traceId ?? '-' }}</div></ElDescriptionsItem>
                    <ElDescriptionsItem label="隐私哈希">
                        <div class="break-all text-xs leading-6">
                            ip={{ detail.item.ipHash ?? '-' }}<br>
                            ua={{ detail.item.userAgentHash ?? '-' }}<br>
                            session={{ detail.item.sessionIdHash ?? '-' }}<br>
                            fp={{ detail.item.deviceFingerprintHash ?? '-' }}
                        </div>
                    </ElDescriptionsItem>
                    <ElDescriptionsItem label="防篡改">
                        <ElTag :type="detail.tamperEvidenceValid ? 'success' : 'danger'">
                            {{ detail.tamperEvidenceValid ? '有效' : '无效' }}
                        </ElTag>
                        <div class="mt-2 break-all text-xs text-[var(--fsusblog-text-muted)]">
                            hash={{ detail.item.recordHash ?? '-' }}<br>
                            mac={{ detail.item.recordMac ?? '-' }}
                        </div>
                    </ElDescriptionsItem>
                </ElDescriptions>
                <pre class="max-h-[360px] overflow-auto border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-3 text-xs leading-6">{{ formattedContext }}</pre>
            </div>
        </ElDrawer>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
    getAuditLogDetail,
    getAuditLogSummary,
    listAuditLogs,
    verifyAuditLog,
    type AuditLogDetailResponse,
    type AuditLogItemResponse,
    type AuditLogQueryParams,
    type AuditLogRuntimeResponse,
    type AuditLogSummaryResponse
} from '@/api/authoring';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import AuditActionLabel from '@/components/admin/AuditActionLabel.vue';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { useRowStateMotion } from '@/composables/useRowStateMotion';
import { FsusUiTaskPageHeader, FsusUiSettingsSection } from "@/fsusui";
import { toast } from '@/fsusui/feedback';
import { Aim, Lock, Operation, Refresh, RefreshLeft, Search, User, View } from '@/fsusui/icons';
import { toFsusUiTagType } from '@/fsusui/primitiveAdapters';
import { FsusUiTableV2FixedDir, type FsusUiTableV2Column } from '@/fsusui/tableV2';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';
import {
    adminStatusLabel,
    adminStatusTone,
    type AdminSystemStatus
} from '@/view-contracts/adminStatus';
import { formatAuditAction } from '@/view-contracts/auditActionLabels';

type AuditDateRange = [Date, Date] | null;

const route = useRoute();
const router = useRouter();

const emptyRuntime: AuditLogRuntimeResponse = {
    queuedCount: 0,
    droppedCount: 0,
    writeSuccessCount: 0,
    writeFailureCount: 0,
    fallbackWriteCount: 0,
    lastWriteSuccessUtc: null,
    lastWriteFailureUtc: null,
    lastFallbackWriteUtc: null
};

const filters = reactive({
    source: '',
    type: '',
    actor: '',
    action: '',
    targetType: '',
    targetId: '',
    outcome: '',
    severity: ''
});
const dateRange = ref<AuditDateRange>(null);
// This picker has no value-format: keep its genuine Date pair and explicit clear boundary.
const updateAuditDateRange = (value: unknown): void =>
{
    if (value === null || value === undefined || value === '')
    {
        dateRange.value = null;
        return;
    }
    if (Array.isArray(value) && value.length === 2)
    {
        const from: unknown = value[0];
        const to: unknown = value[1];
        if (from instanceof Date && to instanceof Date && Number.isFinite(from.getTime()) && Number.isFinite(to.getTime()))
        {
            dateRange.value = [from, to];
            return;
        }
    }
    throw new Error('audit-date-range-update-invalid');
};
const items = shallowRef<AuditLogItemResponse[]>([]);
const summary = shallowRef<AuditLogSummaryResponse | null>(null);
const detail = shallowRef<AuditLogDetailResponse | null>(null);
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);
const isCompactPagination = useMediaQuery('(max-width: 767px)');
const cursorByPage = reactive<Record<number, string | null>>({ 1: null });
const loading = ref(false);
const hasLoadedAudit = ref(false);
const verifyingId = ref<AuditLogItemResponse['id'] | null>(null);
const detailVisible = ref(false);
const auditRowMotion = useRowStateMotion({ visibleLimit: 20 });

const auditTableColumns: FsusUiTableV2Column<AuditLogItemResponse>[] = [
    { key: 'occurredAt', dataKey: 'occurredAtUtc', title: '时间', width: 190 },
    { key: 'action', dataKey: 'action', title: '动作', width: 300 },
    { key: 'actor', dataKey: 'actorId', title: '操作者', width: 170 },
    { key: 'target', dataKey: 'targetId', title: '目标', width: 190 },
    { key: 'outcome', dataKey: 'outcome', title: '结果', width: 150, align: 'center' },
    { key: 'evidence', title: '证据', width: 110, align: 'center' },
    { key: 'detail', title: '详情', width: 110, align: 'right', fixed: FsusUiTableV2FixedDir.RIGHT }
];

const runtime = computed(() => summary.value?.runtime ?? emptyRuntime);
const actionFacets = computed<AdminStatusMatrixItem[]>(() =>
{
    const totalCount = Math.max(1, summary.value?.total ?? 0);
    return (summary.value?.actions ?? []).map((facet) =>
    {
        const display = formatAuditAction(facet.value);
        const label = display.kind === 'label'
            ? '动作'
            : display.namespace || '动作';
        const displayValue = display.kind === 'label' ? display.text : display.name;

        return {
            label,
            value: facet.value,
            displayValue,
            tone: 'neutral' as const,
            meta: String(facet.count),
            bar: { percent: Math.round((facet.count / totalCount) * 100) }
        };
    });
});
const outcomeFacets = computed<AdminStatusMatrixItem[]>(() =>
    (summary.value?.outcomes ?? []).map((facet) =>
    {
        const status = toAdminSystemStatus(facet.value);
        return {
            label: adminStatusLabel[status],
            value: facet.value,
            displayValue: facet.count,
            tone: adminStatusTone[status]
        };
    })
);
const severityFacets = computed<AdminStatusMatrixItem[]>(() =>
    (summary.value?.severities ?? []).map((facet) =>
    {
        const status = toAdminSystemStatus(facet.value);
        return {
            label: adminStatusLabel[status],
            value: facet.value,
            displayValue: facet.count,
            tone: adminStatusTone[status]
        };
    })
);
const isAuditInitialLoading = computed(() => loading.value && !hasLoadedAudit.value);
const hasAuditFilters = computed(() =>
    filters.source.trim() !== ''
    || filters.type.trim() !== ''
    || filters.actor.trim() !== ''
    || filters.action.trim() !== ''
    || filters.targetType.trim() !== ''
    || filters.targetId.trim() !== ''
    || Boolean(filters.outcome)
    || Boolean(filters.severity)
    || Boolean(dateRange.value)
);
const auditEmptyTitle = computed(() => hasAuditFilters.value ? '没有匹配的审计事件' : '暂无审计日志');
const auditEmptyDescription = computed(() =>
    hasAuditFilters.value
        ? '调整操作者、动作、目标、结果或时间范围后再查询。'
        : '后台操作、安全事件和防篡改证据写入后会显示在这里。'
);
const formattedContext = computed(() =>
{
    if (!detail.value?.contextJson)
    {
        return '{}';
    }

    try
    {
        return JSON.stringify(JSON.parse(detail.value.contextJson), null, 2);
    }
    catch
    {
        return detail.value.contextJson;
    }
});

const toAdminSystemStatus = (status: string | null | undefined): AdminSystemStatus =>
    status && status in adminStatusTone ? status as AdminSystemStatus : 'unknown';

const resetAuditCursor = (): void =>
{
    for (const key of Object.keys(cursorByPage))
    {
        delete cursorByPage[Number(key)];
    }
    cursorByPage[1] = null;
};

const buildQuery = (cursor: string | null): AuditLogQueryParams => ({
    page: page.value,
    pageSize: pageSize.value,
    cursor,
    source: filters.source.trim() || null,
    type: filters.type.trim() || null,
    actor: filters.actor.trim() || null,
    action: filters.action.trim() || null,
    targetType: filters.targetType.trim() || null,
    targetId: filters.targetId.trim() || null,
    outcome: filters.outcome || null,
    severity: filters.severity || null,
    fromUtc: dateRange.value?.[0]?.toISOString() ?? null,
    toUtc: dateRange.value?.[1]?.toISOString() ?? null
});

const loadAudit = async (targetPage = page.value): Promise<void> =>
{
    loading.value = true;
    try
    {
        let requestedPage = Number.isFinite(Number(targetPage)) ? Math.max(1, Math.trunc(Number(targetPage))) : page.value;
        if (requestedPage > 1 && !(requestedPage in cursorByPage))
        {
            requestedPage = 1;
            page.value = 1;
            resetAuditCursor();
        }

        page.value = requestedPage;
        const query = buildQuery(cursorByPage[requestedPage] ?? null);
        const [list, facets] = await Promise.all([
            listAuditLogs(query),
            getAuditLogSummary(query)
        ]);
        items.value = list.items;
        cursorByPage[requestedPage + 1] = list.nextCursor ?? null;
        total.value = list.nextCursor
            ? Math.max(list.total, requestedPage * pageSize.value + 1)
            : Math.max(list.total, (requestedPage - 1) * pageSize.value + list.items.length);
        summary.value = facets;
        auditRowMotion.markUpdated(list.items.slice(0, 20).map((item) => item.id), `审计日志已刷新：${list.items.length} 条可见记录`);
    }
    catch (error)
    {
        showErrorToast(error, '审计日志加载失败');
    }
    finally
    {
        loading.value = false;
        hasLoadedAudit.value = true;
    }
};

const applyFilters = async (): Promise<void> =>
{
    page.value = 1;
    resetAuditCursor();
    await loadAudit();
};

const resetFilters = async (): Promise<void> =>
{
    filters.source = '';
    filters.type = '';
    filters.actor = '';
    filters.action = '';
    filters.targetType = '';
    filters.targetId = '';
    filters.outcome = '';
    filters.severity = '';
    dateRange.value = null;
    await applyFilters();
};

const selectFacet = (dimension: 'action' | 'outcome' | 'severity', value: string): void =>
{
    filters[dimension] = filters[dimension] === value ? '' : value;
    void router.replace({
        query: {
            ...route.query,
            [dimension]: filters[dimension] || undefined
        }
    });
    void applyFilters();
};

const handleSizeChange = async (): Promise<void> =>
{
    page.value = 1;
    resetAuditCursor();
    await loadAudit();
};

const openDetail = async (row: AuditLogItemResponse): Promise<void> =>
{
    try
    {
        detail.value = await getAuditLogDetail(row.id);
        detailVisible.value = true;
    }
    catch (error)
    {
        showErrorToast(error, '审计详情加载失败');
    }
};

const verifyRow = async (row: AuditLogItemResponse): Promise<void> =>
{
    verifyingId.value = row.id;
    auditRowMotion.markPending(row.id, '正在校验证据');
    try
    {
        const result = await verifyAuditLog(row.id);
        if (result.valid)
        {
            auditRowMotion.markUpdated(row.id, '防篡改证据有效');
            toast.success('防篡改证据有效');
        }
        else
        {
            auditRowMotion.markError(row.id, '防篡改证据无效');
            showWarningToast('防篡改证据无效', '防篡改证据无效');
        }
    }
    catch (error)
    {
        auditRowMotion.markError(row.id, '防篡改校验失败');
        showErrorToast(error, '防篡改校验失败');
    }
    finally
    {
        verifyingId.value = null;
    }
};

const formatTime = (value: string): string => new Date(value).toLocaleString();
const auditRowClassName = ({ rowData }: { rowData: AuditLogItemResponse; }): string => auditRowMotion.classFor(rowData.id);

const formatAuditActor = (item: AuditLogItemResponse): string =>
    `${item.actorType ?? '-'} / ${item.actorId ?? item.actorRole ?? '-'}`;

const formatAuditTarget = (item: AuditLogItemResponse): string =>
    `${item.targetType ?? '-'} / ${item.targetId ?? '-'}`;

const applyRouteQueryFilters = (): void =>
{
    filters.action = typeof route.query.action === 'string' ? route.query.action : '';
    filters.outcome = typeof route.query.outcome === 'string' ? route.query.outcome : '';
    filters.severity = typeof route.query.severity === 'string' ? route.query.severity : '';
    filters.source = typeof route.query.source === 'string' ? route.query.source : filters.source;
    filters.type = typeof route.query.type === 'string' ? route.query.type : filters.type;
    filters.targetType = typeof route.query.targetType === 'string' ? route.query.targetType : filters.targetType;
};

onMounted(() =>
{
    applyRouteQueryFilters();
    resetAuditCursor();
    void loadAudit();
});
</script>

<style scoped>
.audit-filter-grid
 {
    grid-template-columns: minmax(0, 1fr);
}

.audit-filter-grid > *
 {
    min-width: 0;
}

.audit-facet-grid
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    padding: var(--fsus-space-4);
    gap: var(--fsus-space-4);
}

.audit-facet-grid__col,
.audit-facet-grid__group
 {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.audit-facet-grid__col--results
 {
    gap: var(--fsus-space-4);
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-top: var(--fsus-space-4);
}

.audit-facet-grid__header
 {
    padding-bottom: var(--fsus-space-2);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
    letter-spacing: 0;
}

.audit-compact-row
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--fsus-space-3);
    min-width: 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
    padding: var(--fsus-space-2) var(--fsus-space-4) var(--fsus-space-3);
}

.audit-compact-row__main
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.audit-compact-row__header
 {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-2);
}

.audit-compact-row__time
 {
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

.audit-compact-row__status
 {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--fsus-space-1);
}

.audit-compact-row__title
 {
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.audit-compact-row__message,
.audit-compact-row__meta
 {
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.audit-compact-row__meta > span
 {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
}

.audit-compact-row__meta
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-1) var(--fsus-space-3);
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
}

.audit-compact-row__actions
 {
    display: inline-flex;
    align-items: center;
    align-self: center;
    gap: var(--fsus-space-1);
}

.audit-compact-row__action
 {
    min-width: 40px;
    min-height: 40px;
    padding-inline: var(--fsus-space-1);
}

.audit-table-v2-frame
 {
    height: clamp(360px, 58vh, 640px);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.audit-table-action
 {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
}

.audit-filter-grid > *
 {
    width: 100%;
    max-width: 100%;
}

@media (width <= 639px)
 {
    .audit-filter-grid input
 {
        min-width: 32px;
    }
}

.audit-filter-date-cell
 {
    min-width: 0;
    overflow-x: auto;
}

.audit-filter-date-cell :deep(.el-range-input)
 {
    min-width: 2.5rem;
}

@media (width >= 1024px)
 {
    .audit-filter-grid
 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
    }

    .audit-facet-grid
 {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    }

    .audit-facet-grid__col--results
 {
        border-top: 0;
        border-left: 1px solid var(--fsusblog-panel-border);
        padding-top: 0;
        padding-left: var(--fsus-space-4);
    }
}

@media (width <= 1023px)
 {
    .audit-facet-grid .admin-status-matrix__bar
 {
        display: none;
    }
}

.admin-audit-pagination-scroll
 {
    overflow-x: auto;
}

@media (width <= 767px)
 {
    .admin-audit-pagination-scroll
 {
        justify-content: flex-start;
    }
}

.admin-audit-pagination
 {
    flex-wrap: wrap;
    justify-content: flex-end;
    row-gap: var(--fsus-space-2);
}
</style>
