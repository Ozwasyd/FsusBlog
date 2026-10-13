<template>
    <div class="space-y-8">
        <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
            <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">
                        地区生效规则
                    </h2>
                    <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                        选择地区后查看继承链、校验值和最终提交/展示动作。
                    </p>
                </div>
                <ElButton
                    :icon="Refresh"
                    :loading="loading"
                    @click="loadRegions"
                >刷新</ElButton>
            </div>

            <FsusUiDataList
                class="moderation-regions-mobile-list"
                :rows="regionMobileRows"
                :columns="regionMobileColumns"
                row-key="regionCode"
                :active-key="selectedRegionCode"
                :loading-key="previewLoadingRegion"
                :href="regionPreviewHrefForRow"
                density="compact"
                variant="navigation"
                :show-header="false"
                aria-label="地区定义列表"
                @row-click="handleMobileRegionClick"
            >
                <template #cell="{ row, column, active }">
                    <span
                        v-if="column.key === 'region'"
                        class="moderation-regions-mobile-summary"
                        :class="{
                            'moderation-regions-mobile-summary--child': isChildRegion(
                                requireRegionDefinition(row),
                            ),
                        }"
                    >
                        <span
                            class="moderation-regions-mobile-cell moderation-regions-mobile-title"
                            :class="{
                                'is-active': active,
                            }"
                            :title="getRegionCode(row)"
                        >
                            {{ formatRegionName(getRegionCode(row)) }}
                        </span>
                        <span
                            class="moderation-regions-mobile-cell moderation-regions-mobile-meta"
                            :title="formatRegionListMeta(requireRegionDefinition(row))"
                        >
                            {{ formatRegionListMeta(requireRegionDefinition(row)) }}
                        </span>
                    </span>
                    <span
                        v-else-if="column.key === 'indicator'"
                        class="moderation-regions-mobile-cell moderation-regions-mobile-cell--indicator"
                        :class="{ 'is-active': active }"
                        aria-hidden="true"
                    >
                        <component :is="ArrowRight" />
                    </span>
                </template>
                <template #empty>
                    <AdminInlineEmptyState
                        v-if="!loading"
                        title="暂无地区定义"
                        description="内置或自定义地区载入后，会在这里显示生效策略入口。"
                    />
                </template>
            </FsusUiDataList>

            <div class="blog-scroll-x-safe moderation-regions-table-scroll">
                <ElTable
                    ref="regionsTableRef"
                    v-loading="loading"
                    :data="displayRegions"
                    row-key="regionCode"
                    highlight-current-row
                    @current-change="selectRegion"
                    @row-click="selectRegion"
                >
                    <ElTableColumn
                        label="地区"
                        min-width="150"
                        class-name="moderation-region-table-cell"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <span
                                class="moderation-region-name"
                                :class="{
                                    'moderation-region-name--child': isChildRegion(row),
                                }"
                                :title="row.regionCode"
                            >{{ formatRegionName(row.regionCode) }}</span>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="范围"
                        min-width="120"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <span
                                class="moderation-region-name moderation-region-name--muted"
                                :title="row.displayName"
                            >{{ formatRegionScope(row) }}</span>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="上级地区"
                        width="130"
                        class-name="moderation-region-table__secondary"
                        label-class-name="moderation-region-table__secondary"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <span
                                class="moderation-region-name moderation-region-name--muted"
                                :title="row.parentRegion ?? undefined"
                            >
                                {{
                                    row.parentRegion ? formatRegionName(row.parentRegion) : "无"
                                }}
                            </span>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="所属大区"
                        width="160"
                        class-name="moderation-region-table__secondary"
                        label-class-name="moderation-region-table__secondary"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <span
                                class="moderation-region-name moderation-region-name--muted"
                                :title="row.primaryGroup ?? undefined"
                            >
                                {{
                                    row.primaryGroup ? formatRegionName(row.primaryGroup) : "无"
                                }}
                            </span>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="策略模板"
                        min-width="210"
                        class-name="moderation-region-table__secondary"
                        label-class-name="moderation-region-table__secondary"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <span
                                class="moderation-region-name moderation-region-name--muted"
                                :title="row.policyTemplate ?? undefined"
                            >
                                {{
                                    row.policyTemplate
                                        ? formatPolicyTemplate(row.policyTemplate)
                                        : "无"
                                }}
                            </span>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="状态"
                        width="120"
                        class-name="moderation-region-table__secondary"
                        label-class-name="moderation-region-table__secondary"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <ElTag :type="row.enabled ? 'success' : 'info'">{{
                                row.enabled ? "已启用" : "已关闭"
                            }}</ElTag>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="来源类型"
                        width="110"
                        class-name="moderation-region-table__secondary"
                        label-class-name="moderation-region-table__secondary"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <ElTag :type="row.builtin ? 'info' : 'warning'">{{
                                row.builtin ? "内置" : "自定义"
                            }}</ElTag>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn
                        label="操作"
                        width="96"
                        align="right"
                    >
                        <template #default="{ row }: { row: ModerationRegionDefinition }">
                            <a
                                class="moderation-region-preview-link"
                                :class="{
                                    'is-active': selectedRegionCode === row.regionCode,
                                    'is-loading': previewLoadingRegion === row.regionCode,
                                }"
                                :href="regionPreviewHref(row.regionCode)"
                                :data-region-code="row.regionCode"
                                @click.prevent.stop="previewRegion(row.regionCode)"
                            >
                                {{ selectedRegionCode === row.regionCode ? "查看中" : "查看" }}
                            </a>
                        </template>
                    </ElTableColumn>
                    <template #empty>
                        <AdminInlineEmptyState
                            title="暂无地区定义"
                            description="内置或自定义地区载入后，会在这里显示生效策略入口。"
                        />
                    </template>
                </ElTable>
            </div>
        </section>

        <section
            ref="previewSectionRef"
            class="grid gap-8 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1fr)]"
        >
            <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
                        继承链
                    </div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="step in preview?.inheritance ?? []"
                        :key="`${step.step}:${step.sourceId}`"
                        class="p-5"
                    >
                        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">
                            {{ formatInheritanceStep(step) }}
                        </div>
                        <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">
                            来源：{{ formatSourceType(step.sourceType) }}；{{
                                formatSourceId(step.sourceId)
                            }}；规则：{{ step.rules.length }} 条
                        </div>
                    </div>
                    <div
                        v-if="!preview"
                        class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]"
                    >
                        选择地区查看生效策略。
                    </div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div>
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
                            生效规则
                        </div>
                        <div class="moderation-regions-preview-meta">
                            <span>地区：{{ formatRegionName(preview?.region) }}</span>
                            <span
                                class="moderation-regions-preview-meta__checksum"
                                :title="preview?.checksum ?? undefined"
                            >
                                校验值：{{ formatChecksum(preview?.checksum) }}
                            </span>
                        </div>
                    </div>
                    <ElTag
                        v-for="warning in preview?.warnings ?? []"
                        :key="warning"
                        type="warning"
                    >{{ warning }}</ElTag>
                </div>
                <FsusUiDataList
                    class="moderation-regions-rules-list"
                    :rows="effectiveRuleRows"
                    :columns="effectiveRuleColumns"
                    row-key="category"
                    density="compact"
                    variant="summary"
                    :show-header="false"
                    :interactive="false"
                    aria-label="生效规则"
                >
                    <template #cell="{ row }">
                        <div class="moderation-regions-rule-row">
                            <div class="moderation-regions-rule-summary">
                                <span
                                    class="moderation-regions-rule-category"
                                    :title="readRuleField(row, 'category')"
                                >
                                    {{ formatRuleCategory(row) }}
                                </span>
                                <span
                                    class="moderation-regions-rule-source"
                                    :title="formatRuleSource(row)"
                                >
                                    {{ formatRuleSource(row) }}
                                </span>
                            </div>
                            <dl class="moderation-regions-rule-actions">
                                <div class="moderation-regions-rule-action">
                                    <dt>提交</dt>
                                    <dd :title="readRuleField(row, 'submitAction')">
                                        {{ formatRuleSubmitAction(row) }}
                                    </dd>
                                </div>
                                <div class="moderation-regions-rule-action">
                                    <dt>展示</dt>
                                    <dd :title="readRuleField(row, 'displayAction')">
                                        {{ formatRuleDisplayAction(row) }}
                                    </dd>
                                </div>
                            </dl>
                        </div>
                    </template>
                    <template #empty>
                        <AdminInlineEmptyState
                            :title="preview ? '暂无生效规则' : '选择地区查看生效规则'"
                            :description="
                                preview
                                    ? '当前地区没有返回可展示的提交或展示动作规则。'
                                    : '选择左侧地区后显示继承链计算出的生效规则。'
                            "
                        />
                    </template>
                </FsusUiDataList>
            </section>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
    getModerationEffectivePolicy,
    listModerationRegions,
    type ModerationEffectivePolicyPreview,
    type ModerationEffectivePolicyStep,
    type ModerationRegionDefinition
} from "@/api/authoring";
import AdminInlineEmptyState from "@/components/admin/AdminInlineEmptyState.vue";
import {
    FsusUiDataList,
    type FsusUiDataListColumn,
    type FsusUiDataListRow,
    type FsusUiDataListRowKey
} from "@/fsusui";
import { ArrowRight, Refresh } from "@/fsusui/icons";
import { showErrorToast } from "@/utils/errorPresentation";
import {
    formatModerationRegionName,
    formatModerationRegionVersion,
    formatModerationAction,
    formatModerationRiskCategory,
    formatModerationSourceType
} from "@/utils/moderationRegionDisplay";

