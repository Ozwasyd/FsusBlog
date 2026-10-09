export {
    ElCollapseTransition,
    FsuMobileDock,
    FsuMotion,
    FsuTransition,
    runMotion,
    useMotionRouteCleanup,
    useScrollReveal,
    vMotion,
    vScrollReveal
} from '@ozwasyd/element-plus';

export type {
    MotionDirectiveValue,
    MotionPresetName,
    ScrollRevealRunOptions
} from '@ozwasyd/element-plus';

import type {
    MotionDirectiveValue,
    MotionPresetName,
    ScrollRevealRunOptions
} from '@ozwasyd/element-plus';

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
  | 'identityRoute'
  | 'banner';

export const fsusBlogMotionPresets = {
    // Use FsusUI's documented alias targets to preserve the existing effects;
    // selecting a different surface preset would also change runtime behavior.
    homeHero: 'surface-settle',
    articleCards: 'surface-settle',
    searchDialog: 'dialog-settle',
    mobileDrawer: 'sheet-settle',
    mobileBar: 'sheet-settle',
    toast: 'sheet-settle',
    articleTitle: 'surface-settle',
    mediaOverlay: 'dialog-settle',
    backToTop: 'dialog-settle',
    tagChip: 'surface-settle',
    // FsusUI's route-settle preset currently emits empty `filter` keyframes,
    // which Firefox rejects. The ownership-transfer preset is route-governed,
    // opacity-only, and preserves the same short atomic handoff semantics.
    route: 'ownership-transfer-snapshot',
    identityRoute: 'ownership-transfer-snapshot',
    banner: 'paper-settle'
} as const satisfies Record<FsusBlogMotionSurface, MotionPresetName>;

export const fsusBlogScrollRevealMotion = {
    name: 'surface-settle',
    once: true
} as const satisfies MotionDirectiveValue;

export const fsusBlogScrollRevealOptions = {
    name: 'surface-settle',
    once: true,
    start: 'top 88%'
} as const satisfies ScrollRevealRunOptions;
