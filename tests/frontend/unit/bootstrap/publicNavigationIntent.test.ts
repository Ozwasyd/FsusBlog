import { describe, expect, it } from 'vitest'

function createAnchor(href: string): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.href = href
  return anchor
}

describe('public navigation intent', () => {
  it('classifies supported public AOT links for atomic takeover', async () => {
    const { classifyPublicNavigationIntent } = await import('@/bootstrap/publicNavigationIntent')

    expect(classifyPublicNavigationIntent({
      anchor: createAnchor('http://127.0.0.1/archive?page=2'),
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({
      kind: 'atomic-public-route',
      fullPath: '/archive?page=2',
      source: 'link'
    })

    expect(classifyPublicNavigationIntent({
      href: 'http://127.0.0.1/article/1#comments',
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({
      kind: 'atomic-public-route',
      fullPath: '/article/1#comments'
    })
  })

  it('keeps modified, external, download, auth and same-page hash links native', async () => {
    const { classifyPublicNavigationIntent } = await import('@/bootstrap/publicNavigationIntent')
    const modifiedEvent = {
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false
    } as unknown as MouseEvent

    expect(classifyPublicNavigationIntent({
      anchor: createAnchor('http://127.0.0.1/archive'),
      event: modifiedEvent,
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({ kind: 'native', reason: 'modified-click' })

    expect(classifyPublicNavigationIntent({
      anchor: createAnchor('https://example.test/archive'),
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({ kind: 'native', reason: 'external' })

    const download = createAnchor('http://127.0.0.1/archive')
    download.setAttribute('download', '')
    expect(classifyPublicNavigationIntent({
      anchor: download,
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({ kind: 'native', reason: 'download' })

    expect(classifyPublicNavigationIntent({
      anchor: createAnchor('http://127.0.0.1/login'),
      currentHref: 'http://127.0.0.1/'
    })).toMatchObject({ kind: 'native', reason: 'non-aot-route' })

    expect(classifyPublicNavigationIntent({
      anchor: createAnchor('http://127.0.0.1/article/1#comments'),
      currentHref: 'http://127.0.0.1/article/1'
    })).toMatchObject({ kind: 'native', reason: 'same-page-hash' })
  })

  it('classifies comment activation as an island action instead of SPA takeover', async () => {
    const { classifyPublicNavigationIntent } = await import('@/bootstrap/publicNavigationIntent')

    expect(classifyPublicNavigationIntent({
      action: 'activate-comments',
      href: 'http://127.0.0.1/article/1#comments',
      currentHref: 'http://127.0.0.1/article/1'
    })).toMatchObject({
      kind: 'comments-island'
    })
  })
})
