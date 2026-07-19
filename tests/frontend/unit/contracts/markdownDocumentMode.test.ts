// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

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
})
