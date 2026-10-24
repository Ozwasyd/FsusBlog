<template>
    <div class="account-page dashboard-wrapper account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="数据概览"
            class="account-task-page-header"
            density="compact"
        />

        <DashboardAuthorAnalyticsPanel
            :view="dashboardView"
            class="mb-8"
        />

        <div class="grid grid-cols-1 lg:grid-cols-3 border-y border-[var(--fsusblog-panel-border)]">
            <section class="lg:col-span-1 border-r border-[var(--fsusblog-panel-border)] last:border-r-0 bg-[var(--fsusblog-page-bg)] p-6 flex flex-col">
                <header class="mb-5">
                    <h2 class="dashboard-card-title">访客来源</h2>
                    <p class="dashboard-card-description">注册用户与匿名访问分布。</p>
                </header>
                <div class="flex-1">
                    <FsusUiEmptyState
                        v-if="!loading && !hasVisitSourceData"
                        class="mt-4 border-t border-[var(--fsusblog-panel-border)] pt-4"
                        role="status"
                        title="暂无访问来源数据"
                    />
                    <FsusUiDistributionList
                        v-else
                        class="mt-1"
                        density="compact"
                        v-loading="loading"
                    >
                        <FsusUiDistributionBarRow
                            v-for="item in visitSourceRows"
                            :key="item.label"
                            density="compact"
                            :label="item.label"
                            :value="item.value"
                            :ratio="item.ratio"
                        />
                    </FsusUiDistributionList>
                </div>
            </section>

            <section class="lg:col-span-2 bg-[var(--fsusblog-page-bg)] p-6 flex flex-col">
                <header class="mb-5">
                    <h2 class="dashboard-card-title">地域访问</h2>
                    <p class="dashboard-card-description">流量来源区域分布。</p>
                </header>
                <div class="flex-1">
                    <FsusUiEmptyState
                        v-if="!loading && !hasRegionData"
                        class="mt-4 border-t border-[var(--fsusblog-panel-border)] pt-4"
                        role="status"
                        title="暂无地域访问数据"
                    />
                    <div
                        v-else-if="shouldUseRegionChart"
                        ref="regionChartRef"
                        class="h-75 w-full"
                        role="img"
                        :aria-label="regionChartSummary"
                        v-loading="loading"
                    ></div>
                    <FsusUiDistributionList
                        v-else
                        class="mt-1"
                        density="compact"
                        v-loading="loading"
                    >
                        <FsusUiDistributionBarRow
                            v-for="item in regionRows"
                            :key="item.label"
                            density="compact"
                            :rank="item.rank"
                            :label="item.label"
                            :value="item.value"
                            :ratio="item.ratio"
                        />
                    </FsusUiDistributionList>
                </div>
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import DashboardAuthorAnalyticsPanel from '@/components/admin/DashboardAuthorAnalyticsPanel.vue';
import { useAdminDashboard } from '@/composables/useAdminDashboard';
import {
    FsusUiDistributionBarRow,
    FsusUiDistributionList,
    FsusUiEmptyState,
    FsusUiTaskPageHeader
} from '@/fsusui';

defineOptions({ name: 'AdminAnalytics' });

const { loading, dashboardView } = useAdminDashboard();

interface DistributionRow {
    label: string;
    value: string;
    ratio: number;
    rank: number;
}

const toDistributionRows = (items: readonly { label: string; count: number; }[]): readonly DistributionRow[] =>
{
    const maxCount = Math.max(0, ...items.map((item) => Number(item.count) || 0));
    return items.map((item, index) =>
    {
        const count = Number(item.count) || 0;
        return {
            label: item.label,
            value: String(count),
            ratio: maxCount > 0 ? count / maxCount : 0,
            rank: index + 1
        };
    });
};

const hasVisitSourceData = computed(() =>
    dashboardView.value.visitChart.articleReads > 0
    || dashboardView.value.visitChart.siteReads > 0
    || dashboardView.value.visitChart.humanVerifiedReads > 0
    || dashboardView.value.visitChart.uniqueViewerKeyEstimate > 0
);
const visitSourceRows = computed(() => toDistributionRows([
    { label: '文章阅读', count: dashboardView.value.visitChart.articleReads },
    { label: '站点阅读', count: dashboardView.value.visitChart.siteReads },
    { label: '真人 proof', count: dashboardView.value.visitChart.humanVerifiedReads },
    { label: '独立 viewer key', count: dashboardView.value.visitChart.uniqueViewerKeyEstimate }
]));
const regionRows = computed(() => toDistributionRows(
    dashboardView.value.regionChart.labels.map((label, index) => ({
        label,
        count: dashboardView.value.regionChart.values[index] ?? 0
    }))
));
const hasRegionData = computed(() => regionRows.value.length > 0);
const shouldUseRegionChart = computed(() => regionRows.value.length >= 3);
const regionChartSummary = computed(() =>
{
    const items = regionRows.value.map((item) => `${item.label} ${item.value}`);
    return items.length > 0 ? `地域访问：${items.join('，')}` : '地域访问暂无数据';
});
</script>

<style scoped>
.dashboard-card-title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.35;
}

.dashboard-card-description
 {
    margin: var(--fsus-space-2) 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.6;
}
</style>
