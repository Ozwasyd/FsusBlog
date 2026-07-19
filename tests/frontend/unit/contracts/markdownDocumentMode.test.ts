// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

const markdownCss = readFileSync(
  resolve(process.cwd(), 'src/assets/markdown.css'),
  'utf8'
)

const mountRenderer = (mode: 'article' | 'about' | 'preview') => mount(MarkdownRenderer, {
  props: {
    content: '1.1 条款',
    mode
  },
  global: {
    stubs: {
      ElMarkdownRenderer: { template: '<div data-markdown-renderer />' }
    }
  }
})

describe('MarkdownRenderer document mode', () => {
  it('adds document typography only for about mode', () => {
    const about = mountRenderer('about')
    const article = mountRenderer('article')
    const preview = mountRenderer('preview')

    expect(about.classes()).toContain('markdown-body--document')
    expect(article.classes()).not.toContain('markdown-body--document')
    expect(preview.classes()).not.toContain('markdown-body--document')
    expect(preview.classes()).toContain('markdown-body--preview')

    about.unmount()
    article.unmount()
    preview.unmount()
  })

  it('keeps legal clauses flush left with natural spacing and aligned lists', () => {
    expect(markdownCss).toMatch(/\.markdown-body--document\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;[^}]*text-autospace:\s*normal;/u)
    expect(markdownCss).toMatch(/\.markdown-body--document \.markdown-renderer__text\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;/u)
    expect(markdownCss).toMatch(/\.markdown-body--document p\s*\{[^}]*text-indent:\s*0;/u)
    expect(markdownCss).toMatch(/\.markdown-body--document ul,\s*\.markdown-body--document ol\s*\{[^}]*margin:\s*1\.5rem 0;[^}]*padding-left:\s*1\.5em;/u)
  })
})
