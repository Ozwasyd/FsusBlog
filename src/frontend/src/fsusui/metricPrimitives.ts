import {
  ElDistributionBarRow,
  ElDistributionList,
  ElEmptyState,
  ElMetricItem,
  ElMetricList
} from '@ozwasyd/element-plus'
import type { Component } from 'vue'

// FsusUI metric-primitives 替代 admin 自造的 DashboardMetricPrimitives：
// - ElMetricList / ElMetricItem：密度感知的 label + primary + secondary + meta 列表行
// - ElDistributionList / ElDistributionBarRow：密度感知的 label + value + ratio 分布条
// - ElEmptyState：FsusUI 原生 empty-state（替换 DashboardInlineEmptyState 的 render 包装）
export const FsusUiMetricList = ElMetricList as Component
export const FsusUiMetricItem = ElMetricItem as Component
export const FsusUiDistributionList = ElDistributionList as Component
export const FsusUiDistributionBarRow = ElDistributionBarRow as Component
export const FsusUiEmptyState = ElEmptyState as Component