// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'

const markdownCss = readFileSync(resolve(process.cwd(), 'src/assets/markdown.css'), 'utf8')

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
  it('assigns chapter-heading typography only to article prose', () => {
    const article = mountRenderer('article')
    const about = mountRenderer('about')
    const preview = mountRenderer('preview')

    expect(article.classes()).toContain('markdown-body--article')
    expect(article.classes()).not.toContain('markdown-body--document')
    expect(about.classes()).toContain('markdown-body--document')
    expect(about.classes()).not.toContain('markdown-body--article')
    expect(preview.classes()).not.toContain('markdown-body--article')
    expect(preview.classes()).not.toContain('markdown-body--document')

    article.unmount()
    about.unmount()
    preview.unmount()
  })

  it('keeps the page title dominant and the article H1 subordinate', () => {
    expect(themeTokens.articleDetail.title).toContain('text-xl sm:text-2xl lg:text-3xl')
    expect(themeTokens.articleDetail.title).toContain('font-bold')
    expect(themeTokens.articleDetail.title).toContain('leading-[1.15]')
    expect(markdownCss).toMatch(/\.markdown-body--article h1\s*\{[^}]*font-size:\s*1\.4em;[^}]*font-weight:\s*700;[^}]*margin-top:\s*3em;[^}]*margin-bottom:\s*1em;[^}]*text-align:\s*left;/u)
  })

  it('retains the about document and punctuation contracts', () => {
    expect(markdownCss).toMatch(/\.markdown-body--document\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;[^}]*text-autospace:\s*normal;/u)
    expect(themeTokens.articleList.metaSeparator).toContain('font-normal')
    expect(themeTokens.articleList.metaSeparator).toContain('text-[var(--fsusblog-text-decorative)]')
    expect(themeTokens.articleDetail.commentsPlaceholderDot).toBe('fsusblog-dot-loader')
  })
})
