import {
  FsuMotion,
  FsuTransition,
  cancelMotion,
  runMotion,
  useMotionRouteCleanup,
  useScrollReveal,
  vMotion,
  vScrollReveal,
  type MotionDirectiveValue,
  type MotionPhase,
  type MotionPresetName,
  type MotionRuntimeControls,
  type ScrollRevealOptions,
  type ScrollRevealRunOptions
} from '@ozwasyd/element-plus'

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
  | 'route'
  | 'banner'

export const fsusBlogMotionPresets = {
  homeHero: 'fade-up',
  articleCards: 'list-stagger',
  searchDialog: 'scale-fade',
  mobileDrawer: 'slide-right',
  mobileBar: 'slide-up',
  toast: 'slide-up',
  articleTitle: 'fade-up',
  mediaOverlay: 'scale-fade',
  backToTop: 'scale-fade',
  route: 'route-fade',
  banner: 'fade-down'
} as const satisfies Record<FsusBlogMotionSurface, MotionPresetName>

export const fsusBlogScrollRevealMotion = {
  name: 'fade-up',
  once: true
} as const satisfies MotionDirectiveValue

export const fsusBlogScrollRevealOptions = {
  name: 'fade-up',
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

export type {
  MotionDirectiveValue,
  MotionPhase,
  MotionPresetName,
  MotionRuntimeControls,
  ScrollRevealOptions,
  ScrollRevealRunOptions
}
