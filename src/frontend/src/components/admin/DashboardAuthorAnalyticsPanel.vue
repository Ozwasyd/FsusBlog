<template>
    <section
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
        aria-labelledby="author-analytics-title"
    >
        <header class="dashboard-analytics-header">
            <FsusUiSectionHeader
                id="author-analytics-title"
                class="dashboard-section-header--flush"
                title="内容与技术表现"
                description="阅读数据、搜索表现与运行状态。"
            >
                <template #description>
                    阅读数据、搜索表现与运行状态。
                    <span class="dashboard-section-note">仅使用站点运行信号，不采集正文输入或账号敏感字段。</span>
                </template>
            </FsusUiSectionHeader>
        </header>

        <AdminStatusMatrix
            :items="metrics"
            density="compact"
            aria-label="内容与技术表现指标"
        />

        <div class="dashboard-analytics-grid dashboard-analytics-grid--lists">
            <AnalyticsList
                title="搜索关键词"
                empty-text="暂无搜索关键词"
                :items="analytics.topSearchKeywords"
            />
            <AnalyticsList
                title="来源路径"
                empty-text="暂无来源路径"
                :items="analytics.topSourceRoutes"
            />
            <AnalyticsList
                title="404 热点"
                empty-text="暂无 404 热点"
                :items="analytics.notFoundHotspots"
            />
        </div>

        <div class="dashboard-analytics-grid">
            <section class="dashboard-analytics-panel">
                <h3 class="dashboard-analytics-panel__title">Core Web Vitals</h3>
                <p class="dashboard-analytics-panel__description">关键渲染指标。</p>
                <FsusUiEmptyState
                    v-if="rumMetricRows.length === 0"
                    class="dashboard-analytics-panel__empty"
                    role="status"
                    title="暂无浏览器性能样本"
                />
                <dl
                    v-else
                    class="dashboard-analytics-panel__content dashboard-rum-metrics"
                >
                    <div
                        v-for="metric in rumMetricRows"
                        :key="metric.label"
                        class="dashboard-rum-metric"
                    >
                        <dt class="dashboard-rum-metric__name">{{ metric.primary }}</dt>
                        <dd class="dashboard-rum-metric__value">{{ metric.label }}</dd>
                        <dd class="dashboard-rum-metric__meta">{{ metric.secondary.join(' · ') }} · {{ metric.meta }}</dd>
                    </div>
                </dl>
            </section>

            <section class="dashboard-analytics-panel">
                <h3 class="dashboard-analytics-panel__title">RUM 页面类型</h3>
                <p class="dashboard-analytics-panel__description">页面访问分布。</p>
                <FsusUiEmptyState
                    v-if="rumPageTypeRows.length === 0"
                    class="dashboard-analytics-panel__empty"
                    role="status"
                    title="暂无 RUM 页面样本"
                />
                <FsusUiDistributionList
                    v-else
                    class="dashboard-analytics-panel__content"
                    density="compact"
                >
                    <FsusUiDistributionBarRow
                        v-for="item in rumPageTypeRows"
                        :key="item.label"
                        density="compact"
                        :rank="item.rank"
                        :label="item.label"
                        :value="item.value"
                        :ratio="item.ratio"
                    />
                </FsusUiDistributionList>
            </section>

            <section class="dashboard-analytics-panel">
                <h3 class="dashboard-analytics-panel__title">AOT 来源</h3>
                <p class="dashboard-analytics-panel__description">渲染来源分布。</p>
                <FsusUiEmptyState
                    v-if="rumAotSourceRows.length === 0"
                    class="dashboard-analytics-panel__empty"
                    role="status"
                    title="暂无 AOT 来源样本"
                />
                <FsusUiDistributionList
                    v-else
                    class="dashboard-analytics-panel__content"
                    density="compact"
                >
                    <FsusUiDistributionBarRow
                        v-for="item in rumAotSourceRows"
                        :key="item.label"
                        density="compact"
                        :rank="item.rank"
                        :label="item.label"
                        :value="item.value"
                        :ratio="item.ratio"
                    />
                </FsusUiDistributionList>
            </section>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue';
import AnalyticsList from '@/components/admin/DashboardAuthorAnalyticsList.vue';
import {
    FsusUiDistributionBarRow,
    FsusUiDistributionList,
    FsusUiEmptyState,
    FsusUiSectionHeader
} from '@/fsusui';
import type { AdminDashboardViewContract, AuthorAnalyticsListItem } from '@/view-contracts/adminStats';

const props = defineProps<{
    view: AdminDashboardViewContract;
}>();

const analytics = computed(() => props.view.authorAnalytics);
const rumMetrics = computed(() => analytics.value.rumMetrics ?? []);