const loading = shallowRef(false);
const route = useRoute();
const router = useRouter();
const regions = shallowRef<ModerationRegionDefinition[]>([]);
const preview = shallowRef<ModerationEffectivePolicyPreview | null>(null);
const previewLoadingRegion = shallowRef<string | null>(null);
const selectedRegionCode = shallowRef<string | null>(null);
const previewSectionRef = shallowRef<HTMLElement | null>(null);
interface RegionsTableInstance {
    setCurrentRow: (row?: ModerationRegionDefinition) => void;
}
const regionsTableRef = shallowRef<RegionsTableInstance | null>(null);
const regionMobileColumns: FsusUiDataListColumn[] = [
    { key: "region", label: "地区", grid: "minmax(0, 1fr)" },
    { key: "indicator", label: "进入", grid: "40px", align: "end" }
];
const effectiveRuleColumns: FsusUiDataListColumn[] = [
    { key: "rule", label: "规则", grid: "minmax(0, 1fr)" }
];
const effectiveRuleRows = computed<FsusUiDataListRow[]>(() =>
    (preview.value?.rules ?? []).map((rule) => ({ ...rule }))
);

const regionDisplayOrder: Record<string, number> = {
    GLOBAL: 0,
    "CN-MAINLAND": 10,
    "CN-HK": 11,
    "CN-MO": 12,
    "CN-TW": 13,
    EU: 20,
    "EU-DE": 21,
    "EU-FR": 22,
    "EU-NL": 23,
    UK: 30,
    US: 40,
    "US-CA": 41,
    "US-TX": 42,
    CA: 50,
    AU: 60,
    NZ: 61,
    SG: 70,
    JP: 80,
    KR: 81,
    UNKNOWN: 900
};

