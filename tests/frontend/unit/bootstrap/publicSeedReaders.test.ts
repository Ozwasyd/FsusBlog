// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { PUBLIC_AOT_HYDRATION_MEDIA_TYPE } from '@/api/contracts'
import { articleRightsFixture } from '../fixtures/articleRights'

type PublicSeedWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__?: string | null
  __FSUS_PUBLIC_HYDRATION_RAW__?: string | null
}

function setCurrentUrl(url: string): void {
  window.location.href = url
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

describe('public seed readers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setCurrentUrl('http://127.0.0.1:7568/article/1')
    ;(window as PublicSeedWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = null
    ;(window as PublicSeedWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = null
  })

  afterEach(() => {
    document.body.innerHTML = ''
    ;(window as PublicSeedWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = null
    ;(window as PublicSeedWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = null
  })

  it('consumes legacy bootstrap payloads without explicit path or query', async () => {
    vi.resetModules()

    const rawPayload = encodePublicAotPayload({
      kind: 'ArticleDetail',
      pageKind: 'ArticleDetail',
      routeKey: 'article:1',
      article: {
        id: 1,
        title: 'Hydration-safe bootstrap',
        summary: 'summary',
        views: 42,
        createTime: '2026-05-11T00:00:00Z',
        rights: articleRightsFixture
      }
    })

    const script = document.createElement('script')
    script.id = 'fsus-aot-bootstrap'
    script.type = 'application/octet-stream'
    script.textContent = rawPayload
    document.body.appendChild(script)

    const { consumePublicAotBootstrap } = await import('@/bootstrap/publicAotBootstrap')
    const payload = consumePublicAotBootstrap('ArticleDetail')

    expect(payload).not.toBeNull()
    expect(payload?.routeKey).toBe('article:1')
    expect(payload?.article?.id).toBe(1)
  })

  it('consumes the bootstrap payload once and clears stale script/window cache', async () => {
    vi.resetModules()

    const rawPayload = encodePublicAotPayload({
      kind: 'ArticleDetail',
      pageKind: 'ArticleDetail',
      routeKey: 'article:1',
      article: {
        id: 1,
        title: 'Single-use bootstrap',
        summary: 'summary',
        views: 42,
        createTime: '2026-05-11T00:00:00Z',
        rights: articleRightsFixture
      }
    })

    const script = document.createElement('script')
    script.id = 'fsus-aot-bootstrap'
    script.type = 'application/octet-stream'
    script.textContent = rawPayload
    document.body.appendChild(script)
    ;(window as PublicSeedWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = rawPayload

    const { consumePublicAotBootstrap } = await import('@/bootstrap/publicAotBootstrap')
    const first = consumePublicAotBootstrap('ArticleDetail')
    const second = consumePublicAotBootstrap('ArticleDetail')

    expect(first?.article?.title).toBe('Single-use bootstrap')
    expect(second).toBeNull()
    expect(document.getElementById('fsus-aot-bootstrap')).toBeNull()
    expect((window as PublicSeedWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__).toBeNull()
  })

  it('falls back to the boot-time hydration snapshot when the DOM script is unavailable', async () => {
    vi.resetModules()

    ;(window as PublicSeedWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = encodePublicAotPayload({
      pageKind: 'ArticleDetail',
      routeKey: 'article:1',
      rendererVersion: 'test-renderer',
      title: 'Hydration snapshot',
      articleId: 1,
      rights: articleRightsFixture,
      detailView: {
        rights: articleRightsFixture
      },
      commentsIsland: {
        articleId: 1
      }
    })

    const { readPublicHydrationPayload } = await import('@/bootstrap/publicHydrationBootstrap')
    const payload = readPublicHydrationPayload()

    expect(payload).not.toBeNull()
    expect(payload?.pageKind).toBe('ArticleDetail')
    expect(payload?.routeKey).toBe('article:1')
  })

  it('resolves global loader identity from the hydration seed before stale bootstrap data', async () => {
    vi.resetModules()

    document.body.innerHTML = `
      <div id="global-loader" hidden aria-hidden="true">
        <span data-fsus-loader-title></span>
        <span data-fsus-loader-status>正在加载</span>
      </div>
    `

    const bootstrap = document.createElement('script')
    bootstrap.id = 'fsus-aot-bootstrap'
    bootstrap.type = 'application/octet-stream'
    bootstrap.textContent = encodePublicAotPayload({
      kind: 'About',
      pageKind: 'About',
      routeKey: 'about',
      siteTitle: 'Stale Bootstrap Blog'
    })
    document.body.appendChild(bootstrap)

    const hydration = document.createElement('script')
    hydration.id = 'fsus-aot-hydration-props'
    hydration.type = 'application/octet-stream'
    hydration.textContent = encodePublicAotPayload({
      pageKind: 'About',
      routeKey: 'about',
      rendererVersion: 'test-renderer',
      title: '关于',
      siteTitle: 'Hydration Blog',
      siteDescription: 'Hydration description'
    })
    document.body.appendChild(hydration)

    document.documentElement.lang = 'zh-CN'
    document.body.insertAdjacentHTML('afterbegin', '<div id="app"></div>')
    const { showGlobalLoader, removeGlobalLoader, markGlobalLoaderBusy } = await import('@/bootstrap/publicShellPrimitives')
    markGlobalLoaderBusy()
    expect(document.getElementById('app')?.getAttribute('aria-busy')).toBe('true')
    expect((document.getElementById('global-loader') as HTMLElement | null)?.hidden).toBe(true)

    showGlobalLoader()

    const loader = document.getElementById('global-loader') as HTMLElement
    const status = document.querySelector('[data-fsus-loader-status]') as HTMLElement
    expect(document.title).toBe('Hydration Blog')
    expect(document.querySelector('[data-fsus-loader-title]')?.textContent).toBe('Hydration Blog')
    expect(status.textContent).toBe('正在加载 Hydration Blog')
    expect(status.dataset.localeKey).toBe('common.loading.statusWithSite')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(loader.hidden).toBe(false)
    expect(loader.getAttribute('aria-hidden')).toBe('false')
    expect(document.getElementById('app')?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toBe('Hydration description')

    removeGlobalLoader()
    expect(loader.hidden).toBe(true)
    expect(loader.getAttribute('aria-hidden')).toBe('true')
    expect(document.getElementById('app')?.hasAttribute('aria-busy')).toBe(false)
  })

  it('reuses the binary hydration script and cached snapshot without refetching', async () => {
    vi.resetModules()
    const payload = { pageKind: 'Home', routeKey: 'home', title: 'Binary hydration' }
    const rawPayload = encodePublicAotPayload(payload)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { readPublicHydrationPayloadAsync, replacePublicHydrationPayloadBinary } =
      await import('@/bootstrap/publicHydrationBootstrap')
    try {
      const first = replacePublicHydrationPayloadBinary(rawPayload)
      const script = document.getElementById('fsus-aot-hydration-props')
      expect(script).toBeInstanceOf(HTMLScriptElement)
      expect(script?.getAttribute('type')).toBe('application/octet-stream')
      expect(script?.textContent).toBe(rawPayload)
      expect(first).toEqual(payload)
      expect(await readPublicHydrationPayloadAsync()).toBe(first)

      replacePublicHydrationPayloadBinary(rawPayload)
      expect(document.getElementById('fsus-aot-hydration-props')).toBe(script)
      expect(fetchSpy).not.toHaveBeenCalled()

      expect(replacePublicHydrationPayloadBinary(null)).toBeNull()
      expect(document.getElementById('fsus-aot-hydration-props')).toBeNull()
      expect(await readPublicHydrationPayloadAsync()).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects a non-script hydration carrier before changing the accepted snapshot', async () => {
    vi.resetModules()
    const payload = { pageKind: 'Home', routeKey: 'home', title: 'Accepted hydration' }
    const rawPayload = encodePublicAotPayload(payload)
    const { readPublicHydrationPayload, replacePublicHydrationPayloadBinary } =
      await import('@/bootstrap/publicHydrationBootstrap')
    const accepted = replacePublicHydrationPayloadBinary(rawPayload)
    document.getElementById('fsus-aot-hydration-props')?.remove()
    const carrier = document.createElement('div')
    carrier.id = 'fsus-aot-hydration-props'
    carrier.textContent = 'untrusted carrier'
    document.body.appendChild(carrier)

    expect(() => replacePublicHydrationPayloadBinary(encodePublicAotPayload({ ...payload, title: 'Rejected' })))
      .toThrow('public_hydration_script_invalid')
    expect(carrier.textContent).toBe('untrusted carrier')
    expect(readPublicHydrationPayload()).toBe(accepted)
    expect((window as PublicSeedWindow).__FSUS_PUBLIC_HYDRATION_RAW__).toBe(rawPayload)
  })

  it('fetches hydration payloads from an AEDS sidecar marker before falling back to inline text', async () => {
    vi.resetModules()

    const rawPayload = encodePublicAotPayload({
      pageKind: 'ArticleDetail',
      routeKey: 'article:1',
      rendererVersion: 'test-renderer',
      title: 'Sidecar hydration',
      articleId: 1,
      rights: articleRightsFixture,
      detailView: {
        rights: articleRightsFixture
      },
      commentsIsland: {
        articleId: 1
      }
    })
    const script = document.createElement('script')
    script.id = 'fsus-aot-hydration-props'
    script.type = 'application/octet-stream'
    script.dataset.aedsSrc = '/aot-cache/payloads/aa/sidecar.aeds'
    document.body.appendChild(script)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(base64UrlToBytes(rawPayload)))

    const { readPublicHydrationPayload, readPublicHydrationPayloadAsync } = await import('@/bootstrap/publicHydrationBootstrap')
    const payload = await readPublicHydrationPayloadAsync()

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:7568/aot-cache/payloads/aa/sidecar.aeds',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: {
          Accept: PUBLIC_AOT_HYDRATION_MEDIA_TYPE
        }
      })
    )
    expect(payload?.pageKind).toBe('ArticleDetail')
    expect(payload?.routeKey).toBe('article:1')
    expect(readPublicHydrationPayload()?.title).toBe('Sidecar hydration')

    fetchSpy.mockRestore()
  })

  it.each(['', '   '])('preserves src fallback only for an empty dataset sidecar marker: %j', async (marker) => {
    vi.resetModules()
    const payload = { pageKind: 'Home', routeKey: 'home', title: 'Sidecar fallback' }
    const rawPayload = encodePublicAotPayload(payload)
    const script = document.createElement('script')
    script.id = 'fsus-aot-hydration-props'
    script.type = 'application/octet-stream'
    script.dataset.aedsSrc = marker
    script.setAttribute('src', '/aot-cache/payloads/aa/sidecar.aeds')
    document.body.appendChild(script)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(base64UrlToBytes(rawPayload)))
    const { readPublicHydrationPayloadAsync } = await import('@/bootstrap/publicHydrationBootstrap')
    try {
      const observed = await readPublicHydrationPayloadAsync()
      if (marker === '') {
        expect(observed).toEqual(payload)
        expect(fetchSpy).toHaveBeenCalledOnce()
        expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7568/aot-cache/payloads/aa/sidecar.aeds')
        expect(await readPublicHydrationPayloadAsync()).toBe(observed)
        expect(fetchSpy).toHaveBeenCalledOnce()
      } else {
        expect(observed).toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
      }
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
