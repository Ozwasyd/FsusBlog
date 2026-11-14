// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PUBLIC_BOOT_FAILURE_STORAGE_KEY,
  consumePublicBootHandoff,
  failClosedPublicBootNavigation
} from '@/bootstrap/publicBootHandoff'

const entryUrl = '/assets/fsus-spa-entry.js'
const buildIdentity = 'local-unversioned'
const corePreload = '/assets/entry-runtime.js'
const takeoverStylesheet = '/assets/full-app.css'

type IdleCallback = (deadline: IdleDeadline) => void
type KernelModule = typeof import('@/bootstrap/publicBootKernel')

let idleCallback: IdleCallback | null
let animationFrameCallback: FrameRequestCallback | null
let kernelModule: KernelModule | null
let timerCallbacks: Map<number, () => void>
let nextTimerId: number

function installConfig(overrides: Record<string, unknown> = {}): void {
  document.body.innerHTML = `<main id="fsus-aot-shell">Readable article</main><script id="fsus-public-boot-config" type="application/json">${JSON.stringify({
    schema: 'fsusblog.public-boot-config.v1',
    frontendBuildIdentity: buildIdentity,
    entryUrl,
    coreModulePreloads: [corePreload],
    takeoverStylesheets: [takeoverStylesheet],
    ...overrides
  })}</script>`
}

async function boot(): Promise<void> {
  kernelModule = await import('@/bootstrap/publicBootKernel')
  animationFrameCallback?.(0)
}

function entryScripts(): NodeListOf<HTMLScriptElement> {
  return document.querySelectorAll<HTMLScriptElement>('script[data-fsusblog-spa-entry]')
}

function dispatchIntent(type: 'pointerdown' | 'touchstart' | 'keydown' | 'scroll'): void {
  window.dispatchEvent(new Event(type))
}

