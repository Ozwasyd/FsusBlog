import { ElPageHeader } from '@ozwasyd/element-plus'
import type { Component } from 'vue'

// FsusUI page-header 替代 admin 自造的 AccountPageHeader：
// - title 取代旧组件的 title
// - content 取代旧组件的 description
// - 通过 fsusui/ 适配层暴露，避开业务代码直接 import FsusUI 组件
export const FsusUiPageHeader = ElPageHeader as Component
