import * as echarts from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import { PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent, AriaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  TooltipComponent,
  LegendComponent,
  GridComponent,
  AriaComponent,
  PieChart,
  BarChart,
  CanvasRenderer
])

export { echarts }
export type { EChartsType }
