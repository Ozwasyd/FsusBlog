import { computed } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function getPrefersReducedMotion(fallback = false): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : fallback
}

export function resolveMotionScrollBehavior(
  prefersReducedMotion = getPrefersReducedMotion(),
  preferred: ScrollBehavior = 'smooth'
): ScrollBehavior {
  return prefersReducedMotion ? 'auto' : preferred
}

export function useMotionPreference() {
  const prefersReducedMotion = useMediaQuery(REDUCED_MOTION_QUERY, false)
  const motionEnabled = computed(() => !prefersReducedMotion.value)

  const resolveScrollBehavior = (preferred: ScrollBehavior = 'smooth'): ScrollBehavior =>
    resolveMotionScrollBehavior(prefersReducedMotion.value, preferred)

  return {
    prefersReducedMotion,
    motionEnabled,
    resolveScrollBehavior
  }
}
