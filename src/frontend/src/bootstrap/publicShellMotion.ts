import { getPrefersReducedMotion } from '@/composables/useMotionPreference'
import {
  fsusBlogMotionPresets,
  runMotion,
  type MotionRuntimeControls
} from '@/fsusui/motion'

let activePublicRouteSettleMotion: MotionRuntimeControls | null = null

export function cancelPublicRouteSettleMotion(): void {
  activePublicRouteSettleMotion?.cancel()
  activePublicRouteSettleMotion = null
}

export function resolvePublicRouteSettleTarget(shell: HTMLElement): HTMLElement | null {
  return shell.querySelector<HTMLElement>('#main-content, main')
}

export function settlePublicNavigationMotionForShell(shell: HTMLElement): MotionRuntimeControls | null {
  cancelPublicRouteSettleMotion()

  if (getPrefersReducedMotion() || document.body.hasAttribute('data-fsusblog-public-first-paint')) {
    return null
  }

  const target = resolvePublicRouteSettleTarget(shell)
  if (!target) {
    return null
  }

  let controls: MotionRuntimeControls | null = null
  const clearActive = (): void => {
    if (activePublicRouteSettleMotion === controls) {
      activePublicRouteSettleMotion = null
    }
  }

  controls = runMotion(target, {
    name: fsusBlogMotionPresets.route,
    phase: 'enter',
    onFinish: clearActive
  })
  activePublicRouteSettleMotion = controls
  return controls
}