const formatRegionName = (region?: string | null): string =>
    formatModerationRegionName(region);
const formatSourceType = (sourceType?: string | null): string =>
    formatModerationSourceType(sourceType);
const formatPolicyTemplate = (template: string): string =>
    formatModerationRegionVersion(template);
const formatRiskCategory = (category: string): string =>
    formatModerationRiskCategory(category);
const formatPolicyAction = (action: string): string =>
    formatModerationAction(action);
const formatChecksum = (checksum?: string | null): string =>
{
    if (!checksum)
    {
        return "无";
    }
    return checksum.length > 12
        ? `${checksum.slice(0, 8)}...${checksum.slice(-4)}`
        : checksum;
};

const getRegionParentCode = (
    region: ModerationRegionDefinition
): string | null =>
{
    const parent = region.parentRegion?.trim();
    if (!parent)
    {
        return null;
    }
    return parent;
};

const isChildRegion = (region: ModerationRegionDefinition): boolean =>
    getRegionParentCode(region) !== null;

const getRegionDisplayOrder = (regionCode: string): number =>
    regionDisplayOrder[regionCode] ?? 500;

const compareRegionForDisplay = (
    left: ModerationRegionDefinition,
    right: ModerationRegionDefinition
): number =>
    getRegionDisplayOrder(left.regionCode) -
    getRegionDisplayOrder(right.regionCode) ||
    formatRegionName(left.regionCode).localeCompare(
        formatRegionName(right.regionCode),
        "zh-Hans-CN"
    ) ||
    left.regionCode.localeCompare(right.regionCode);

