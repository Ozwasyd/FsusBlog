<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="author-analytics-title">
    <header class="border-b border-[var(--fsusblog-panel-border)] p-8">
      <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">作者分析 / AUTHOR ANALYTICS</div>
      <h2 id="author-analytics-title" class="mt-4 text-3xl font-bold text-[var(--fsusblog-text-primary)]">内容与技术表现</h2>
      <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
        聚合真实阅读证明、公开路由、搜索与 AOT 运行信号，不采集正文输入或账号敏感字段。
      </p>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-4 gap-px bg-[var(--fsusblog-panel-bg-soft)]">
      <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-8">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
        <div class="mt-5 text-4xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] tabular-nums">{{ metric.value }}</div>
        <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">{{ metric.description }}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-px bg-[var(--fsusblog-panel-bg-soft)] border-t border-[var(--fsusblog-panel-border)]">
      <AnalyticsList title="搜索关键词" empty-text="暂无搜索关键词" :items="analytics.topSearchKeywords" />
      <AnalyticsList title="来源路径" empty-text="暂无来源路径" :items="analytics.topSourceRoutes" />
      <AnalyticsList title="404 热点" empty-text="暂无 404 热点" :items="analytics.notFoundHotspots" />
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-px bg-[var(--fsusblog-panel-bg-soft)] border-t border-[var(--fsusblog-panel-border)]">
      <RumMetricList />
      <AnalyticsList title="RUM 页面类型" empty-text="暂无 RUM 页面样本" :items="analytics.rumPageTypes" />
      <AnalyticsList title="AOT 来源" empty-text="暂无 AOT 来源样本" :items="analytics.rumAotSources" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, type PropType } from 'vue'
import type { AdminDashboardViewContract, AuthorAnalyticsListItem } from '@/view-contracts/adminStats'

const props = defineProps<{
  view: AdminDashboardViewContract
}>()

const analytics = computed(() => props.view.authorAnalytics)
const rumMetrics = computed(() => analytics.value.rumMetrics ?? [])

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

const RumMetricList = defineComponent({
  name: 'RumMetricList',
  setup() {
    return () => h('section', { class: 'bg-[var(--fsusblog-page-bg)] p-8 min-h-72' }, [
      h('h3', { class: 'text-sm font-bold text-[var(--fsusblog-text-primary)]' }, 'Core Web Vitals'),
      rumMetrics.value.length === 0
        ? h('p', { class: 'mt-8 text-[11px] text-[var(--fsusblog-text-tertiary)]' }, '暂无浏览器性能样本')
        : h('div', { class: 'mt-6 space-y-4' }, rumMetrics.value.map((item) => h('div', {
          class: 'border-b border-[var(--fsusblog-panel-border)] pb-3 last:border-b-0'
        }, [
          h('div', { class: 'flex items-center justify-between gap-4' }, [
            h('span', { class: 'min-w-0 truncate text-xs font-bold text-[var(--fsusblog-text-secondary)]' }, item.name),
            h('span', { class: 'shrink-0 text-xs font-bold tabular-nums text-[var(--fsusblog-text-muted)]' }, String(item.count))
          ]),
          h('div', { class: 'mt-2 grid grid-cols-2 gap-3 text-[11px] text-[var(--fsusblog-text-tertiary)]' }, [
            h('span', `P75 ${item.p75Text}`),
            h('span', `Avg ${item.averageText}`)
          ])
        ])))
    ])
  }
})
</script>
