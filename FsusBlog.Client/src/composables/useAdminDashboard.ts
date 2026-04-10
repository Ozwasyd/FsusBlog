import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { getSiteStats } from '@/api/stats'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { loadEchartsRuntime, type EChartsType } from '@/utils/echartsRuntime'
import { isAbortError } from '@/utils/errors'
import { createAdminDashboardViewContract, type AdminDashboardViewContract } from '@/view-contracts/adminStats'

export function useAdminDashboard() {
  const { loading, beginLoading, endLoading } = usePagedListState()
  const statsTask = useAbortableTask()

  const visitChartRef = ref<HTMLElement>()
  const regionChartRef = ref<HTMLElement>()
  const dashboardView = shallowRef<AdminDashboardViewContract>({
    statCards: [],
    popularArticles: [],
    recentComments: [],
    visitChart: {
      registeredVisits: 0,
      anonymousVisits: 0
    },
    regionChart: {
      labels: [],
      values: []
    }
  })

  let chartInstances: EChartsType[] = []
  let resizeTimer: number | null = null

  const renderCharts = async (): Promise<void> => {
    const echarts = await loadEchartsRuntime()

    chartInstances.forEach((instance) => {
      try {
        instance.dispose()
      } catch {
        // ignore
      }
    })
    chartInstances = []

    if (!visitChartRef.value || !regionChartRef.value) {
      return
    }

    try {
      const visitChart = echarts.init(visitChartRef.value)
      visitChart.setOption({
        tooltip: { trigger: 'item' },
        legend: { bottom: '5%', icon: 'circle' },
        series: [
          {
            type: 'pie',
            radius: ['45%', '70%'],
            center: ['50%', '45%'],
            itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
            label: { show: false },
            data: [
              {
                value: dashboardView.value.visitChart.registeredVisits,
                name: '注册用户',
                itemStyle: { color: '#409EFF' }
              },
              {
                value: dashboardView.value.visitChart.anonymousVisits,
                name: '匿名访客',
                itemStyle: { color: '#e4e7ed' }
              }
            ]
          }
        ]
      })
      chartInstances.push(visitChart)

      const regionChart = echarts.init(regionChartRef.value)
      const chartData = [...dashboardView.value.regionChart.labels].map((label, index) => ({
        region: label,
        count: dashboardView.value.regionChart.values[index] ?? 0
      }))
      regionChart.setOption({
        grid: {
          top: '5%',
          left: '3%',
          right: '5%',
          bottom: '5%',
          outerBoundsMode: 'same',
          outerBoundsContain: 'axisLabel'
        },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed' } } },
        yAxis: { type: 'category', data: dashboardView.value.regionChart.labels, inverse: true },
        series: [
          {
            type: 'bar',
            barWidth: 18,
            itemStyle: {
              borderRadius: [0, 9, 9, 0],
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: '#60a5fa' },
                { offset: 1, color: '#2563eb' }
              ])
            },
            data: chartData.map((item) => item.count)
          }
        ]
      })
      chartInstances.push(regionChart)
    } catch (error: unknown) {
      console.warn('[Dashboard] Chart render aborted due to DOM anomaly:', error)
    }
  }

  const fetchData = async (): Promise<void> => {
    beginLoading()
    try {
      const response = await statsTask.run(async (signal) => await getSiteStats({ signal }))

      if (response) {
        dashboardView.value = createAdminDashboardViewContract(response)
        await nextTick()
        await renderCharts()
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Dashboard] Sync failed:', error)
      }
    } finally {
      endLoading()
    }
  }

  const handleResize = (): void => {
    if (resizeTimer) {
      return
    }
    resizeTimer = requestAnimationFrame(() => {
      chartInstances.forEach((instance) => {
        try {
          instance.resize()
        } catch {
          // ignore
        }
      })
      resizeTimer = null
    })
  }

  useWindowEvents([{ name: 'resize', handler: handleResize }])

  onMounted(() => {
    void fetchData()
  })

  onUnmounted(() => {
    statsTask.cancel()
    if (resizeTimer) {
      cancelAnimationFrame(resizeTimer)
      resizeTimer = null
    }

    chartInstances.forEach((instance) => {
      try {
        instance.dispose()
      } catch {
        // ignore
      }
    })
    chartInstances = []
  })

  return {
    loading,
    dashboardView,
    visitChartRef,
    regionChartRef
  }
}
