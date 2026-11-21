export const minimumEditorWidthRem = 29
export const splitterWidthRem = 1
export const defaultPrimaryWidth = 50

export type LayoutDirection = 1 | -1

export type SplitLayoutMeasure = Readonly<{
  width: number
  rem: number
}>

export type SplitLayoutMetricsInput = Readonly<{
  width: number
  rem: number
  preferredPrimaryWidth: number
  twoSources: boolean
  comparisonReady: boolean
}>

export type SplitLayoutMetrics = Readonly<{
  trackWidth: number
  minimumShare: number
  wideEditorArea: boolean
  primaryWidth: number
  showComparison: boolean
  splitColumns: string | undefined
}>

export type SplitPointerStart = Readonly<{
  pointerId: number
  isPrimary: boolean
  button: number
  clientX: number
}>

export type SplitPointerMove = Readonly<{
  pointerId: number
  clientX: number
}>

export type SplitResizeStartContext = Readonly<{
  showComparison: boolean
  primaryWidth: number
  direction: LayoutDirection
  trackWidth: number
}>

export type SplitResizeMoveContext = Readonly<{
  showComparison: boolean
  minimumShare: number
}>

export type SplitKeyboardEvent = Readonly<{
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}>

export type SplitKeyboardContext = Readonly<{
  showComparison: boolean
  primaryWidth: number
  minimumShare: number
  direction: LayoutDirection
}>

type ActiveDrag = Readonly<{
  pointer: number
  start: number
  width: number
  direction: LayoutDirection
  tracks: number
}>

export function clampPrimaryWidth(width: number, minimumShare: number): number {
  return Math.max(minimumShare, Math.min(100 - minimumShare, Math.round(width)))
}

export function computeSplitLayoutMetrics(input: SplitLayoutMetricsInput): SplitLayoutMetrics {
  const trackWidth = input.width - splitterWidthRem * input.rem
  const minimumShare = trackWidth > 0
    ? Math.max(30, Math.ceil(100 * minimumEditorWidthRem * input.rem / trackWidth))
    : 100
  const wideEditorArea = minimumShare <= 50
  const primaryWidth = Math.max(minimumShare, Math.min(100 - minimumShare, input.preferredPrimaryWidth))
  const showComparison = input.twoSources && wideEditorArea && input.comparisonReady
  const splitColumns = showComparison
    ? `minmax(0, ${primaryWidth}fr) ${splitterWidthRem}rem minmax(0, ${100 - primaryWidth}fr)`
    : undefined
  return { trackWidth, minimumShare, wideEditorArea, primaryWidth, showComparison, splitColumns }
}

export function resolveKeyboardResize(event: SplitKeyboardEvent, context: SplitKeyboardContext): number | undefined {
  if (!context.showComparison || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  const width = event.key === 'ArrowLeft' ? context.primaryWidth - context.direction
    : event.key === 'ArrowRight' ? context.primaryWidth + context.direction
    : event.key === 'Home' ? context.minimumShare
    : event.key === 'End' ? 100 - context.minimumShare
    : undefined
  return width === undefined ? undefined : clampPrimaryWidth(width, context.minimumShare)
}

export function createSplitResizeController() {
  let active: ActiveDrag | undefined

  return {
    isActive(): boolean {
      return active !== undefined
    },

    start(event: SplitPointerStart, context: SplitResizeStartContext): boolean {
      if (!context.showComparison || active || !event.isPrimary || event.button !== 0 || context.trackWidth <= 0) {
        return false
      }
      active = {
        pointer: event.pointerId,
        start: event.clientX,
        width: context.primaryWidth,
        direction: context.direction,
        tracks: context.trackWidth,
      }
      return true
    },

    move(event: SplitPointerMove, context: SplitResizeMoveContext): number | undefined {
      if (!active || active.pointer !== event.pointerId || !context.showComparison) return undefined
      const raw = active.width + active.direction * (event.clientX - active.start) / active.tracks * 100
      return clampPrimaryWidth(raw, context.minimumShare)
    },

    end(pointerId: number): boolean {
      if (active?.pointer !== pointerId) return false
      active = undefined
      return true
    },

    cancel(): void {
      active = undefined
    },
  }
}
