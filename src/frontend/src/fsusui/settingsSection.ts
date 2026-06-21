import { ElSettingsSection } from '@ozwasyd/element-plus'
import type { Component } from 'vue'

// FsusUI settings-section 替代 admin 自造的 WorkbenchPanel：
// - title / description 取代旧 title / caption
// - titleTag 取代旧 titleLevel
// - id 取代旧 titleId（aria-labelledby 由组件自处理）
// - 旧 headerClass 由调用方通过 class 传递
export const FsusUiSettingsSection = ElSettingsSection as Component
