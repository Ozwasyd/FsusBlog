import {
  ElButton,
  ElEmptyState,
  ElMarkdownEditor,
  ElSiteHeader,
  FsusPerceptionChallenge,
  FsusTextTaskChallenge,
  FsuMotion,
  runMotion,
  type EmptyStateProps,
  type MarkdownEditorCommand,
  type MarkdownEditorMode,
  type MotionPresetName,
  type PerceptionChallengeAssignment,
  type PerceptionChallengeClient,
  type PerceptionChallengeExpiredPayload,
  type PerceptionChallengeKind,
  type PerceptionChallengeRenderPayload,
  type PerceptionChallengeRenderer,
  type PerceptionChallengeState,
  type PerceptionChallengeSubmitPayload,
  type PerceptionChallengeVerifyResult,
} from '@ozwasyd/element-plus'
import { themeModes, type ThemeMode } from '@ozwasyd/element-plus/theme'

import type { Component } from 'vue'

const componentExports: Component[] = [
  ElButton,
  ElEmptyState,
  ElMarkdownEditor,
  ElSiteHeader,
  FsusPerceptionChallenge,
  FsusTextTaskChallenge,
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
const perceptionKind: PerceptionChallengeKind = 'text-task'
const perceptionState: PerceptionChallengeState = 'ready'
const perceptionRenderPayload: PerceptionChallengeRenderPayload = {
  alt: 'Contract challenge',
  height: 1,
  kind: 'rgba-raster',
  pixels: new Uint8ClampedArray(4),
  width: 1,
}
const perceptionAssignment = {
  challengeId: 'contract',
  kind: perceptionKind,
  prompt: 'Type contract',
  renderPayload: perceptionRenderPayload,
} satisfies PerceptionChallengeAssignment
const perceptionSubmitPayload: PerceptionChallengeSubmitPayload = {
  challengeId: 'contract',
  kind: 'text-task',
  value: 'ok',
}
const perceptionVerifyResult: PerceptionChallengeVerifyResult = {
  proofToken: 'contract-proof',
  verified: true,
}
const perceptionExpiredPayload: PerceptionChallengeExpiredPayload = {
  challengeId: 'contract',
  reason: 'expiresAtUnixMs',
}
const perceptionClient: PerceptionChallengeClient = {
  refresh: () => perceptionAssignment,
  verify: () => perceptionVerifyResult,
}
const perceptionRenderer: PerceptionChallengeRenderer = {
  render: () => perceptionRenderPayload,
}

export const fsusUiExportContract = {
  componentExports,
  emptyStateProps,
  markdownCommand,
  markdownMode,
  motionPreset,
  perceptionAssignment,
  perceptionClient,
  perceptionExpiredPayload,
  perceptionRenderer,
  perceptionState,
  perceptionSubmitPayload,
  runMotion,
  themeMode,
}
