// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'

describe('ArticleDetailBody', () => {
  it('leaves markdown typography ownership to the nested renderer', () => {
    const wrapper = mount(ArticleDetailBody, {
      slots: {
        default: '<div class="blog-markdown-renderer markdown-body safe-inline-wrap">Body</div>'
      }
    })

    expect(wrapper.classes()).toEqual(['article-detail-body', 'safe-inline-wrap'])
    expect(wrapper.classes()).not.toContain('markdown-body')
    expect(wrapper.classes()).not.toContain('prose')
    expect(wrapper.classes()).not.toContain('whitespace-pre-wrap')
    expect(wrapper.findAll('.markdown-body')).toHaveLength(1)
    expect(wrapper.get('.markdown-body').classes()).toContain('safe-inline-wrap')

    wrapper.unmount()
  })
})
