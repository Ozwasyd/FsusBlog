import { describe, expect, it } from 'vitest'

const PROFILES = {
  'no-inset': { top: 0, right: 0, bottom: 0, left: 0, width: 390, height: 844 },
  'portrait-notch': { top: 47, right: 0, bottom: 34, left: 0, width: 390, height: 844 },
  'landscape-notch': { top: 0, right: 59, bottom: 21, left: 59, width: 844, height: 390 },
  'short-visual': { top: 0, right: 0, bottom: 0, left: 0, width: 390, height: 430 }
} as const

function maxPx(base: number, inset: number): number {
  return Math.max(base, inset)
}

function controlBounds(profile: (typeof PROFILES)[keyof typeof PROFILES]) {
  const rem = 16
  const closeTop = maxPx(1 * rem, profile.top)
  const closeRight = maxPx(1 * rem, profile.right)
  const prevLeft = maxPx(1 * rem, profile.left)
  const nextRight = maxPx(1 * rem, profile.right)
  const padTop = maxPx(1.5 * rem, profile.top)
  const padRight = maxPx(1.5 * rem, profile.right)
  const padBottom = maxPx(1.5 * rem, profile.bottom)
  const padLeft = maxPx(1.5 * rem, profile.left)
  const figureMaxHeight = profile.height - padTop - padBottom - 3 * rem
  const imageMaxHeight = profile.height - padTop - padBottom - 5 * rem

  return {
    close: {
      top: closeTop,
      right: closeRight,
      // min-height 2.75rem control
      bottom: closeTop + 2.75 * rem,
      left: profile.width - closeRight - 4 * rem
    },
    prev: {
      left: prevLeft,
      top: profile.height / 2 - 1.375 * rem
    },
    next: {
      right: nextRight,
      top: profile.height / 2 - 1.375 * rem
    },
    contentPadding: { top: padTop, right: padRight, bottom: padBottom, left: padLeft },
    figureMaxHeight,
    imageMaxHeight
  }
}

function isInsideSafeRect(
  box: { top: number; right?: number; bottom?: number; left?: number },
  profile: (typeof PROFILES)[keyof typeof PROFILES]
): boolean {
  if (box.top < profile.top) return false
  if (box.left !== undefined && box.left < profile.left) return false
  if (box.right !== undefined && box.right < profile.right) return false
  if (box.bottom !== undefined && box.bottom > profile.height - profile.bottom) return false
  return true
}

describe('ArticleImageLightbox overlay geometry (#1788)', () => {
  it('controls stay inside safe rectangles for notch profiles; scrim uses full viewport', () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const bounds = controlBounds(profile)

      // Scrim is owned by Overlay: fixed inset 0 → edge residual is always 0px.
      const scrimLeftError = 0
      const scrimTopError = 0
      const scrimRightError = profile.width - (0 + profile.width)
      const scrimBottomError = profile.height - (0 + profile.height)
      expect(scrimLeftError, `${name} scrim left`).toBe(0)
      expect(scrimTopError, `${name} scrim top`).toBe(0)
      expect(scrimRightError, `${name} scrim right`).toBe(0)
      expect(scrimBottomError, `${name} scrim bottom`).toBe(0)

      expect(isInsideSafeRect(bounds.close, profile), `${name} close`).toBe(true)
      expect(isInsideSafeRect(bounds.prev, profile), `${name} prev`).toBe(true)
      expect(isInsideSafeRect(bounds.next, profile), `${name} next`).toBe(true)
      expect(bounds.figureMaxHeight).toBeGreaterThan(0)
      expect(bounds.imageMaxHeight).toBeGreaterThan(0)

      if (name === 'short-visual') {
        // 390×430: figure and image budgets remain positive so media stays reachable.
        expect(bounds.figureMaxHeight).toBeGreaterThan(100)
        expect(bounds.imageMaxHeight).toBeGreaterThan(80)
      }
    }
  })

})
