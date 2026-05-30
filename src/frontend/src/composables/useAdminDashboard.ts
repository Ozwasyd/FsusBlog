import { nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { getAuthorAnalytics } from '@/api/authoring'
import { getAdminStatsQuery } from '@/api/stats'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { loadEchartsRuntime, type EChartsType } from '@/utils/echartsRuntime'
import { isAuthFailureError } from '@/utils/errorKinds'
import { isAbortError } from '@/utils/errors'
import { createAdminDashboardViewContract, type AdminDashboardViewContract } from '@/view-contracts/adminStats'

const readCssToken = (tokenName: string, fallback: string): string => {
  if (typeof window === 'undefined') {
    return fallback
  }

  const tokenValue = window.getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim()
  return tokenValue || fallback
}

export function useAdminDashboard() {
  const { loading, beginLoading, endLoading } = usePagedListState()
  const statsTask = useAbortableTask()
  const { userStore, appShellStore, ensureUserInfo, syncAuthPhase } = useSessionBootstrap()

  const visitChartRef = ref<HTMLElement>()
  const regionChartRef = ref<HTMLElement>()
  const createEmptyDashboardView = (): AdminDashboardViewContract => ({
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
    },
    authorAnalytics: {
      publishedArticles: 0,
      draftArticles: 0,
      scheduledArticles: 0,
      archivedArticles: 0,
      totalHumanReadEvents: 0,
      totalSearchableArticles: 0,
      aotHitRateText: '0%',
      averageDwellText: '0ms',
      readingCompletionText: '0%',
      topSearchKeywords: [],
      topSourceRoutes: [],
      notFoundHotspots: [],
      rumMetrics: [],
      rumPageTypes: [],
      rumAotSources: []
    }
  })
  const dashboardView = shallowRef<AdminDashboardViewContract>(createEmptyDashboardView())

  let chartInstances: EChartsType[] = []
  let resizeTimer: number | null = null
  let chartObserver: IntersectionObserver | null = null
  let chartResizeObserver: ResizeObserver | null = null
  let chartsInitialized = false
  let chartDataReady = false
  let hasFetched = false

  const resetDashboardState = (): void => {
    statsTask.cancel()
    dashboardView.value = createEmptyDashboardView()
    chartDataReady = false
    chartsInitialized = false
    disconnectChartObserver()
    disconnectChartResizeObserver()
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
      const chartPrimary = readCssToken('--fsusblog-text-primary', 'CanvasText')
      const chartSurface = readCssToken('--fsusblog-panel-bg', 'Canvas')
      const chartSurfaceMuted = readCssToken('--fsusblog-color-surface-muted', 'ButtonFace')
      const chartLine = readCssToken('--fsusblog-panel-border', 'GrayText')
      const chartText = readCssToken('--fsusblog-text-secondary', 'CanvasText')

      visitChart.setOption({
        tooltip: {
          trigger: 'item',
          backgroundColor: chartSurface,
          borderColor: chartLine,
          textStyle: { color: chartText }
        },
        legend: {
          bottom: '5%',
          icon: 'circle',
          textStyle: { color: chartText }
        },
        series: [
          {
            type: 'pie',
            radius: ['45%', '70%'],
            center: ['50%', '45%'],
            itemStyle: { borderRadius: 10, borderColor: chartSurface, borderWidth: 2 },
            label: { show: false },
            data: [
              {
                value: dashboardView.value.visitChart.registeredVisits,
                name: '注册用户',
                itemStyle: { color: chartPrimary }
              },
              {
                value: dashboardView.value.visitChart.anonymousVisits,
                name: '匿名访客',
                itemStyle: { color: chartSurfaceMuted }
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
        tooltip: {
          trigger: 'axis',
          backgroundColor: chartSurface,
          borderColor: chartLine,
          textStyle: { color: chartText }
        },
        xAxis: {
          type: 'value',
          axisLabel: { color: chartText },
          axisLine: { lineStyle: { color: chartLine } },
          splitLine: { lineStyle: { color: chartLine, type: 'dashed' } }
        },
        yAxis: {
          type: 'category',
          data: dashboardView.value.regionChart.labels,
          inverse: true,
          axisLabel: { color: chartText },
          axisLine: { lineStyle: { color: chartLine } }
        },
        series: [
          {
            type: 'bar',
            barWidth: 18,
            itemStyle: {
              borderRadius: [0, 9, 9, 0],
              color: chartPrimary
            },
            data: chartData.map((item) => item.count)
          }
        ]
      })
      chartInstances.push(regionChart)
      chartsInitialized = true
      observeChartResize()
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

  const disconnectChartResizeObserver = (): void => {
    if (!chartResizeObserver) {
      return
    }

    chartResizeObserver.disconnect()
    chartResizeObserver = null
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
      const response = await statsTask.run(async (signal) => {
        const [stats, analytics] = await Promise.all([
          getAdminStatsQuery({ signal }),
          getAuthorAnalytics({ signal })
        ])
        return { stats, analytics }
      })

      if (response) {
        dashboardView.value = createAdminDashboardViewContract(
          response.stats.overview,
          response.stats.recentComments,
          response.stats.regions,
          response.analytics
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

  const observeChartResize = (): void => {
    if (chartResizeObserver || typeof ResizeObserver === 'undefined') {
      return
    }

    const targets = [visitChartRef.value, regionChartRef.value].filter((value): value is HTMLElement => Boolean(value))
    if (!targets.length) {
      return
    }

    chartResizeObserver = new ResizeObserver(handleResize)
    targets.forEach((target) => chartResizeObserver?.observe(target))
  }

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
