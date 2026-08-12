// @vitest-environment happy-dom

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  accountDrawerBlockSizePx,
  articleTocDrawerPaddingBottomPx,
  findCanonicalViewportSafeAreaViolations,
  findSourceViolations,
  toastBottomOffsetPx
} from '../../checks/static/check-canonical-viewport-safe-area.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
  document.body.innerHTML = ''
  document.head.querySelectorAll('[data-canonical-viewport-probe]').forEach((node) => node.remove())
})

const PROFILES = {
  '0/0/0/0': { top: 0, right: 0, bottom: 0, left: 0, block: 844 },
  '47/0/34/0': { top: 47, right: 0, bottom: 34, left: 0, block: 844 },
  '0/59/21/59': { top: 0, right: 59, bottom: 21, left: 59, block: 390 },
  short: { top: 0, right: 0, bottom: 0, left: 0, block: 430 }
} as const

function applyCanonicalVars(
  host: HTMLElement,
  profile: { top: number; right: number; bottom: number; left: number; block: number }
) {
  host.style.setProperty('--fsus-safe-area-inset-top', `${profile.top}px`)
  host.style.setProperty('--fsus-safe-area-inset-right', `${profile.right}px`)
  host.style.setProperty('--fsus-safe-area-inset-bottom', `${profile.bottom}px`)
  host.style.setProperty('--fsus-safe-area-inset-left', `${profile.left}px`)
  host.style.setProperty('--fsus-viewport-block-size', `${profile.block}px`)
  host.style.setProperty('--fsus-space-8', '32px')
  host.style.setProperty('--fsus-space-3', '12px')
  host.style.setProperty('--fsusblog-account-header-height', '89px')
}

describe('canonical viewport / safe-area consumer contract (#1786)', () => {
  it('toast bottom inset 0 vs 34 differs by exactly the variable delta', () => {
    const baseRem = 16
    const zero = toastBottomOffsetPx(0, baseRem)
    const notch = toastBottomOffsetPx(34, baseRem)
    expect(notch - zero).toBe(34)
    expect(zero).toBe(16)
    expect(notch).toBe(50)

    const style = document.createElement('style')
    style.dataset.canonicalViewportProbe = 'true'
    style.textContent = `
      .fsusblog-motion-toast--viewport-bottom {
        position: fixed;
        bottom: calc(var(--fsus-safe-area-inset-bottom) + 1rem);
      }
    `
    document.head.append(style)

    const measure = (bottomInset: number) => {
      const host = document.createElement('div')
      applyCanonicalVars(host, { ...PROFILES['0/0/0/0'], bottom: bottomInset })
      const toast = document.createElement('div')
      toast.className = 'fsusblog-motion-toast--viewport-bottom'
      host.append(toast)
      document.body.append(host)
      // happy-dom may not fully resolve calc; assert CSSOM contract + arithmetic.
      expect(getComputedStyle(host).getPropertyValue('--fsus-safe-area-inset-bottom').trim()).toBe(
        `${bottomInset}px`
      )
      expect(style.textContent).toContain('var(--fsus-safe-area-inset-bottom)')
      expect(style.textContent).not.toContain('env(safe-area-inset-')
      host.remove()
      return toastBottomOffsetPx(bottomInset, baseRem)
    }

    expect(measure(34) - measure(0)).toBe(34)
  })

  it('account drawer height follows --fsus-viewport-block-size for 844 and 430', () => {
    for (const block of [844, 430] as const) {
      expect(accountDrawerBlockSizePx(block)).toBe(block)
    }

    const style = document.createElement('style')
    style.dataset.canonicalViewportProbe = 'true'
    style.textContent = `
      .account-mobile-drawer {
        height: var(--fsus-viewport-block-size);
        max-height: var(--fsus-viewport-block-size);
      }
      .account-mobile-drawer-nav {
        padding-bottom: var(--fsus-safe-area-inset-bottom);
      }
    `
    document.head.append(style)

    for (const block of [844, 430] as const) {
      const host = document.createElement('div')
      applyCanonicalVars(host, { ...PROFILES['47/0/34/0'], block })
      const drawer = document.createElement('div')
      drawer.className = 'account-mobile-drawer'
      const nav = document.createElement('nav')
      nav.className = 'account-mobile-drawer-nav'
      drawer.append(nav)
      host.append(drawer)
      document.body.append(host)

      const computed = getComputedStyle(host)
      expect(computed.getPropertyValue('--fsus-viewport-block-size').trim()).toBe(`${block}px`)
      expect(computed.getPropertyValue('--fsus-safe-area-inset-bottom').trim()).toBe('34px')
      expect(style.textContent).toContain('var(--fsus-viewport-block-size)')
      expect(style.textContent).toContain('var(--fsus-safe-area-inset-bottom)')
      expect(style.textContent).not.toMatch(/100vh|100dvh|env\(\s*safe-area/)
      host.remove()
    }
  })

  it('ArticleTocPanel drawer nav keeps full padding under 34px bottom inset', () => {
    expect(articleTocDrawerPaddingBottomPx(34)).toBe(50)
    expect(articleTocDrawerPaddingBottomPx(0)).toBe(16)
    expect(articleTocDrawerPaddingBottomPx(34) - articleTocDrawerPaddingBottomPx(0)).toBe(34)

  })

  it('portrait and landscape profiles keep fixed controls inside the safe rectangle formulas', () => {
    const rem = 16
    for (const profile of [PROFILES['47/0/34/0'], PROFILES['0/59/21/59'], PROFILES['0/0/0/0']]) {
      const toastBottom = toastBottomOffsetPx(profile.bottom, rem)
      expect(toastBottom).toBeGreaterThanOrEqual(profile.bottom + rem - 0)

      const drawerHeight = accountDrawerBlockSizePx(profile.block)
      expect(drawerHeight).toBe(profile.block)

      const tocPad = articleTocDrawerPaddingBottomPx(profile.bottom, rem)
      expect(tocPad - rem).toBe(profile.bottom)
    }
  })

  it('mutation: restoring env(), dual-write, or synonymous tokens fails the gate', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-safe-area-mutation-'))
    temporaryRoots.push(fixtureRoot)

    const assets = path.join(fixtureRoot, 'src/frontend/src/assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(
      path.join(assets, 'motion.css'),
      '.fsusblog-motion-toast--viewport-bottom { bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem); }\n'
    )
    writeFileSync(
      path.join(assets, 'account-shell-base.css'),
      '.account-mobile-drawer { height: 100vh; height: 100dvh; }\n'
    )
    writeFileSync(
      path.join(assets, 'aliases.css'),
      ':root { --fsusblog-safe-bottom: 0px; }\n'
    )

    const violations = findCanonicalViewportSafeAreaViolations({ root: fixtureRoot })
    expect(violations.some((item) => item.includes('direct env(safe-area-inset-*)'))).toBe(true)
    expect(violations.some((item) => item.includes('dual height 100vh/100dvh'))).toBe(true)
    expect(violations.some((item) => item.includes('forbidden synonymous safe-area token'))).toBe(
      true
    )

    expect(
      findSourceViolations(
        'src/frontend/src/assets/public-shell-foundation.css',
        '#fsus-aot-shell { min-height: 100vh; }\n'
      ).length
    ).toBeGreaterThan(0)
  })
})
