import * as echarts from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import { PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  TooltipComponent,
  LegendComponent,
  GridComponent,
  PieChart,
  BarChart,
  CanvasRenderer
])

export { echarts }
export type { EChartsType }
