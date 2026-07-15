import * as FsusUi from '@ozwasyd/element-plus'
import type { Component } from 'vue'

export type FsusUiSegmentedControlValue = string | number | boolean

export interface FsusUiSegmentedControlItem {
  label: string
  value: FsusUiSegmentedControlValue
  disabled?: boolean
}

// Production Vite resolution aliases this package to the local FsusUI checkout.
// The cast keeps the published-package compatibility typecheck valid until that
// local component is included in a future package release.
export const FsusUiSegmentedControl = (FsusUi as unknown as {
  ElSegmentedControl: Component
}).ElSegmentedControl
