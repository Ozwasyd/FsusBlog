import {
  ElButton,
  ElEmptyState,
  ElMarkdownEditor,
  ElSiteHeader,
  FsuMotion,
  runMotion,
  type EmptyStateProps,
  type MarkdownEditorCommand,
  type MarkdownEditorMode,
  type MotionPresetName,
} from '@ozwasyd/element-plus'
import { themeModes, type ThemeMode } from '@ozwasyd/element-plus/theme'

import type { Component } from 'vue'

const componentExports: Component[] = [
  ElButton,
  ElEmptyState,
  ElMarkdownEditor,
  ElSiteHeader,
  FsuMotion,
]

const emptyStateProps = {
  ariaLive: 'polite',
  description: 'Package export contract',
  illustration: false,
  size: 'inline',
  title: 'FsusUI export',
  titleTag: 'p',
} satisfies Partial<EmptyStateProps>

const markdownMode: MarkdownEditorMode = 'write'
const markdownCommand: MarkdownEditorCommand = {
  apply: (value) => ({
    nextSelection: { end: value.length, start: value.length },
    value,
  }),
  key: 'contract',
  label: 'Contract',
}
const motionPreset: MotionPresetName = 'surface-settle'
const themeMode: ThemeMode = themeModes[0]

export const fsusUiExportContract = {
  componentExports,
  emptyStateProps,
  markdownCommand,
  markdownMode,
  motionPreset,
  runMotion,
  themeMode,
}
