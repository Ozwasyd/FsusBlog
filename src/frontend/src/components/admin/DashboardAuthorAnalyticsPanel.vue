<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="author-analytics-title">
    <header class="border-b border-[var(--fsusblog-panel-border)] px-8 py-6">
      <DashboardSectionHeader
        class="dashboard-section-header--flush"
        title="内容与技术表现"
        title-id="author-analytics-title"
        description="阅读数据、搜索表现与运行状态。"
        note="仅使用站点运行信号，不采集正文输入或账号敏感字段。"
      />
    </header>

    <div class="grid grid-cols-1 gap-3 lg:grid-cols-4">
      <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-8">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
        <div class="mt-5 text-2xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] tabular-nums">{{ metric.value }}</div>
        <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">{{ metric.description }}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 border-t border-[var(--fsusblog-panel-border)] lg:grid-cols-3">
      <AnalyticsList title="搜索关键词" empty-text="暂无搜索关键词" :items="analytics.topSearchKeywords" />
      <AnalyticsList title="来源路径" empty-text="暂无来源路径" :items="analytics.topSourceRoutes" />
      <AnalyticsList title="404 热点" empty-text="暂无 404 热点" :items="analytics.notFoundHotspots" />
    </div>

    <div class="grid grid-cols-1 gap-3 border-t border-[var(--fsusblog-panel-border)] lg:grid-cols-3">
      <section class="bg-[var(--fsusblog-page-bg)] p-8 min-h-72">
        <h3 class="text-base font-bold leading-tight text-[var(--fsusblog-text-primary)]">Core Web Vitals</h3>
        <p class="mt-1 text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">关键渲染指标。</p>
        <DashboardInlineEmptyState
          v-if="rumMetricRows.length === 0"
          title="暂无浏览器性能样本"
          description="有运行时样本后将在这里显示 P75 和平均值。"
        />
        <DashboardMetricList v-else class="mt-5" density="compact">
          <DashboardMetricItem
            v-for="metric in rumMetricRows"
            :key="metric.label"
            density="compact"
            :label="metric.label"
            :primary="metric.primary"
            :secondary="metric.secondary"
            :meta="metric.meta"
          />
        </DashboardMetricList>
      </section>

      <section class="bg-[var(--fsusblog-page-bg)] p-8 min-h-72">
        <h3 class="text-base font-bold leading-tight text-[var(--fsusblog-text-primary)]">RUM 页面类型</h3>
        <p class="mt-1 text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">页面访问分布。</p>
        <DashboardInlineEmptyState
          v-if="rumPageTypeRows.length === 0"
          title="暂无 RUM 页面样本"
          description="有访问记录后将在这里显示分布。"
        />
        <DashboardDistributionList v-else class="mt-5" density="compact">
          <DashboardDistributionBarRow
            v-for="item in rumPageTypeRows"
            :key="item.label"
            density="compact"
            :rank="item.rank"
            :label="item.label"
            :value="item.value"
            :ratio="item.ratio"
          />
        </DashboardDistributionList>
      </section>

      <section class="bg-[var(--fsusblog-page-bg)] p-8 min-h-72">
        <h3 class="text-base font-bold leading-tight text-[var(--fsusblog-text-primary)]">AOT 来源</h3>
        <p class="mt-1 text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">渲染来源分布。</p>
        <DashboardInlineEmptyState
          v-if="rumAotSourceRows.length === 0"
          title="暂无 AOT 来源样本"
          description="有 AOT 运行记录后将在这里显示分布。"
        />
        <DashboardDistributionList v-else class="mt-5" density="compact">
          <DashboardDistributionBarRow
            v-for="item in rumAotSourceRows"
            :key="item.label"
            density="compact"
            :rank="item.rank"
            :label="item.label"
            :value="item.value"
            :ratio="item.ratio"
          />
        </DashboardDistributionList>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, type PropType } from 'vue'
import DashboardSectionHeader from '@/components/admin/DashboardSectionHeader.vue'
import {
  DashboardDistributionBarRow,
  DashboardDistributionList,
  DashboardInlineEmptyState,
  DashboardMetricItem,
  DashboardMetricList
} from '@/components/admin/DashboardMetricPrimitives'
import type { AdminDashboardViewContract, AuthorAnalyticsListItem } from '@/view-contracts/adminStats'

const props = defineProps<{
  view: AdminDashboardViewContract
}>()