const displayRegions = computed(() =>
{
    const regionCodes = new Set(regions.value.map((region) => region.regionCode));
    const rootRegions: ModerationRegionDefinition[] = [];
    const childrenByParent = new Map<string, ModerationRegionDefinition[]>();

    for (const region of regions.value)
    {
        const parentCode = getRegionParentCode(region);
        if (parentCode && regionCodes.has(parentCode))
        {
            const children = childrenByParent.get(parentCode) ?? [];
            children.push(region);
            childrenByParent.set(parentCode, children);
            continue;
        }

        rootRegions.push(region);
    }

    return rootRegions.sort(compareRegionForDisplay).flatMap((region) => [
        region,
        ...(childrenByParent.get(region.regionCode)?.sort(compareRegionForDisplay) ??
            [])
    ]);
});

// Only the canonical product key enters the generic list; the original rows own all business fields.
const regionMobileRows = computed<FsusUiDataListRow[]>(() =>
    displayRegions.value.map((region) => ({ regionCode: region.regionCode }))
);

const formatRegionScope = (region: ModerationRegionDefinition): string =>
{
    if (region.regionCode === "GLOBAL")
    {
        return "默认策略";
    }
    if (region.regionCode === "UNKNOWN")
    {
        return "未知来源";
    }
    const parentCode = getRegionParentCode(region);
    if (parentCode)
    {
        return `${formatRegionName(parentCode)}下属地区`;
    }
    return "独立地区";
};

const formatRegionListMeta = (region: ModerationRegionDefinition): string =>
{
    const parts = [
        formatRegionScope(region),
        region.primaryGroup ? formatRegionName(region.primaryGroup) : null,
        region.policyTemplate ? formatPolicyTemplate(region.policyTemplate) : null,
        region.enabled ? null : "已关闭"
    ].filter((part): part is string => Boolean(part));

    return parts.join(" · ");
};

const formatSourceId = (sourceId?: string | null): string =>
{
    if (!sourceId)
    {
        return "无来源";
    }
    const regionName = formatModerationRegionName(sourceId);
    if (regionName !== sourceId)
    {
        return regionName;
    }
    const version = formatModerationRegionVersion(sourceId);
    return version !== sourceId ? version : sourceId;
};

const formatInheritanceStep = (
    step: ModerationEffectivePolicyStep
): string =>
{
    const formattedStep = formatModerationRegionVersion(step.step);
    return step.step.startsWith("region-policy:")
        ? `${formattedStep}运营策略`
        : formattedStep;
};

const readRuleField = (row: FsusUiDataListRow, key: string): string =>
{
    const value = row[key];
    return typeof value === "string" ? value : "";
};

const formatRuleCategory = (row: FsusUiDataListRow): string =>
    formatRiskCategory(readRuleField(row, "category"));

const formatRuleSubmitAction = (row: FsusUiDataListRow): string =>
    formatPolicyAction(readRuleField(row, "submitAction"));

const formatRuleDisplayAction = (row: FsusUiDataListRow): string =>
    formatPolicyAction(readRuleField(row, "displayAction"));

