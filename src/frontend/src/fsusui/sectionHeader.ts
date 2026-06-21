import { ElSectionHeader } from '@ozwasyd/element-plus'
import type { Component } from 'vue'

// FsusUI section-header 替代 admin 自造的 DashboardSectionHeader：
// - title / description 直接对应
// - 旧组件的 titleId 通过 title slot 注入 <h2 :id> 实现
// - dashboard-section-header--flush 由调用方通过 class 传递
export const FsusUiSectionHeader = ElSectionHeader as Component
