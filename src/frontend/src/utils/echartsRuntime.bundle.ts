import { PieChart, BarChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent, AriaComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import type { EChartsType } from 'echarts/core';

echarts.use([
    TooltipComponent,
    LegendComponent,
    GridComponent,
    AriaComponent,
    PieChart,
    BarChart,
    CanvasRenderer
]);

export { echarts };
export type { EChartsType };
