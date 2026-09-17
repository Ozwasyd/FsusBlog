// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticleResponsibilityDisclosure from '@/components/article/ArticleResponsibilityDisclosure.vue'

describe('ArticleResponsibilityDisclosure', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders deterministic site-author fallback when the manifest is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const wrapper = mount(ArticleResponsibilityDisclosure, {
      props: { articleId: 42, fallbackAuthor: 'Site Author' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('作者Site Author')
    expect(wrapper.get('[data-proof-status]').attributes('data-proof-status')).toBe('unavailable')
    expect(wrapper.attributes('data-manifest-state')).toBe('unavailable')
  })

  it('renders multiple authors, optional reviewer, safe sources, update note and verification URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        articleId: 42,
        revisionNo: 3,
        authors: [
          { name: 'Alice', profileUrl: 'https://example.test/alice' },
          { name: 'Carol', profileUrl: null }
        ],
        reviewer: { name: 'Bob', profileUrl: null },
        sources: [{
          title: 'Primary source',
          url: 'https://example.test/source',
          sourceType: 'primary',
          accessedOn: '2026-07-14',
          version: 'v1',
          citationNote: null
        }],
        update: { summary: '结论已更新', reason: '新证据', conclusionImpact: 'changed' },
        verification: { url: '/integrity/article/42/revisions/3', proofStatus: 'ready' }
      })
    }))
    const wrapper = mount(ArticleResponsibilityDisclosure, {
      props: { articleId: 42, fallbackAuthor: 'Site Author' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Alice、Carol')
    expect(wrapper.text()).toContain('审阅Bob')
    expect(wrapper.get('[data-article-update-note]').text()).toContain('结论已改变')
    expect(wrapper.get('[data-article-sources] a').attributes('href')).toBe('https://example.test/source')
    expect(wrapper.get('[data-article-verification-link]').attributes('href')).toBe('/integrity/article/42/revisions/3')
    expect(wrapper.get('[data-proof-status]').attributes('data-proof-status')).toBe('ready')
  })

  it('renders the stable failed proof state without internal failure details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        articleId: 42,
        revisionNo: 4,
        authors: [{ name: 'Alice', profileUrl: null }],
        reviewer: null,
        sources: [],
        update: null,
        verification: { url: '/integrity/article/42/revisions/4', proofStatus: 'failed' }
      })
    }))
    const wrapper = mount(ArticleResponsibilityDisclosure, {
      props: { articleId: 42, fallbackAuthor: 'Site Author' }
    })
    await flushPromises()

    expect(wrapper.get('[data-proof-status]').attributes('data-proof-status')).toBe('failed')
    expect(wrapper.text()).toContain('核验失败')
    expect(wrapper.text()).not.toContain('stack')
  })
})