const formatRuleSource = (row: FsusUiDataListRow): string =>
    `来源：${formatSourceType(readRuleField(row, "sourceType"))} / ${formatSourceId(
        readRuleField(row, "sourceId")
    )}`;

const getRouteRegion = (): string | null =>
    typeof route.query.region === "string" ? route.query.region : null;

const regionPreviewHref = (regionCode: string): string =>
{
    return router.resolve({
        path: route.path,
        query: {
            ...route.query,
            region: regionCode
        }
    }).href;
};

const requireRegionDefinition = (row: FsusUiDataListRow): ModerationRegionDefinition =>
{
    const code = row.regionCode;
    const region = typeof code === "string"
        ? regions.value.find((candidate) => candidate.regionCode === code) : undefined;
    if (!region)
    {
        throw new Error("moderation-region-row-unavailable");
    }
    return region;
};
const getRegionCode = (row: FsusUiDataListRow): string =>
    requireRegionDefinition(row).regionCode;
const regionPreviewHrefForRow = (row: FsusUiDataListRow): string =>
    regionPreviewHref(getRegionCode(row));
const handleMobileRegionClick = (
    row: FsusUiDataListRow,
    key: FsusUiDataListRowKey,
    event: MouseEvent
): void =>
{
    const region = requireRegionDefinition(row);
    if (key !== region.regionCode)
    {
        throw new Error("moderation-region-row-key-mismatch");
    }
    event.preventDefault();
    void previewRegion(region.regionCode);
};

const shouldLoadPreview = (regionCode: string): boolean =>
    selectedRegionCode.value !== regionCode &&
    previewLoadingRegion.value !== regionCode;

const loadRegions = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        regions.value = await listModerationRegions();
        if (regions.value.length === 0)
        {
            return;
        }

        const requestedRegion = getRouteRegion();
        const initialRegion =
            requestedRegion &&
            regions.value.some((region) => region.regionCode === requestedRegion)
                ? requestedRegion
                : displayRegions.value[0]?.regionCode ?? regions.value[0].regionCode;

        if (shouldLoadPreview(initialRegion))
        {
            await loadPreview(initialRegion);
        }
    }
    catch (error)
    {
        showErrorToast(error, "地区定义加载失败");
    }
    finally
    {
        loading.value = false;
    }
};

const selectRegion = (row?: ModerationRegionDefinition): void =>
{
    if (!row)
    {
        return;
    }
    if (!shouldLoadPreview(row.regionCode))
    {
        return;
    }
    void loadPreview(row.regionCode);
};

const previewRegion = async (regionCode: string): Promise<void> =>
{
    if (regionCode !== getRouteRegion())
    {
        await router.push({
            path: route.path,
            query: {
                ...route.query,
                region: regionCode
            }
        });
        return;
    }

    if (!shouldLoadPreview(regionCode))
    {
        return;
    }
    await loadPreview(regionCode, { reveal: true });
};

const loadPreview = async (
    regionCode: string,
    options: { reveal?: boolean; } = {}
): Promise<void> =>
{
    previewLoadingRegion.value = regionCode;
    try
    {
        preview.value = await getModerationEffectivePolicy(regionCode);
        selectedRegionCode.value = regionCode;
        await nextTick();
        regionsTableRef.value?.setCurrentRow(
            displayRegions.value.find((region) => region.regionCode === regionCode)
        );
        if (options.reveal)
        {
            previewSectionRef.value?.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });
        }
    }
    catch (error)
    {
        showErrorToast(error, "生效策略预览加载失败");
    }
    finally
    {
        previewLoadingRegion.value = null;
    }
};

onMounted(() =>
{
    void loadRegions();
});

watch(
    () => route.query.region,
    (region) =>
    {
        if (typeof region !== "string")
        {
            return;
        }
        if (!shouldLoadPreview(region))
        {
            return;
        }
        if (!regions.value.some((item) => item.regionCode === region))
        {
            return;
        }

        void loadPreview(region, { reveal: true });
    }
);
</script>

<style scoped>
.moderation-regions-table-scroll
 {
    max-width: 100%;
    overflow-x: auto;
}

