import { ElKpiGroup, ElMetricItem } from '@ozwasyd/element-plus'
import type { Component } from 'vue'

// FsusUI kpi-group / metric-item 替代 admin 自造的 DashboardStatCards：
// - ElKpiGroup 提供 density 容器
// - ElMetricItem 提供 label / primary / secondary / meta 三段展示
// - icon 通过 default slot 由消费方决定，iconName 字典迁移到调用方
export const FsusUiKpiGroup = ElKpiGroup as Component
export const FsusUiMetricItem = ElMetricItem as Component
