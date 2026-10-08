import './article-comment-composer-consumer-contract'
import {
  ElButton,
  ElDangerZone,
  ElDestructiveActionPanel,
  ElDistributionBarRow,
  ElDistributionList,
  ElEmptyState,
  ElFormSection,
  ElKeyValueGrid,
  ElKeyValueItem,
  ElKpiGroup,
  ElInlineActions,
  ElMarkdownEditor,
  ElMetadataItem,
  ElMetadataRow,
  ElMetricItem,
  ElMetricList,
  ElRiskNotice,
  ElResourceList,
  ElResourceListItem,
  ElSectionHeader,
  ElSectionNav,
  ElSegmentedControl,
  ElSettingsSection,
  ElSiteHeader,
  ElTypedConfirmField,
  FsusPerceptionChallenge,
  FsusTextTaskChallenge,
  FsuMotion,
  runMotion,
  type EmptyStateProps,
  type MarkdownEditorCommand,
  type MarkdownEditorMode,
  type MotionPresetName,
  type InlineActionsProps,
  type MetadataItemProps,
  type MetadataRowProps,
  type PerceptionChallengeAssignment,
  type PerceptionChallengeClient,
  type PerceptionChallengeExpiredPayload,
  type PerceptionChallengeKind,
  type PerceptionChallengeRenderPayload,
  type PerceptionChallengeRenderer,
  type PerceptionChallengeState,
  type PerceptionChallengeSubmitPayload,
  type PerceptionChallengeVerifyResult,
  type ResourceListItemProps,
  type ResourceListProps,
} from '@ozwasyd/element-plus'
import { themeModes, type ThemeMode } from '@ozwasyd/element-plus/theme'
import {
  FsusUiDangerZone,
  FsusUiDestructiveActionPanel,
  FsusUiFormSection,
  FsusUiRiskNotice,
} from '../../../src/frontend/src/fsusui/dangerZone'
import {
  FsusUiKeyValueGrid,
  FsusUiKeyValueItem,
} from '../../../src/frontend/src/fsusui/keyValueGrid'
import { FsusUiKpiGroup } from '../../../src/frontend/src/fsusui/kpiGroup'
import {
  FsusUiDistributionBarRow,
  FsusUiDistributionList,
  FsusUiEmptyState,
  FsusUiMetricItem,
  FsusUiMetricList,
} from '../../../src/frontend/src/fsusui/metricPrimitives'
import { FsusUiSectionHeader } from '../../../src/frontend/src/fsusui/sectionHeader'
import { FsusUiSectionNav } from '../../../src/frontend/src/fsusui/sectionNav'
import { FsusUiSegmentedControl } from '../../../src/frontend/src/fsusui/segmentedControl'
import {
  FsusUiInlineActions,
  FsusUiMetadataItem,
  FsusUiMetadataRow,
  FsusUiResourceList,
  FsusUiResourceListItem,
  FsusUiSettingsSection,
  type FsusUiInlineActionsProps,
  type FsusUiMetadataItemProps,
  type FsusUiMetadataRowProps,
  type FsusUiResourceListItemProps,
  type FsusUiResourceListProps,
} from '../../../src/frontend/src/fsusui/settingsSection'
import { FsusUiSiteHeader } from '../../../src/frontend/src/fsusui/siteHeader'
import { FsusUiTypedConfirmField } from '../../../src/frontend/src/fsusui/typedConfirmField'

import type { Component } from 'vue'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
type Expect<Value extends true> = Value