const analytics = computed(() => props.view.authorAnalytics)
const rumMetrics = computed(() => analytics.value.rumMetrics ?? [])

type MetricRow = Readonly<{
  label: string
  primary: string
  secondary: readonly string[]
  meta: string
}>

type DistributionRow = Readonly<{
  label: string
  value: string
  ratio: number
  rank: number
}>

const metrics = computed(() => [
  {
    label: '真实阅读',
    value: analytics.value.totalHumanReadEvents,
    description: 'HumanReadProof 接受的站点和文章阅读事件。'
  },
  {
    label: '阅读完成度',
    value: analytics.value.readingCompletionText,
    description: '近 5000 条文章阅读中停留 30s 以上的比例。'
  },
  {
    label: 'AOT 命中率',
    value: analytics.value.aotHitRateText,
    description: '按公开阅读事件与 AOT miss 日志估算。'
  },
  {
    label: '平均停留',
    value: analytics.value.averageDwellText,
    description: '近 5000 条真实阅读事件的平均 dwell。'
  }
])

const RUM_METRIC_LABELS: Readonly<Record<string, string>> = {
  navigation_timing: '页面导航耗时',
  wasm_decode_timing: 'WASM 解码耗时',
  web_vital_cls: '累积布局偏移 (CLS)',
  web_vital_lcp: '最大内容绘制 (LCP)'
}

const RUM_DISTRIBUTION_LABELS: Readonly<Record<string, string>> = {
  home: '首页',
  about: '关于页',
  public: '公开页',
  archive: '归档页',
  spa: 'SPA',
  'server-aot': 'Server AOT'
}

const formatRawLabel = (value: string): string => value
  .split(/[-_\s]+/)
  .filter(Boolean)
  .map((segment) => segment.length <= 3
    ? segment.toUpperCase()
    : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
  .join(' ')

const formatRumMetricName = (name: string): string => RUM_METRIC_LABELS[name] ?? formatRawLabel(name)
const formatDistributionLabel = (label: string): string => RUM_DISTRIBUTION_LABELS[label] ?? formatRawLabel(label)

const toDistributionRows = (items: readonly AuthorAnalyticsListItem[]): readonly DistributionRow[] => {
  const maxCount = Math.max(0, ...items.map((item) => Number(item.count) || 0))
  return items.map((item, index) => {
    const count = Number(item.count) || 0
    return {
      label: formatDistributionLabel(item.label),
      value: String(count),
      ratio: maxCount > 0 ? count / maxCount : 0,
      rank: index + 1
    }
  })
}

const rumMetricRows = computed<readonly MetricRow[]>(() => rumMetrics.value.map((item) => ({
  label: formatRumMetricName(item.name),
  primary: `P75 ${item.p75Text}`,
  secondary: [`平均 ${item.averageText}`],
  meta: `${item.count} 次记录`
})))

const rumPageTypeRows = computed(() => toDistributionRows(analytics.value.rumPageTypes))
const rumAotSourceRows = computed(() => toDistributionRows(analytics.value.rumAotSources))

const AnalyticsList = defineComponent({
  name: 'AnalyticsList',
  props: {
    title: { type: String, required: true },
    emptyText: { type: String, required: true },
    items: { type: Array as PropType<readonly AuthorAnalyticsListItem[]>, required: true }
  },
  setup(listProps) {
    return () => h('section', { class: 'bg-[var(--fsusblog-page-bg)] p-8 min-h-72' }, [
      h('h3', { class: 'text-sm font-bold text-[var(--fsusblog-text-primary)]' }, listProps.title),
      listProps.items.length === 0
        ? h('p', { class: 'mt-8 text-[11px] text-[var(--fsusblog-text-tertiary)]' }, listProps.emptyText)
        : h('ol', { class: 'mt-6 space-y-4' }, listProps.items.map((item, index) => h('li', {
          class: 'flex items-center justify-between gap-4 border-b border-[var(--fsusblog-panel-border)] pb-3 last:border-b-0'
        }, [
          h('span', { class: 'min-w-0 truncate text-xs font-bold text-[var(--fsusblog-text-secondary)]' }, `${index + 1}. ${item.label}`),
          h('span', { class: 'shrink-0 text-xs font-bold tabular-nums text-[var(--fsusblog-text-muted)]' }, String(item.count))
        ])))
    ])
  }
})

</script>