interface MetricRow {
    label: string;
    primary: string;
    secondary: readonly string[];
    meta: string;
}

interface DistributionRow {
    label: string;
    value: string;
    ratio: number;
    rank: number;
}

const metrics = computed<readonly AdminStatusMatrixItem[]>(() => [
    {
        label: '真实阅读',
        value: analytics.value.totalHumanReadEvents,
        helper: '站点和文章阅读事件。'
    },
    {
        label: '阅读完成度',
        value: analytics.value.readingCompletionText,
        helper: '近 5000 条；停留 30s 以上。'
    },
    {
        label: 'AOT 命中率',
        value: analytics.value.aotHitRateText,
        helper: '按公开阅读与 AOT miss 估算。'
    },
    {
        label: '平均停留',
        value: analytics.value.averageDwellText,
        helper: '近 5000 条真实阅读事件。'
    }
]);

const RUM_METRIC_LABELS: Record<string, string> = {
    navigation_timing: '页面导航耗时',
    wasm_decode_timing: 'WASM 解码耗时',
    web_vital_cls: '累积布局偏移 (CLS)',
    web_vital_lcp: '最大内容绘制 (LCP)'
};

const RUM_DISTRIBUTION_LABELS: Record<string, string> = {
    home: '首页',
    about: '关于页',
    public: '公开页',
    archive: '归档页',
    spa: 'SPA',
    'server-aot': 'Server AOT'
};

const formatRawLabel = (value: string): string => value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.length <= 3
        ? segment.toUpperCase()
        : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(' ');

const formatRumMetricName = (name: string): string => RUM_METRIC_LABELS[name] ?? formatRawLabel(name);
const formatDistributionLabel = (label: string): string => RUM_DISTRIBUTION_LABELS[label] ?? formatRawLabel(label);

const toDistributionRows = (items: readonly AuthorAnalyticsListItem[]): readonly DistributionRow[] =>
{
    const maxCount = Math.max(0, ...items.map((item) => Number(item.count) || 0));
    return items.map((item, index) =>
    {
        const count = Number(item.count) || 0;
        return {
            label: formatDistributionLabel(item.label),
            value: String(count),
            ratio: maxCount > 0 ? count / maxCount : 0,
            rank: index + 1
        };
    });
};

const rumMetricRows = computed<readonly MetricRow[]>(() => rumMetrics.value.map((item) => ({
    label: `P75 ${item.p75Text}`,
    primary: formatRumMetricName(item.name),
    secondary: [`平均 ${item.averageText}`],
    meta: `${item.count} 次记录`
})));

const rumPageTypeRows = computed(() => toDistributionRows(analytics.value.rumPageTypes));
const rumAotSourceRows = computed(() => toDistributionRows(analytics.value.rumAotSources));
</script>

<style scoped>
.dashboard-analytics-header
 {
    padding: var(--fsus-space-4);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.dashboard-analytics-grid
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    border-top: 1px solid var(--fsusblog-panel-border);
}

.dashboard-analytics-panel
 {
    min-width: 0;
    padding: var(--fsus-space-4);
    background: var(--fsusblog-page-bg);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.dashboard-analytics-panel:last-child
 {
    border-bottom: 0;
}

.dashboard-analytics-panel__title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.35;
}

.dashboard-analytics-panel__description
 {
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.5;
}

.dashboard-analytics-panel__content,
.dashboard-analytics-panel__empty
 {
    margin-top: var(--fsus-space-3);
    padding-top: var(--fsus-space-3);
    border-top: 1px solid var(--fsusblog-panel-border);
}

@media (width >= 1024px)
 {
    .dashboard-analytics-grid
 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .dashboard-analytics-panel
 {
        border-right: 1px solid var(--fsusblog-panel-border);
        border-bottom: 0;
    }

    .dashboard-analytics-panel:last-child
 {
        border-right: 0;
    }
}

.dashboard-rum-metrics
 {
    display: grid;
    gap: 0;
    margin-bottom: 0;
}

.dashboard-rum-metric
 {
    min-width: 0;
    padding: var(--fsus-space-3) 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.dashboard-rum-metric:first-child
 {
    padding-top: 0;
}

.dashboard-rum-metric:last-child
 {
    padding-bottom: 0;
    border-bottom: 0;
}

.dashboard-rum-metric__name,
.dashboard-rum-metric__value,
.dashboard-rum-metric__meta
 {
    margin: 0;
    letter-spacing: 0;
    line-height: 1.35;
}

.dashboard-rum-metric__name
 {
    color: var(--fsusblog-text-primary);
    font-size: 16px;
    font-weight: 700;
}

.dashboard-rum-metric__value
 {
    margin-top: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.dashboard-rum-metric__meta
 {
    margin-top: var(--fsus-space-1);
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    font-weight: 500;
}
</style>
