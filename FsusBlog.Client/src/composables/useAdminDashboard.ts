import { nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { getRecentCommentStats, getRegionStats, getSiteStatsOverview } from '@/api/stats'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { loadEchartsRuntime, type EChartsType } from '@/utils/echartsRuntime'
import { isAuthFailureError } from '@/utils/errorKinds'
import { isAbortError } from '@/utils/errors'
import { createAdminDashboardViewContract, type AdminDashboardViewContract } from '@/view-contracts/adminStats'

export function useAdminDashboard() {
  const { loading, beginLoading, endLoading } = usePagedListState()
  const statsTask = useAbortableTask()
  const { userStore, appShellStore, ensureUserInfo, syncAuthPhase } = useSessionBootstrap()

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
  let chartObserver: IntersectionObserver | null = null
  let chartsInitialized = false
  let chartDataReady = false
  let hasFetched = false

  const resetDashboardState = (): void => {
    statsTask.cancel()
    dashboardView.value = {
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
    }
    chartDataReady = false
    chartsInitialized = false
    disconnectChartObserver()
    chartInstances.forEach((instance) => {
      try {
        instance.dispose()
      } catch {
        // ignore
      }
    })
    chartInstances = []
  }

  const renderCharts = async (): Promise<void> => {
    if (chartsInitialized) {
      return
    }

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
      chartsInitialized = true
    } catch (error: unknown) {
      console.warn('[Dashboard] Chart render aborted due to DOM anomaly:', error)
    }
  }

  const disconnectChartObserver = (): void => {
    if (!chartObserver) {
      return
    }

    chartObserver.disconnect()
    chartObserver = null
  }

  const tryRenderCharts = async (): Promise<void> => {
    if (!chartDataReady || chartsInitialized) {
      return
    }

    if (!visitChartRef.value || !regionChartRef.value) {
      return
    }

    await renderCharts()
    disconnectChartObserver()
  }

  const observeChartVisibility = (): void => {
    if (chartsInitialized || chartObserver || !chartDataReady) {
      return
    }

    const targets = [visitChartRef.value, regionChartRef.value].filter((value): value is HTMLElement => Boolean(value))
    if (!targets.length) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      void tryRenderCharts()
      return
    }

    chartObserver = new IntersectionObserver((entries) => {
      const hasVisibleTarget = entries.some((entry) => entry.isIntersecting)
      if (hasVisibleTarget) {
        void tryRenderCharts()
      }
    }, {
      root: null,
      threshold: 0.15
    })

    targets.forEach((target) => chartObserver?.observe(target))
  }

  const fetchData = async (): Promise<void> => {
    if (!userStore.isAuthChecked) {
      await ensureUserInfo()
      syncAuthPhase()
    }

    if (!userStore.isLoggedIn || !userStore.isAdmin || appShellStore.authPhase !== 'authenticated') {
      hasFetched = false
      resetDashboardState()
      endLoading()
      return
    }

    beginLoading()
    try {
      const response = await statsTask.run(async (signal) => await getSiteStatsOverview({ signal }))

      if (response) {
        const [recentCommentsResult, regionsResult] = await Promise.allSettled([
          getRecentCommentStats(),
          getRegionStats()
        ])
        dashboardView.value = createAdminDashboardViewContract(
          response,
          recentCommentsResult.status === 'fulfilled' ? (recentCommentsResult.value ?? []) : [],
          regionsResult.status === 'fulfilled' ? (regionsResult.value ?? []) : []
        )
        chartDataReady = true
        hasFetched = true
        await nextTick()
        observeChartVisibility()
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (!isAuthFailureError(error)) {
          console.error('[Dashboard] Sync failed:', error)
        }
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

  watch(
    () => [userStore.isAuthChecked, userStore.isLoggedIn, userStore.isAdmin, appShellStore.authPhase] as const,
    ([isAuthChecked, isLoggedIn, isAdmin, authPhase]) => {
      if (!isAuthChecked || !isLoggedIn || !isAdmin || authPhase !== 'authenticated') {
        hasFetched = false
        resetDashboardState()
        return
      }

      if (!hasFetched) {
        void fetchData()
      }
    },
    { immediate: true }
  )

  onUnmounted(() => {
    resetDashboardState()
    if (resizeTimer) {
      cancelAnimationFrame(resizeTimer)
      resizeTimer = null
    }
  })

  return {
    loading,
    dashboardView,
    visitChartRef,
    regionChartRef
  }
}