.moderation-regions-table-scroll
 {
    display: none;
}

.moderation-region-name
 {
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    color: var(--fsusblog-text-primary);
}

.moderation-region-name--muted
 {
    color: var(--fsusblog-text-muted);
}

.moderation-region-name--child
 {
    position: relative;
    padding-left: var(--fsus-space-3);
    color: var(--fsusblog-text-muted);
    font-weight: 700;
}

.moderation-region-name--child::before
 {
    position: absolute;
    left: 2px;
    top: 0.1em;
    bottom: 0.1em;
    width: 1px;
    background: var(--fsusblog-panel-border);
    content: "";
}

.moderation-region-preview-link
 {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    justify-content: flex-end;
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    text-decoration: none;
}

.moderation-region-preview-link:hover,
.moderation-region-preview-link.is-active
 {
    color: var(--fsusblog-text-primary);
}

.moderation-region-preview-link.is-loading
 {
    pointer-events: none;
    opacity: 0.62;
}

.moderation-region-table-cell
 {
    display: flex;
    align-items: center;
    min-height: 24px;
}

.moderation-regions-mobile-cell
 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.moderation-regions-mobile-list
 {
    --el-data-list-hover-background: color-mix(
        in srgb,
        var(--fsusblog-color-primary) 5%,
        transparent
    );
    --el-data-list-active-background: color-mix(
        in srgb,
        var(--fsusblog-color-primary) 8%,
        transparent
    );
    --el-data-list-focus-ring: var(--fsusblog-color-focus-ring);
    --el-data-list-active-indicator: var(--fsusblog-color-primary);
    --el-data-list-row-accent-color: var(--fsusblog-text-muted);

    display: grid;
    border-block: 1px solid var(--fsusblog-panel-border);
}

.moderation-regions-mobile-summary
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.moderation-regions-mobile-summary--child
 {
    position: relative;
    padding-left: var(--fsus-space-4);
}

.moderation-regions-mobile-summary--child::before
 {
    position: absolute;
    left: 4px;
    top: 0.18em;
    bottom: 0.18em;
    width: 1px;
    background: var(--fsusblog-panel-border);
    content: "";
}

.moderation-regions-mobile-title
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.15;
}

.moderation-regions-mobile-title.is-active
 {
    color: var(--fsusblog-text-primary);
}

.moderation-regions-mobile-meta
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.2;
}

.moderation-regions-mobile-cell--indicator
 {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    color: var(--el-data-list-row-accent-color);
    opacity: var(--el-data-list-row-accent-opacity);
    transition:
        color var(--blog-motion-fast) var(--blog-motion-ease),
        opacity var(--blog-motion-fast) var(--blog-motion-ease),
        transform var(--blog-motion-fast) var(--blog-motion-ease);
}

.moderation-regions-mobile-cell--indicator svg
 {
    width: 14px;
    height: 14px;
}

.moderation-regions-mobile-cell--indicator.is-active
 {
    transform: translateX(2px);
}

.moderation-regions-preview-meta
 {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: var(--fsus-space-1) var(--fsus-space-3);
    margin-top: var(--fsus-space-1);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
    color: var(--fsusblog-text-primary);
}

.moderation-regions-preview-meta__checksum
 {
    min-width: 0;
    max-width: min(100%, 32rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fsusblog-text-muted);
}

.moderation-regions-rules-list
 {
    display: grid;
}

.moderation-regions-rule-row
 {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fsus-space-3);
    align-items: start;
}

.moderation-regions-rule-summary
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.moderation-regions-rule-category
 {
    overflow: hidden;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.moderation-regions-rule-source
 {
    overflow: visible;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
    white-space: normal;
}

.moderation-regions-rule-actions
 {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--fsus-space-3);
    margin: 0;
}

.moderation-regions-rule-action
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-1);
}

.moderation-regions-rule-action dt
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.2;
}

.moderation-regions-rule-action dd
 {
    min-width: 0;
    margin: 0;
    overflow: visible;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.3;
    white-space: normal;
}
</style>
