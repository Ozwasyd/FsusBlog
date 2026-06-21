import type { MotionPresetName, MotionDirectiveValue, ScrollRevealRunOptions } from '@ozwasyd/element-plus/motion'

// Blog-specific motion surface mappings.
//
// FsusUI owns the motion runtime (plugin, directives, composables, presets,
// types). This file only carries the Blog's intent → preset mapping that
// downstream components reuse, so we don't re-export any FsusUI runtime API
// from `@/fsusui`. For `FsuMotion`, `vMotion`, `useScrollReveal`, `runMotion`,
// types etc. import directly from `@ozwasyd/element-plus/motion`.

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