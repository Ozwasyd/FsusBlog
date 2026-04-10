import type { EChartsType } from 'echarts/core'

type EchartsRuntime = typeof import('echarts/core')

let runtimePromise: Promise<EchartsRuntime> | null = null

export type { EChartsType }

export function loadEchartsRuntime(): Promise<EchartsRuntime> {
  if (runtimePromise) {
    return runtimePromise
  }

  runtimePromise = (async () => {
    const [echarts, charts, components, renderers] = await Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers')
    ])

    echarts.use([
      components.TooltipComponent,
      components.LegendComponent,
      components.GridComponent,
      charts.PieChart,
      charts.BarChart,
      renderers.CanvasRenderer
    ])

    return echarts
  })()

  return runtimePromise
}
