import {
  ElPublicShell,
  type PublicShellMobileNavMode,
} from '@ozwasyd/element-plus'
import type { Component } from 'vue'

/** Consumer boundary for the alias-resolved FsusUI PublicShell contract. */
export const FsusUiPublicShell = ElPublicShell as Component

export const FSUSUI_PUBLIC_SHELL_MOBILE_NAV_MODES = [
  'inline',
  'menu',
  'bottom',
  'none'
] as const satisfies readonly PublicShellMobileNavMode[]

export type FsusUiPublicShellMobileNavMode = PublicShellMobileNavMode

export const FSUSBLOG_PUBLIC_MOBILE_NAV_MODE = 'menu' satisfies FsusUiPublicShellMobileNavMode
