import { afterEach, describe, expect, it } from 'vitest'

import {
  captureHydrationIdentity,
  verifyHydrationIdentity
} from '@/public-renderers/hydrationIdentityGuard'
import type { PublicHydrationPayload } from '@/public-renderers/types'

function basePayload(overrides: Partial<PublicHydrationPayload> = {}): PublicHydrationPayload {
  return {
    pageKind: 'Home',
    routeKey: 'home',
    siteTitle: 'FsusBlog',
    siteDescription: 'desc',
    rendererVersion: 'test',
    renderLocale: 'zh-CN',
    renderTimestamp: '2026-01-01T00:00:00.000Z',
    featuredArticles: [],
    hotArticles: [],
    ...overrides
  } as PublicHydrationPayload
}

function mountShell(options?: {
  pageKind?: string
  extraSibling?: boolean
  shellTag?: string
}): { app: HTMLElement, shell: HTMLElement } {
  document.body.innerHTML = ''
  const app = document.createElement('div')
  app.id = 'app'
  const shell = document.createElement(options?.shellTag ?? 'div')
  shell.id = 'fsus-aot-shell'
  shell.dataset.publicHydrationKind = options?.pageKind ?? 'Home'
  shell.textContent = 'AOT shell'
  app.appendChild(shell)
  if (options?.extraSibling) {
    const sibling = document.createElement('div')
    sibling.id = 'extra'
    app.appendChild(sibling)
  }
  document.body.appendChild(app)
  return { app, shell }
}

describe('hydrationIdentityGuard fail-closed reverse samples', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('accepts an unchanged shell identity after capture', () => {
    const { app, shell } = mountShell()
    const payload = basePayload()
    const guard = captureHydrationIdentity(app, shell, payload)

    expect(() => verifyHydrationIdentity({
      appSelector: '#app',
      shellSelector: '#fsus-aot-shell',
      payload,
      guard
    })).not.toThrow()
  })

  it('fails when routeKey/pageKind identity drifts (reverse sample 7)', () => {
    const { app, shell } = mountShell()
    const guard = captureHydrationIdentity(app, shell, basePayload({ pageKind: 'Home', routeKey: 'home' }))

    expect(() => verifyHydrationIdentity({
      appSelector: '#app',
      shellSelector: '#fsus-aot-shell',
      payload: basePayload({ pageKind: 'About', routeKey: 'about' }),
      guard
    })).toThrow(/route identity mismatch/u)
  })

  it('fails when shell remount replaces the element path', () => {
    const { app, shell } = mountShell()
    const payload = basePayload()
    const guard = captureHydrationIdentity(app, shell, payload)
    const replacement = shell.cloneNode(true) as HTMLElement
    shell.replaceWith(replacement)

    expect(() => verifyHydrationIdentity({
      appSelector: '#app',
      shellSelector: '#fsus-aot-shell',
      payload,
      guard
    })).toThrow(/shell remount detected/u)
  })

  it('fails when #app child count changes (reverse sample: control structure / missing nav)', () => {
    const { app, shell } = mountShell()
    const payload = basePayload()
    const guard = captureHydrationIdentity(app, shell, payload)
    const sibling = document.createElement('button')
    sibling.textContent = 'extra'
    app.appendChild(sibling)

    expect(() => verifyHydrationIdentity({
      appSelector: '#app',
      shellSelector: '#fsus-aot-shell',
      payload,
      guard
    })).toThrow(/#app subtree rebuilt/u)
  })

  it('fails when shell pageKind attribute diverges from payload', () => {
    const { app, shell } = mountShell({ pageKind: 'Home' })
    const payload = basePayload({ pageKind: 'Home', routeKey: 'home' })
    const guard = captureHydrationIdentity(app, shell, payload)
    shell.dataset.publicHydrationKind = 'Archive'

    expect(() => verifyHydrationIdentity({
      appSelector: '#app',
      shellSelector: '#fsus-aot-shell',
      payload,
      guard
    })).toThrow(/pageKind mismatch/u)
  })

  it('records a stable DOM path summary on subtree rebuild', () => {
    const { app, shell } = mountShell()
    const payload = basePayload()
    const guard = captureHydrationIdentity(app, shell, payload)
    app.appendChild(document.createElement('span'))

    try {
      verifyHydrationIdentity({
        appSelector: '#app',
        shellSelector: '#fsus-aot-shell',
        payload,
        guard
      })
      throw new Error('expected verifyHydrationIdentity to throw')
    } catch (error) {
      expect(String(error)).toMatch(/path=#app/u)
    }
  })
})