type TypePreservingAdapterContract = [
  Expect<Equal<typeof FsusUiDangerZone, typeof ElDangerZone>>,
  Expect<Equal<typeof FsusUiDestructiveActionPanel, typeof ElDestructiveActionPanel>>,
  Expect<Equal<typeof FsusUiDistributionBarRow, typeof ElDistributionBarRow>>,
  Expect<Equal<typeof FsusUiDistributionList, typeof ElDistributionList>>,
  Expect<Equal<typeof FsusUiEmptyState, typeof ElEmptyState>>,
  Expect<Equal<typeof FsusUiFormSection, typeof ElFormSection>>,
  Expect<Equal<typeof FsusUiKeyValueGrid, typeof ElKeyValueGrid>>,
  Expect<Equal<typeof FsusUiKeyValueItem, typeof ElKeyValueItem>>,
  Expect<Equal<typeof FsusUiKpiGroup, typeof ElKpiGroup>>,
  Expect<Equal<typeof FsusUiInlineActions, typeof ElInlineActions>>,
  Expect<Equal<typeof FsusUiMetadataItem, typeof ElMetadataItem>>,
  Expect<Equal<typeof FsusUiMetadataRow, typeof ElMetadataRow>>,
  Expect<Equal<typeof FsusUiMetricItem, typeof ElMetricItem>>,
  Expect<Equal<typeof FsusUiMetricList, typeof ElMetricList>>,
  Expect<Equal<typeof FsusUiRiskNotice, typeof ElRiskNotice>>,
  Expect<Equal<typeof FsusUiResourceList, typeof ElResourceList>>,
  Expect<Equal<typeof FsusUiResourceListItem, typeof ElResourceListItem>>,
  Expect<Equal<typeof FsusUiSectionHeader, typeof ElSectionHeader>>,
  Expect<Equal<typeof FsusUiSectionNav, typeof ElSectionNav>>,
  Expect<Equal<typeof FsusUiSegmentedControl, typeof ElSegmentedControl>>,
  Expect<Equal<typeof FsusUiSettingsSection, typeof ElSettingsSection>>,
  Expect<Equal<typeof FsusUiSiteHeader, typeof ElSiteHeader>>,
  Expect<Equal<typeof FsusUiTypedConfirmField, typeof ElTypedConfirmField>>,
  Expect<Equal<FsusUiInlineActionsProps, InlineActionsProps>>,
  Expect<Equal<FsusUiMetadataItemProps, MetadataItemProps>>,
  Expect<Equal<FsusUiMetadataRowProps, MetadataRowProps>>,
  Expect<Equal<FsusUiResourceListItemProps, ResourceListItemProps>>,
  Expect<Equal<FsusUiResourceListProps, ResourceListProps>>,
]

const componentExports: Component[] = [
  ElButton,
  ElEmptyState,
  ElInlineActions,
  ElMarkdownEditor,
  ElMetadataItem,
  ElMetadataRow,
  ElResourceList,
  ElResourceListItem,
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

const markdownMode: MarkdownEditorMode = 'source'
const markdownCommand: MarkdownEditorCommand = {
  group: 'contract',
  key: 'contract',
  label: 'Contract',
  run: (context) => ({
    focus: 'editor',
    transaction: {
      changes: [],
      history: 'skip',
      origin: 'command',
      selection: context.selection,
    },
  }),
}
// @ts-expect-error The public mode contract no longer accepts write.
const legacyMarkdownMode: MarkdownEditorMode = 'write'
const legacyMarkdownCommand: MarkdownEditorCommand = {
  ...markdownCommand,
  // @ts-expect-error Commands use run(context), not the removed apply path.
  apply: (value: string) => ({ value }),
}
void legacyMarkdownMode
void legacyMarkdownCommand
const motionPreset: MotionPresetName = 'surface-settle'
const themeMode: ThemeMode = themeModes[0]
const perceptionKind: PerceptionChallengeKind = 'localization'
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
  prompt: 'Select contract target',
  renderPayload: perceptionRenderPayload,
} satisfies PerceptionChallengeAssignment
const perceptionSubmitPayload: PerceptionChallengeSubmitPayload = {
  challengeId: 'contract',
  kind: 'localization',
  x: 1,
  y: 1,
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
} satisfies Record<string, unknown>

export type { TypePreservingAdapterContract }
