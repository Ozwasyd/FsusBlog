import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPublicSearchNoIndexHead,
  commitPublicSearchNoIndexHead,
  clearPublicSeoHead,
  commitPreparedPublicSeoHead,
  computePublicSeoHeadDigest,
  resetPublicSeoHeadForTests,
  validateAndPreparePublicSeoHead,
  type PublicSeoHeadModel
} from '@/router/publicSeoHead'

async function head(path: string, title: string, type = 'website'): Promise<PublicSeoHeadModel> {
  const canonicalUrl = new URL(path, 'http://127.0.0.1').toString()
  const unsigned = {
    schema: 'fsusblog.public-seo-head',
    version: 1,
    digest: '',
    documentTitle: title,
    description: `${title} description`,
    canonicalUrl,
    publicOrigin: 'http://127.0.0.1',
    robots: 'index,follow',
    locale: 'zh-CN',
    pageType: type === 'article' ? 'ArticleDetail' : 'Archive',
    pageEntityId: canonicalUrl,
    openGraph: {
      title,
      description: `${title} description`,
      type,
      url: canonicalUrl,
      locale: 'zh_CN',
      imageUrl: null
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: `${title} description`,
      imageUrl: null
    },
    jsonLdGraph: JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': type === 'article' ? 'BlogPosting' : 'WebPage', url: canonicalUrl }]
    }),
    articlePublishedAtUtc: null,
    articleModifiedAtUtc: null,
    articleAuthor: null,
    articleImageUrl: null
  } satisfies PublicSeoHeadModel
  return { ...unsigned, digest: await computePublicSeoHeadDigest(unsigned) }
}

describe('public SEO head takeover', () => {
  beforeEach(() => {
    resetPublicSeoHeadForTests()
    document.head.querySelectorAll('[data-fsus-aot-head], [data-fsus-search-head]').forEach((node) => node.remove())
  })

  it('atomically replaces every page-level node and restores the retained model on back navigation', async () => {
    const articleA = await head('/article/1', 'Article A', 'article')
    const articleB = await head('/article/2', 'Article B', 'article')
    const staleCanonical = document.createElement('link')
    staleCanonical.rel = 'canonical'
    staleCanonical.href = 'http://127.0.0.1/stale'
    document.head.appendChild(staleCanonical)
    expect(await validateAndPreparePublicSeoHead(articleA, '/article/1', '/article/1')).toBe(true)
    expect(commitPreparedPublicSeoHead('/article/1')).toBe(true)
    resetPublicSeoHeadForTests()
    expect(await validateAndPreparePublicSeoHead(articleB, '/article/2', '/article/2')).toBe(true)
    expect(commitPreparedPublicSeoHead('/article/2', '/article/1')).toBe(true)
    expect(document.title).toBe('Article B')
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(articleB.canonicalUrl)
    expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1)
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent).toContain('/article/2')
    expect(document.head.textContent).not.toContain('/article/1')

    expect(commitPreparedPublicSeoHead('/article/1', '/article/2')).toBe(true)
    expect(document.title).toBe('Article A')
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(articleA.canonicalUrl)
  })

  it('fails closed on schema digest mismatch', async () => {
    const model = await head('/archive', 'Archive')
    expect(await validateAndPreparePublicSeoHead({ ...model, digest: '0'.repeat(64) }, '/archive', '/archive')).toBe(false)
    expect(commitPreparedPublicSeoHead('/archive')).toBe(false)
  })

  it('treats the canonical page query as part of the public identity', async () => {
    const model = await head('/?page=2&cursor=opaque_cursor', 'Home page 2')

    expect(await validateAndPreparePublicSeoHead(model, '/?page=2&cursor=opaque_cursor', '/?page=2&cursor=opaque_cursor')).toBe(true)
    resetPublicSeoHeadForTests()
    expect(await validateAndPreparePublicSeoHead(model, '/?page=2&cursor=opaque_cursor', '/')).toBe(false)
  })

  it('removes article canonical and structured data before a non-public route takes over', async () => {
    const model = await head('/article/1', 'Article A', 'article')
    await validateAndPreparePublicSeoHead(model, '/article/1', '/article/1')
    commitPreparedPublicSeoHead('/article/1')

    clearPublicSeoHead('/article/1')

    expect(document.querySelector('[data-fsus-aot-head]')).toBeNull()
    expect(document.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull()
  })

  it('atomically replaces a public page head with search noindex and clears it on exit', async () => {
    const model = await head('/article/1', 'Article A', 'article')
    await validateAndPreparePublicSeoHead(model, '/article/1', '/article/1')
    commitPreparedPublicSeoHead('/article/1')

    commitPublicSearchNoIndexHead('/article/1')

    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,follow')
    expect(document.querySelector('[data-fsus-search-head]')).not.toBeNull()
    expect(document.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull()

    clearPublicSearchNoIndexHead()
    expect(document.querySelector('meta[name="robots"]')).toBeNull()
  })

  it('does not rewrite canonical or structured data for notification-only state changes', async () => {
    const model = await head('/article/1', 'Article A', 'article')
    await validateAndPreparePublicSeoHead(model, '/article/1', '/article/1')
    commitPreparedPublicSeoHead('/article/1')
    const canonical = document.querySelector('link[rel="canonical"]')
    const jsonLd = document.querySelector('script[type="application/ld+json"]')

    window.dispatchEvent(new window.CustomEvent('fsus:notification-stream-state', { detail: { comments: 2 } }))

    expect(document.querySelector('link[rel="canonical"]')).toBe(canonical)
    expect(document.querySelector('script[type="application/ld+json"]')).toBe(jsonLd)
  })
})
