import type { TagTone, TagVariant } from '@/ui-contracts/primitives'

export type FsusUiTagType = Exclude<TagTone, 'neutral'> | undefined
export type FsusUiTagEffect = 'dark' | undefined

export function toFsusUiTagType(tone: TagTone): FsusUiTagType {
  return tone === 'neutral' ? undefined : tone
}

export function toFsusUiTagEffect(variant: TagVariant): FsusUiTagEffect {
  return variant === 'status' ? 'dark' : undefined
}
