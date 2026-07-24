// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import CommentMarkdownRenderer from '@/components/article/CommentMarkdownRenderer.vue'

const componentSource = readFileSync(
  resolve(process.cwd(), 'src/components/article/CommentMarkdownRenderer.vue'),
  'utf8'
)

const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, required: true },
    allowHtml: { type: Boolean, default: true },
    allowLatex: { type: Boolean, default: true },
    allowMermaid: { type: Boolean, default: true }
  },
  emits: ['render-complete'],
  setup(props, { emit }) {
    return () => h('div', {
      class: 'markdown-body',
      'data-test-markdown-content': props.content,
      onVnodeMounted: () => emit('render-complete')
    }, [
      h('p', 'boundary paragraph'),
      h('pre', [h('code', 'const boundary = true')]),
      h('pre', { class: 'shiki' }, 'highlighted boundary'),
      h('img', { src: '/boundary.png', alt: 'boundary image' }),
      h('svg', { viewBox: '0 0 10 10' }),
      h('iframe', { src: 'about:blank', title: 'boundary frame' })
    ])
  }
})

describe('CommentMarkdownRenderer consumer-owned style boundary', () => {
  it('forwards comment markdown with unsafe feature modes disabled inside a stable boundary', () => {
    const content = '# Comment\n\n```ts\nconst boundary = true\n```'
    const wrapper = mount(CommentMarkdownRenderer, {
      props: { content, collapsible: false },
      global: { stubs: { MarkdownRenderer: MarkdownRendererStub } }
    })

    expect(wrapper.attributes('data-fsus-comment-markdown')).toBe('')
    const renderer = wrapper.getComponent(MarkdownRendererStub)
    expect(renderer.props()).toMatchObject({
      content,
      allowHtml: false,
      allowLatex: false,
      allowMermaid: false
    })
    expect(wrapper.findAll('pre')).toHaveLength(2)
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(true)

    wrapper.unmount()
  })

  it('owns descendant styling through the stable data hook without deep or library internals', () => {
    expect(componentSource.match(/:deep\s*\(/gu) ?? []).toHaveLength(0)
    expect(componentSource).toContain('[data-fsus-comment-markdown] .markdown-body p:last-child')
    expect(componentSource).toContain('[data-fsus-comment-markdown] .markdown-body pre')
    expect(componentSource).toContain('[data-fsus-comment-markdown] .markdown-body :is(img, svg, iframe)')
    expect(componentSource).not.toContain('.shiki')
    expect(componentSource).not.toMatch(/\.el-[a-z0-9_-]+/iu)
    expect(componentSource).not.toContain('!important')
    expect(componentSource).not.toMatch(/margin(?:-inline|-block|-left|-right|-top|-bottom)?:\s*-/u)
    expect(componentSource).not.toMatch(/position:\s*absolute/u)
  })
})
