// FsusUI metric-primitives 替代 admin 自造的 DashboardMetricPrimitives：
// - ElMetricList / ElMetricItem：密度感知的 label + primary + secondary + meta 列表行
// - ElDistributionList / ElDistributionBarRow：密度感知的 label + value + ratio 分布条
// - ElEmptyState：FsusUI 原生 empty-state；Blog 上下文 props 由 primitiveAdapters.ts 提供
export {
    ElDistributionBarRow as FsusUiDistributionBarRow,
    ElDistributionList as FsusUiDistributionList,
    ElEmptyState as FsusUiEmptyState,
    ElMetricItem as FsusUiMetricItem,
    ElMetricList as FsusUiMetricList
} from '@ozwasyd/element-plus';