describe('public boot kernel browser scheduling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    kernelModule = null
    idleCallback = null
    animationFrameCallback = null
    timerCallbacks = new Map()
    nextTimerId = 100
    sessionStorage.clear()
    document.documentElement.removeAttribute('data-fsusblog-public-boot-failed')
    window.history.replaceState({}, '', '/article/boot-kernel')
    installConfig()
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' })
    Object.defineProperty(window, 'trustedTypes', { configurable: true, value: undefined })
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallback = callback
        return 23
      })
    })
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: IdleCallback) => {
        idleCallback = callback
        return 17
      })
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })
    Object.defineProperty(window, 'setTimeout', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        const id = nextTimerId++
        timerCallbacks.set(id, callback)
        return id
      })
    })
    Object.defineProperty(window, 'clearTimeout', {
      configurable: true,
      value: vi.fn((id: number) => timerCallbacks.delete(id))
    })
  })

  afterEach(() => {
    kernelModule?.disposePublicBootKernel()
    vi.useRealTimers()
  })

  it('preempts queued idle work in the pointerdown task', async () => {
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' })
    kernelModule = await import('@/bootstrap/publicBootKernel')
    expect(animationFrameCallback).toBeNull()

    document.dispatchEvent(new Event('DOMContentLoaded'))
    animationFrameCallback?.(0)

    dispatchIntent('pointerdown')

    expect(window.cancelIdleCallback).toHaveBeenCalledWith(17)
    expect(entryScripts(), document.documentElement.outerHTML).toHaveLength(1)
    const handoff = document.getElementById('fsus-public-boot-handoff')
    expect(handoff?.tagName).toBe('DIV')
    expect(handoff).toBeInstanceOf(HTMLDivElement)
    expect((handoff as HTMLDivElement).hidden).toBe(true)
    expect(handoff?.textContent).toContain('pointerdown')
    expect(consumePublicBootHandoff(buildIdentity)?.intent?.type).toBe('pointerdown')
    expect(timerCallbacks.size).toBe(0)
  })

  it('cancels the 96ms low-budget fallback when pointerdown arrives', async () => {
    await boot()
    idleCallback?.({ didTimeout: false, timeRemaining: () => 2 } as IdleDeadline)
    expect(timerCallbacks.size).toBe(2)

    dispatchIntent('pointerdown')

    expect(entryScripts()).toHaveLength(1)
    expect(timerCallbacks.size).toBe(0)
    expect(entryScripts()).toHaveLength(1)
  })

  it('cancels the forced 1800ms timer when pointerdown arrives', async () => {
    await boot()
    expect(timerCallbacks.size).toBe(1)

    dispatchIntent('pointerdown')

    expect(timerCallbacks.size).toBe(0)
    expect(entryScripts()).toHaveLength(1)
  })

  it('coalesces pointerdown followed by click into one entry request', async () => {
    await boot()

    dispatchIntent('pointerdown')
    window.dispatchEvent(new Event('click'))

    expect(entryScripts()).toHaveLength(1)
  })

  it('coalesces touchstart followed by a synthetic click into one entry request', async () => {
    await boot()

    dispatchIntent('touchstart')
    window.dispatchEvent(new Event('click'))

    expect(entryScripts()).toHaveLength(1)
    expect(document.getElementById('fsus-public-boot-handoff')?.textContent).toContain('touchstart')
  })

  it('entry failure removes transient state and performs at most one same-build navigation', async () => {
    await boot()
    dispatchIntent('keydown')
    const script = entryScripts()[0]

    script.dispatchEvent(new Event('error'))

    expect(entryScripts()).toHaveLength(0)
    expect(document.getElementById('fsus-public-boot-handoff')).toBeNull()
    expect(document.getElementById('fsus-public-boot-config')).toBeNull()
    expect(sessionStorage.getItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY)).toBe(buildIdentity)
    const navigate = vi.fn()
    expect(failClosedPublicBootNavigation(buildIdentity, navigate)).toBe('sealed')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('one handoff carrier can be consumed only once', () => {
    document.body.innerHTML = `<div id="fsus-public-boot-handoff" hidden>${JSON.stringify({
      schema: 'fsusblog.public-boot-handoff.v1',
      frontendBuildIdentity: buildIdentity,
      intent: { type: 'scroll', timestamp: 42 }
    })}</div>`

    expect(consumePublicBootHandoff(buildIdentity)?.intent?.type).toBe('scroll')
    expect(document.getElementById('fsus-public-boot-handoff')).toBeNull()
    expect(consumePublicBootHandoff(buildIdentity)).toBeNull()
  })

  it('rejects carriers that are executable or not hidden', () => {
    for (const markup of [
      `<script id="fsus-public-boot-handoff" type="application/json">${JSON.stringify({
        schema: 'fsusblog.public-boot-handoff.v1',
        frontendBuildIdentity: buildIdentity,
        intent: null
      })}</script>`,
      `<div id="fsus-public-boot-handoff">${JSON.stringify({
        schema: 'fsusblog.public-boot-handoff.v1',
        frontendBuildIdentity: buildIdentity,
        intent: null
      })}</div>`
    ]) {
      document.body.innerHTML = markup
      expect(consumePublicBootHandoff(buildIdentity)).toBeNull()
      expect(document.getElementById('fsus-public-boot-handoff')).toBeNull()
    }
  })

  it('destroys schema and build mismatched handoffs without adopting them', () => {
    for (const handoff of [
      { schema: 'fsusblog.public-boot-handoff.v0', frontendBuildIdentity: buildIdentity, intent: null },
      { schema: 'fsusblog.public-boot-handoff.v1', frontendBuildIdentity: 'other-build', intent: null }
    ]) {
      document.body.innerHTML = `<div id="fsus-public-boot-handoff" hidden>${JSON.stringify(handoff)}</div>`
      expect(consumePublicBootHandoff(buildIdentity)).toBeNull()
      expect(document.getElementById('fsus-public-boot-handoff')).toBeNull()
    }
  })

  it('allows one document navigation for a mismatched build and seals a repeat loop', () => {
    const navigate = vi.fn()

    expect(failClosedPublicBootNavigation('mismatched-build', navigate)).toBe('navigated')
    expect(failClosedPublicBootNavigation('mismatched-build', navigate)).toBe('sealed')

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset.fsusblogPublicBootFailed).toBe('true')
  })

  it('keeps silent warming loader-free until idle work runs', async () => {
    await boot()

    expect(entryScripts()).toHaveLength(0)
    expect(document.getElementById('global-loader')).toBeNull()
    expect(document.getElementById('fsus-aot-shell')?.textContent).toContain('Readable article')

    idleCallback?.({ didTimeout: false, timeRemaining: () => 16 } as IdleDeadline)

    expect(entryScripts()).toHaveLength(1)
    expect(document.getElementById('global-loader')).toBeNull()
    expect(document.getElementById('fsus-aot-shell')?.textContent).toContain('Readable article')
  })

  it.each(['pointerdown', 'touchstart', 'keydown', 'scroll'] as const)(
    '%s starts one foreground injection and removes all intent listeners',
    async (type) => {
      const removeListener = vi.spyOn(window, 'removeEventListener')
      await boot()

      dispatchIntent(type)
      dispatchIntent(type)

      expect(entryScripts()).toHaveLength(1)
      for (const intentType of ['pointerdown', 'touchstart', 'keydown', 'scroll']) {
        expect(removeListener).toHaveBeenCalledWith(intentType, expect.any(Function))
      }
    }
  )

  it('promotes only entry and declared core resources, not unrelated routes', async () => {
    installConfig({
      coreModulePreloads: [corePreload, '/assets/public-page-runtime.js'],
      takeoverStylesheets: [takeoverStylesheet]
    })
    await boot()

    dispatchIntent('scroll')

    const preloads = [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')]
    expect(preloads.map((link) => new URL(link.href).pathname)).toEqual([
      entryUrl,
      corePreload,
      '/assets/public-page-runtime.js'
    ])
    expect(preloads.every((link) => link.fetchPriority === 'high')).toBe(true)
    expect(document.documentElement.innerHTML).not.toMatch(/admin|echarts|editor|notification/iu)
  })

  it('does not create a second script when the current-build entry already exists', async () => {
    const existing = document.createElement('script')
    existing.type = 'module'
    existing.src = entryUrl
    existing.dataset.fsusblogFrontendBuildIdentity = buildIdentity
    document.body.appendChild(existing)
    await boot()

    dispatchIntent('pointerdown')

    expect(document.querySelectorAll(`script[type="module"][src="${entryUrl}"]`)).toHaveLength(1)
    expect(document.getElementById('fsus-public-boot-config')).toBeNull()
    expect(timerCallbacks.size).toBe(0)
  })

  it.each([
    { entryUrl: 'https://attacker.invalid/entry.js' },
    { entryUrl: 'https://user:secret@localhost/assets/entry.js' },
    { coreModulePreloads: [corePreload, 42] },
    { coreModulePreloads: [corePreload, corePreload] },
    { coreModulePreloads: [entryUrl] },
    { coreModulePreloads: [new URL(entryUrl, window.location.href).href] },
    { takeoverStylesheets: ['javascript:alert(1)'] },
    { takeoverStylesheets: [corePreload] }
  ])('rejects malformed or cross-origin config items: %j', async (overrides) => {
    installConfig(overrides)

    await boot()

    expect(entryScripts()).toHaveLength(0)
    expect(document.getElementById('fsus-public-boot-config')).toBeNull()
    expect(sessionStorage.getItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY)).toBe('invalid-public-boot-config')
  })

  it('fails closed and cleans up when Trusted Types rejects policy creation', async () => {
    Object.defineProperty(window, 'trustedTypes', {
      configurable: true,
      value: { createPolicy: vi.fn(() => { throw new TypeError('blocked') }) }
    })

    await boot()
    dispatchIntent('pointerdown')

    expect(entryScripts()).toHaveLength(0)
    expect(document.getElementById('fsus-public-boot-config')).toBeNull()
    expect(timerCallbacks.size).toBe(0)
  })

  it('creates the CSP-authorized SPA entry Trusted Types policy', async () => {
    const createPolicy = vi.fn((_name: string, rules: { createScriptURL(value: string): string }) => rules)
    Object.defineProperty(window, 'trustedTypes', {
      configurable: true,
      value: { createPolicy }
    })

    await boot()
    dispatchIntent('pointerdown')

    expect(createPolicy).toHaveBeenCalledWith('fsusblog-spa-entry', expect.any(Object))
    expect(entryScripts()).toHaveLength(1)
  })

  it('fails closed for an existing entry whose build identity is absent or stale', async () => {
    const existing = document.createElement('script')
    existing.type = 'module'
    existing.src = entryUrl
    document.body.appendChild(existing)
    await boot()

    dispatchIntent('pointerdown')

    expect(document.querySelectorAll(`script[type="module"][src="${entryUrl}"]`)).toHaveLength(1)
    expect(document.getElementById('fsus-public-boot-config')).toBeNull()
    expect(sessionStorage.getItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY)).toBe(buildIdentity)
    expect(timerCallbacks.size).toBe(0)
  })

  it('fails closed and removes the entry when CSP rejects its script URL', async () => {
    await boot()
    dispatchIntent('pointerdown')
    const violation = new Event('securitypolicyviolation')
    Object.defineProperties(violation, {
      effectiveDirective: { value: 'script-src-elem' },
      blockedURI: { value: new URL(entryUrl, window.location.href).href }
    })

    window.dispatchEvent(violation)

    expect(entryScripts()).toHaveLength(0)
    expect(document.getElementById('fsus-public-boot-handoff')).toBeNull()
    expect(timerCallbacks.size).toBe(0)
  })
})
