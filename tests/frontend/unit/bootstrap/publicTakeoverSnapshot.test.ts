import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('public takeover snapshot overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <section id="fsus-aot-shell" data-public-hydration-kind="Home">
          <header>AOT content</header>
          <main>Visible public shell</main>
        </section>
      </div>
    `
    Object.defineProperty(window, 'scrollY', { value: 128, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.head.querySelectorAll('[data-fsus-csp-runtime-style]').forEach((node) => node.remove())
  })

  it('clones the visible public shell into an inert fixed overlay aligned to scroll', async () => {
    const { createPublicTakeoverSnapshot } = await import('@/bootstrap/publicTakeoverSnapshot')

    const originalShell = document.getElementById('fsus-aot-shell')
    const snapshot = createPublicTakeoverSnapshot()

    expect(snapshot).not.toBeNull()
    expect(snapshot?.element.parentElement).toBe(document.body)
    expect(snapshot?.element.getAttribute('aria-hidden')).toBe('true')
    expect(snapshot?.element.hasAttribute('inert')).toBe(true)
    expect(snapshot?.element.classList.contains('fsus-public-takeover-snapshot')).toBe(true)
    expect(snapshot?.element.hasAttribute('style')).toBe(false)
    const overlayRule = document.head.querySelector<HTMLStyleElement>(
      '[data-fsus-csp-runtime-style="public-takeover-overlay"]'
    )?.sheet?.cssRules[0] as CSSStyleRule | undefined
    expect(overlayRule?.style.zIndex).toBe('2147483000')

    const clone = snapshot?.element.querySelector<HTMLElement>('[data-public-takeover-snapshot-clone="true"]')
    expect(clone).not.toBeNull()
    expect(clone).not.toBe(originalShell)
    expect(clone?.textContent).toContain('Visible public shell')
    expect(clone?.classList.contains('fsus-public-takeover-snapshot__clone')).toBe(true)
    expect(clone?.hasAttribute('style')).toBe(false)
    const cloneRule = document.head.querySelector<HTMLStyleElement>(
      '[data-fsus-csp-runtime-style="public-takeover-clone"]'
    )?.sheet?.cssRules[0] as CSSStyleRule | undefined
    expect(cloneRule?.style.transform).toBe('translate3d(0, -128px, 0)')
    snapshot?.remove()
  })

  it('reveals immediately under reduced motion without requiring animation', async () => {
    const { createPublicTakeoverSnapshot } = await import('@/bootstrap/publicTakeoverSnapshot')

    const snapshot = createPublicTakeoverSnapshot({ reducedMotion: true })
    expect(snapshot).not.toBeNull()

    await snapshot?.reveal()

    expect(snapshot?.element.isConnected).toBe(false)
    expect(snapshot?.element.hasAttribute('style')).toBe(false)
    expect(document.head.querySelector('[data-fsus-csp-runtime-style="public-takeover-overlay"]')).toBeNull()
  })
})
