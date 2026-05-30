import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

type PublicSeedWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__?: string | null
  __FSUS_PUBLIC_HYDRATION_RAW__?: string | null
}

function setCurrentUrl(url: string): void {
  window.location.href = url
}

describe('public seed readers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setCurrentUrl('http://127.0.0.1:5000/article/1')
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
        createTime: '2026-05-11T00:00:00Z'
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

  it('falls back to the boot-time hydration snapshot when the DOM script is unavailable', async () => {
    vi.resetModules()

    ;(window as PublicSeedWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = encodePublicAotPayload({
      pageKind: 'ArticleDetail',
      routeKey: 'article:1',
      rendererVersion: 'test-renderer',
      title: 'Hydration snapshot',
      articleId: 1,
      detailView: {
        id: 1,
        title: 'Hydration snapshot',
        summary: 'summary',
        content: 'content',
        views: 42,
        createTime: '2026-05-11T00:00:00Z',
        category: {
          id: 1,
          name: 'Category'
        },
        tags: []
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
})
