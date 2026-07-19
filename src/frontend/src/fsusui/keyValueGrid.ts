// FsusUI key-value-grid / key-value-item 替代 admin 自造的 cache-kv / integrity-kv / ops-kv
// 三段 scoped CSS（flex + space-between + border-top + 0.75rem padding + 0.75rem font）字节级重复
// 走 density-aware 容器 + label/value/fallback/tone/monospace props；
// 状态色由 tone 驱动（neutral / info / success / warning / danger）。
export {
    ElKeyValueGrid as FsusUiKeyValueGrid,
    ElKeyValueItem as FsusUiKeyValueItem
} from '@ozwasyd/element-plus';
