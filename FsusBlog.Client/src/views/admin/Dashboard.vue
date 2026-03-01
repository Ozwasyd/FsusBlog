<template>
  <div class="dashboard-wrapper">
    <!-- 顶部数据概览卡片 -->
    <el-row :gutter="20" class="mb-5">
      <el-col :xs="24" :sm="12" :lg="6" v-for="item in statCards" :key="item.label" class="mb-4">
        <el-card shadow="hover" class="border-none transition-all duration-300 hover:-translate-y-1">
          <div class="flex items-center gap-4">
            <div :class="['p-4 rounded-xl flex items-center justify-center shrink-0', item.bgClass]">
              <el-icon size="26" :class="item.iconClass">
                <component :is="item.icon" />
              </el-icon>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-zinc-500 text-xs font-bold mb-1 uppercase tracking-wider">{{ item.label }}</p>
              <div class="flex items-baseline">
                <span class="text-2xl font-bold text-zinc-800 tracking-tight tabular-nums">
                  {{ stats[item.key as keyof SiteStats] ?? 0 }}
                </span>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 中部图表区域 -->
    <el-row :gutter="20" class="mb-5">
      <el-col :xs="24" :lg="8" class="mb-5">
        <el-card shadow="never" class="border-zinc-100">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-bold text-zinc-700">访客来源构成</span>
              <el-tooltip content="对比注册用户与匿名访客的活跃度" placement="top">
                <el-icon class="text-zinc-400 cursor-help"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          <div ref="visitChartRef" class="h-75 w-full" v-loading="loading"></div>
        </el-card>
      </el-col>
      
      <el-col :xs="24" :lg="16" class="mb-5">
        <el-card header="地域访问分布 (Top 10)" shadow="never" class="border-zinc-100">
          <div ref="regionChartRef" class="h-75 w-full" v-loading="loading"></div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 底部数据列表区域 -->
    <el-row :gutter="20">
      <el-col :xs="24" :lg="12" class="mb-5">
        <el-card header="热门文章排行" shadow="never" class="border-zinc-100 h-full">
          <el-table :data="stats.popularArticles" style="width: 100%" stripe v-loading="loading">
            <el-table-column type="index" label="Rank" width="70" align="center">
              <template #default="scope">
                <span :class="scope.$index < 3 ? 'text-blue-600 font-bold' : 'text-zinc-400'">
                  #{{ scope.$index + 1 }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="文章标题" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <router-link :to="{ name: 'ArticleDetail', params: { id: String(row.id) } }" class="text-zinc-700 hover:text-blue-600 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm">
                  {{ row.title }}
                </router-link>
              </template>
            </el-table-column>
            <el-table-column prop="views" label="阅读量" width="100" align="right">
              <template #default="{ row }">
                <el-tag size="small" type="info" effect="plain" class="font-mono">
                  {{ row.views }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12" class="mb-5">
        <el-card header="最新评论动态" shadow="never" class="border-zinc-100 h-full">
          <div v-if="!loading && stats.recentComments.length === 0" class="h-75 flex flex-col items-center justify-center">
            <el-empty description="暂无新评论" />
          </div>
          <el-scrollbar v-else height="320px">
            <el-timeline class="p-4">
              <el-timeline-item
                v-for="(comment, index) in stats.recentComments"
                :key="index"
                :timestamp="TimeUtils.toFullLocalString(comment.createTime)"
                placement="top"
                :type="index === 0 ? 'primary' : ''"
              >
                <div class="bg-zinc-50 p-4 rounded-xl border border-zinc-100">
                  <div class="flex items-center mb-1">
                    <span class="font-bold text-sm text-blue-600 tracking-wide">{{ comment.userName }}</span>
                  </div>
                  <p class="text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap word-break-all">{{ comment.content }}</p>
                </div>
              </el-timeline-item>
            </el-timeline>
          </el-scrollbar>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted, nextTick } from 'vue'
import { Document, ChatDotRound, View, Delete, InfoFilled } from '@element-plus/icons-vue'
import { getSiteStats, type SiteStats } from '@/api/stats'
import { TimeUtils } from '@/utils/time'
import * as echarts from 'echarts'

const loading = ref(true)

const stats = shallowRef<SiteStats>({
  totalArticles: 0,
  totalComments: 0,
  trashCount: 0,
  totalVisits: 0,
  registeredVisits: 0,
  anonymousVisits: 0,
  popularArticles: [],
  recentComments: [],
  regionDistributions: []
})

