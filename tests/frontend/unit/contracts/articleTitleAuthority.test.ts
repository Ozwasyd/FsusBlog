// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'

const mountRenderer = (mode: 'article' | 'about' | 'preview') => mount(MarkdownRenderer, {
  props: {
    content: '# 章节标题',
    mode
  },
  global: {
    stubs: {
      ElMarkdownRenderer: { template: '<div data-markdown-renderer />' }
    }
  }
})

describe('article title authority', () => {
  it('assigns mode ownership without splitting the reading baseline', () => {
    const article = mountRenderer('article')
    const about = mountRenderer('about')
    const preview = mountRenderer('preview')

    expect(article.classes()).toContain('markdown-body--article')
    expect(article.classes()).not.toContain('markdown-body--document')
    expect(about.classes()).toContain('markdown-body--document')
    expect(about.classes()).not.toContain('markdown-body--article')
    expect(preview.classes()).not.toContain('markdown-body--article')
    expect(preview.classes()).not.toContain('markdown-body--document')
    expect(preview.classes()).toContain('markdown-body--preview')

    article.unmount()
    about.unmount()
    preview.unmount()
  })

  it('keeps the page title dominant through the shared token contract', () => {
    expect(themeTokens.articleDetail.title).toContain('text-2xl sm:text-3xl')
    expect(themeTokens.articleDetail.title).toContain('font-bold')
    expect(themeTokens.articleDetail.title).toContain('leading-[1.25] sm:leading-[1.2]')
  })

  it('retains punctuation and loading contracts', () => {
    expect(themeTokens.articleList.metaSeparator).toContain('font-normal')
    expect(themeTokens.articleList.metaSeparator).toContain('text-[var(--fsusblog-text-decorative)]')
    expect(themeTokens.articleDetail.commentsPlaceholderDot).toBe('fsusblog-dot-loader')
  })
})
