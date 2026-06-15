import { ElEmptyState } from '@ozwasyd/element-plus'
import type { Component } from 'vue'
import type { TagTone, TagVariant } from '@/ui-contracts/primitives'

export type FsusUiTagType = Exclude<TagTone, 'neutral'> | undefined
export type FsusUiTagEffect = 'dark' | undefined
export type FsusBlogInlineEmptyStateContext = 'adminCollection' | 'dashboardMetric'
export type EmptyStateSize = 'inline' | 'compact' | 'page'
export type EmptyStateActionVariant = 'link' | 'secondary' | 'primary'
export type EmptyStateIllustration = boolean | 'auto'
export type EmptyStateTitleTag = 'p' | 'div' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
export type EmptyStateAriaLive = 'off' | 'polite' | 'assertive'

export type FsusUiInlineEmptyStateProps = Readonly<{
  size: EmptyStateSize
  ariaLive: EmptyStateAriaLive
  titleTag: EmptyStateTitleTag
  actionVariant: EmptyStateActionVariant
  illustration: EmptyStateIllustration
}>

export function toFsusUiTagType(tone: TagTone): FsusUiTagType {
  return tone === 'neutral' ? undefined : tone
}

export function toFsusUiTagEffect(variant: TagVariant): FsusUiTagEffect {
  return variant === 'status' ? 'dark' : undefined
}

export function toFsusUiInlineEmptyStateProps(
  context: FsusBlogInlineEmptyStateContext
): FsusUiInlineEmptyStateProps {
  const titleTagByContext: Record<FsusBlogInlineEmptyStateContext, EmptyStateTitleTag> = {
    adminCollection: 'p',
    dashboardMetric: 'p'
  }

  return {
    size: 'inline',
    ariaLive: 'polite',
    titleTag: titleTagByContext[context],
    actionVariant: 'link',
    illustration: false
  }
}

export function resolveFsusUiEmptyState(): Component {
  return ElEmptyState as Component
}