const visitChartRef = ref<HTMLElement>()
const regionChartRef = ref<HTMLElement>()

let chartInstances: echarts.ECharts[] = []
let abortController: AbortController | null = null

const statCards = [
  { label: '文章总计', key: 'totalArticles', icon: Document, bgClass: 'bg-blue-50', iconClass: 'text-blue-600' },
  { label: '评论总计', key: 'totalComments', icon: ChatDotRound, bgClass: 'bg-emerald-50', iconClass: 'text-emerald-600' },
  { label: '累计访问', key: 'totalVisits', icon: View, bgClass: 'bg-orange-50', iconClass: 'text-orange-600' },
  { label: '回收站', key: 'trashCount', icon: Delete, bgClass: 'bg-rose-50', iconClass: 'text-rose-600' }
]

const fetchData = async () => {
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const { signal } = currentController

  loading.value = true
  try {
    const res = await getSiteStats({ signal })
    
    if (abortController === currentController && res) {
      stats.value = res
      await nextTick()
      renderCharts()
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && abortController === currentController) {
      console.error('[Dashboard] Sync failed:', err)
    }
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

/**
 * 物理渲染引擎
 * [修复 2026-02-24] 算法最优：引入极其严格的防御性容错模型
 */
const renderCharts = () => {
  // 1. 安全卸载旧实例
  chartInstances.forEach(ins => {
      try { ins.dispose(); } catch { /* ignore */ }
  })
  chartInstances = []

  // 2. 物理节点探针防御
  // 防止在极端异步场景下（如快速切换路由）DOM 已销毁但执行了 render
  if (!visitChartRef.value || !regionChartRef.value) return;

  try {
    // 渲染饼图
    const vChart = echarts.init(visitChartRef.value)
    vChart.setOption({
      tooltip: { trigger: 'item' },
      legend: { bottom: '5%', icon: 'circle' },
      series: [{
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        data: [
          { value: stats.value.registeredVisits, name: '注册用户', itemStyle: { color: '#409EFF' } },
          { value: stats.value.anonymousVisits, name: '匿名访客', itemStyle: { color: '#e4e7ed' } }
        ]
      }]
    })
    chartInstances.push(vChart)

    // 渲染条形图
    const rChart = echarts.init(regionChartRef.value)
    const chartData = [...stats.value.regionDistributions].slice(0, 10)
    rChart.setOption({
      grid: { top: '5%', left: '3%', right: '5%', bottom: '5%', containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed' } } },
      yAxis: { 
        type: 'category', 
        data: chartData.map(i => i.region.split('-').pop() || '未知'),
        inverse: true
      },
      series: [{
        type: 'bar',
        barWidth: 18,
        itemStyle: {
          borderRadius: [0, 9, 9, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: '#60a5fa' },
            { offset: 1, color: '#2563eb' }
          ])
        },
        data: chartData.map(i => i.count)
      }]
    })
    chartInstances.push(rChart)
  } catch (renderError) {
      console.warn('[Dashboard] Chart render aborted due to DOM anomaly:', renderError);
  }
}

// 采用 RAF (requestAnimationFrame) 替代 setTimeout，获取最平滑的缩放性能
let resizeTimer: number | null = null
const handleResize = () => {
  if (resizeTimer) return
  resizeTimer = requestAnimationFrame(() => {
    chartInstances.forEach(ins => {
        try { ins.resize(); } catch { /* ignore */ }
    })
    resizeTimer = null
  })
}

onMounted(() => {
  fetchData()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (abortController) abortController.abort()
  if (resizeTimer) cancelAnimationFrame(resizeTimer)
  window.removeEventListener('resize', handleResize)
  
  chartInstances.forEach(ins => {
    try {
      ins.dispose()
    } catch (e) { /* ignore */ }
  })
  chartInstances = []
})
</script>

<style scoped>
.dashboard-wrapper {
  animation: page-fade-in 0.5s ease-out;
}

@keyframes page-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.el-card) {
  --el-card-border-radius: 12px;
}

:deep(.el-card__header) {
  padding: 16px 20px;
  font-size: 14px;
  color: #374151;
}

.word-break-all {
  word-break: break-all;
  overflow-wrap: break-word;
}
</style>