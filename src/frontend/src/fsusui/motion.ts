import * as FsusUi from '@ozwasyd/element-plus'
import type { Component, Directive, Plugin } from 'vue'

export type MotionPresetName = string
export type MotionPhase = 'enter' | 'leave'

export type MotionBudgetConfig = {
  maxStaggerItems: number
  maxAnimatedNodesPerViewport: number
  disableScrollEffectsBelowFps: number
  disableBlurOnLowPower: boolean
  disableParallaxOnTouch: boolean
  preferCssWhenPossible: boolean
  allowedProperties: readonly string[]
}

export type MotionOptions = {
  name?: MotionPresetName | false | null
  duration?: string | number
  delay?: string | number
  easing?: string
  index?: number
  disabled?: boolean
  once?: boolean
  immediate?: boolean
  budget?: Partial<MotionBudgetConfig>
}

export type MotionDirectiveValue =
  | MotionPresetName
  | MotionOptions
  | false
  | null
  | undefined

export type MotionRunOptions = Omit<MotionOptions, 'name'> & {
  name: MotionPresetName | false | null | undefined
  phase?: MotionPhase
  onFinish?: () => void
}

export type MotionRuntimeControls = {
  cancel: () => void
  finish: () => void
}

export type ScrollRevealOptions = {
  target?: unknown
  name?: MotionPresetName | false | null
  duration?: string | number
  disabled?: boolean
  once?: boolean
  start?: string
  end?: string
  markers?: boolean
  scrub?: boolean | number
  scroller?: Element | Window | string
  vars?: Record<string, unknown>
  scrollTrigger?: Record<string, unknown>
}

export type ScrollRevealRunOptions = Omit<ScrollRevealOptions, 'target'>

type MotionRouteCleanup = {
  add(cleanup: () => void): () => boolean
  cleanup(): void
  readonly size: number
}

type ScrollRevealControls = {
  reveal(target?: unknown, overrides?: ScrollRevealRunOptions): unknown
  kill(): void
  refresh(): void
  tweens: Set<unknown>
}

type FsusUiMotionExports = {
  FsuMotion: Plugin
  FsuTransition: Component
  cancelMotion(el: HTMLElement): void
  runMotion(el: HTMLElement, options: MotionRunOptions): MotionRuntimeControls
  useMotionRouteCleanup(): MotionRouteCleanup
  useScrollReveal(defaults?: ScrollRevealOptions): ScrollRevealControls
  vMotion: Directive<HTMLElement, MotionDirectiveValue>
  vScrollReveal: Directive<HTMLElement, MotionDirectiveValue>
}

const {
  FsuMotion,
  FsuTransition,
  cancelMotion,
  runMotion,
  useMotionRouteCleanup,
  useScrollReveal,
  vMotion,
  vScrollReveal
} = FsusUi as unknown as FsusUiMotionExports

export type FsusBlogMotionSurface =
  | 'homeHero'
  | 'articleCards'
  | 'searchDialog'
  | 'mobileDrawer'
  | 'mobileBar'
  | 'toast'
  | 'articleTitle'
  | 'mediaOverlay'
  | 'backToTop'
  | 'tagChip'
  | 'route'
  | 'banner'

export const fsusBlogMotionPresets = {
  homeHero: 'fade-in',
  articleCards: 'fade-in',
  searchDialog: 'scale-fade',
  mobileDrawer: 'slide-right',
  mobileBar: 'slide-up',
  toast: 'slide-up',
  articleTitle: 'fade-in',
  mediaOverlay: 'scale-fade',
  backToTop: 'scale-fade',
  tagChip: 'fade-in',
  route: 'route-fade',
  banner: 'fade-down'
} as const satisfies Record<FsusBlogMotionSurface, MotionPresetName>

export const fsusBlogScrollRevealMotion = {
  name: 'fade-in',
  once: true
} as const satisfies MotionDirectiveValue

export const fsusBlogScrollRevealOptions = {
  name: 'fade-in',
  once: true,
  start: 'top 88%'
} as const satisfies ScrollRevealRunOptions

export {
  FsuMotion,
  FsuTransition,
  cancelMotion,
  runMotion,
  useMotionRouteCleanup,
  useScrollReveal,
  vMotion,
  vScrollReveal
}
