// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { ElMarkdownRenderer } from '@ozwasyd/element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticlePrivatePreviewPanel from '@/components/admin/article/ArticlePrivatePreviewPanel.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import type { ArticlePreviewResponse } from '@/api/authoring'
import type {
  MarkdownFeatureActivationResult,
  MarkdownRenderResult
} from '@/fsusui/markdown'

const MarkdownRendererStub = defineComponent({
  name: 'ArticleBodyMarkdownPreview',
  props: {
    content: { type: String, required: true },
    contentVersion: { type: [String, Number], default: null }
  },
  emits: ['features-activated', 'render-complete', 'render-error'],
  setup: props => () => h('pre', { 'data-preview-markdown': '' }, props.content)
})
const ButtonStub = defineComponent({
  emits: ['click'],
  setup: (_props, { emit, slots }) =>
    () => h('button', { onClick: () => emit('click') }, slots.default?.())
})

afterEach(() => {
  document.body.replaceChildren()
})

const waitForActualMarkdownRender = async (wrapper: ReturnType<typeof mount>) => {
  const renderer = wrapper.getComponent(MarkdownRenderer)
  await vi.waitFor(() => {
    expect(renderer.emitted('render-complete')).toHaveLength(1)
  }, { interval: 25, timeout: 5_000 })
  await vi.waitFor(() => {
    expect(renderer.emitted('features-activated')).toHaveLength(1)
  }, { interval: 25, timeout: 5_000 })
  return renderer
}

const realMarkdownComponents = {
  ElMarkdownRenderer
}

const preview = (
  sourceIdentity: string,
  normalizedMarkdownSource = 'preview markdown'
): ArticlePreviewResponse => ({
  normalizedTitle: 'Preview title',
  normalizedSummary: 'Preview summary',
  normalizedCoverImageUrl: '/uploads/cover.png',
  normalizedMarkdownSource,
  plainText: 'Preview text',
  sourceIdentity,
  issues: []
})

const markdownResult = (
  sourceIdentity: string,
  normalizedSource = 'preview markdown'
): MarkdownRenderResult => ({
  html: '<p>preview</p>',
  normalizedSource,
  sourceIdentity,
  rendererVersion: 'test',
  features: ['table', 'code_block', 'latex', 'mermaid'],
  placeholders: []
}) as unknown as MarkdownRenderResult

const successfulActivation = (): MarkdownFeatureActivationResult => ({
  activated: [
    { count: 1, kind: 'code-highlight' },
    { count: 1, kind: 'latex' },
    { count: 1, kind: 'mermaid' }
  ],
  errors: []
})

const mountCompletionPanel = (value: ArticlePreviewResponse) => mount(
  ArticlePrivatePreviewPanel,
  {
    props: {
      preview: value,
      loading: false,
      statusText: '已生成',
      canPreview: true
    },
    global: {
      stubs: {
        ArticleBodyMarkdownPreview: MarkdownRendererStub,
        ElButton: ButtonStub
      }
    }
  }
)

const emitCompletion = async (
  wrapper: ReturnType<typeof mountCompletionPanel>,
  result: MarkdownRenderResult,
  activation = successfulActivation()
) => {
  const renderer = wrapper.getComponent(MarkdownRendererStub)
  const contentVersion = renderer.props('contentVersion')
  renderer.vm.$emit('render-complete', result, contentVersion)
  renderer.vm.$emit('features-activated', activation, result, contentVersion)
  await nextTick()
}

describe('ArticlePrivatePreviewPanel structured rendering boundary', () => {
  it('renders executable-looking fields as text and passes only Markdown source to FsusUI', () => {
    const markdown = '<script>steal()</script>\n<img src=x onerror=steal()>\n<svg onload=steal()>\n<iframe srcdoc=x>'
    const wrapper = mount(ArticlePrivatePreviewPanel, {
      props: {
        preview: {
          normalizedTitle: '<img src=x onerror=steal()>',
          normalizedSummary: '<svg onload=steal()>',
          normalizedCoverImageUrl: '/uploads/cover.png',
          normalizedMarkdownSource: markdown,
          plainText: 'preview',
          sourceIdentity: `preview:sha256:${'0'.repeat(64)}`,
          issues: [{ severity: 'error', code: 'dangerous_html', message: '<script>issue()</script>' }]
        },
        loading: false,
        statusText: '已生成',
        canPreview: true
      },
      global: {
        stubs: {
          ArticleBodyMarkdownPreview: MarkdownRendererStub,
          ElButton: { template: '<button><slot /></button>' }
        }
      }
    })

    expect(wrapper.text()).toContain('<img src=x onerror=steal()>')
    expect(wrapper.text()).toContain('<svg onload=steal()>')
    expect(wrapper.text()).toContain('<script>issue()</script>')
    expect(wrapper.get('[data-preview-markdown]').text()).toBe(markdown)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('.author-preview__cover img').attributes('src')).toBe('/uploads/cover.png')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>steal()</script>',
    '//cdn.example.test/cover.png',
    'https://user:pass@cdn.example.test/cover.png'
  ])('does not render a hostile cover URL %s', (coverImageUrl) => {
    const wrapper = mount(ArticlePrivatePreviewPanel, {
      props: {
        preview: {
          normalizedTitle: 'Preview title',
          normalizedSummary: 'Preview summary',
          normalizedCoverImageUrl: coverImageUrl,
          normalizedMarkdownSource: 'preview markdown',
          plainText: 'preview',
          sourceIdentity: `preview:sha256:${'4'.repeat(64)}`,
          issues: []
        },
        loading: false,
        statusText: '已生成',
        canPreview: true
      },
      global: {
        stubs: {
          ArticleBodyMarkdownPreview: MarkdownRendererStub,
          ElButton: { template: '<button><slot /></button>' }
        }
      }
    })

    expect(wrapper.find('.author-preview__cover').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('keeps the complete structured preview visible and emits regeneration intent', async () => {
    const markdown = [
      '| column | value |',
      '| --- | --- |',
      '| table | complete |',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '$$E = mc^2$$',
      '',
      '```mermaid',
      'graph TD; A-->B',
      '```'
    ].join('\n')
    const wrapper = mount(ArticlePrivatePreviewPanel, {
      props: {
        preview: {
          normalizedTitle: '完整预览',
          normalizedSummary: '摘要内容',
          normalizedCoverImageUrl: 'https://cdn.example.test/cover.webp',
          normalizedMarkdownSource: markdown,
          plainText: 'table complete const answer = 42 E = mc^2 graph TD A B',
          sourceIdentity: `preview:sha256:${'1'.repeat(64)}`,
          issues: [
            { severity: 'warning', code: 'summary_short', message: '摘要较短' },
            { severity: 'info', code: 'cover_ready', message: '封面可用' }
          ]
        },
        loading: false,
        statusText: '预览已更新',
        canPreview: true
      },
      global: {
        stubs: {
          ArticleBodyMarkdownPreview: MarkdownRendererStub,
          ElButton: ButtonStub
        }
      }
    })

    expect(wrapper.get('h1').text()).toBe('完整预览')
    expect(wrapper.get('.author-preview__summary').text()).toBe('摘要内容')
    expect(wrapper.get('[data-preview-markdown]').text()).toBe(markdown)
    expect(wrapper.get('.author-preview__cover img').attributes('src'))
      .toBe('https://cdn.example.test/cover.webp')
    expect(wrapper.findAll('.preview-issue').map(issue => issue.text()))
      .toEqual(['摘要较短', '封面可用'])

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
  })

  it('renders hostile Markdown through the active FsusUI DOM without executable nodes or attributes', async () => {
    const markdown = [
      '<script>steal()</script>',
      '<img src=x onerror=steal()>',
      '<svg onload=steal()></svg>',
      '<iframe srcdoc="<script>steal()</script>"></iframe>'
    ].join('\n')
    const wrapper = mount(ArticlePrivatePreviewPanel, {
      attachTo: document.body,
      props: {
        preview: {
          normalizedTitle: '安全预览',
          normalizedSummary: '危险输入只作为 Markdown source 处理。',
          normalizedCoverImageUrl: '/uploads/cover.png',
          normalizedMarkdownSource: markdown,
          plainText: '安全预览',
          sourceIdentity: `preview:sha256:${'2'.repeat(64)}`,
          issues: []
        },
        loading: false,
        statusText: '已生成',
        canPreview: true
      },
      global: { components: realMarkdownComponents }
    })

    const renderer = await waitForActualMarkdownRender(wrapper)
    const rendererRoot = renderer.get('[data-markdown-renderer="wasm"]')
    const forbiddenSelector = 'script, iframe, object, embed, base, form, img[onerror], svg[onload]'

    expect(renderer.props('content')).toBe(markdown)
    expect(rendererRoot.find(forbiddenSelector).exists()).toBe(false)
    expect(rendererRoot.findAll('*').flatMap(node => Object.keys(node.attributes()))
      .some(name => name.toLowerCase().startsWith('on'))).toBe(false)
    expect(rendererRoot.findAll('[srcdoc]').length).toBe(0)
    expect(rendererRoot.findAll('[href], [src]').some(node => {
      const value = node.attributes('href') || node.attributes('src')
      if (value === undefined) {
        throw new Error('preview_url_attribute_missing')
      }
      return /^(?:javascript:|vbscript:|data:text\/html)/iu.test(value.trim())
    })).toBe(false)
    const renderResult = renderer.emitted('render-complete')?.[0]?.[0]
    expect(renderer.emitted('features-activated')?.[0]?.[1]).toBe(renderResult)
    wrapper.unmount()
  })

})

describe('ArticlePrivatePreviewPanel completion authority', () => {
  it('completes with distinct backend and Markdown identity domains', async () => {
    const backendIdentity = `preview:sha256:${'a'.repeat(64)}`
    const fsusuiIdentity = 'markdown:fixture:current'
    const wrapper = mountCompletionPanel(preview(backendIdentity))

    await emitCompletion(wrapper, markdownResult(fsusuiIdentity))

    const article = wrapper.get('.author-preview')
    expect(article.attributes('data-preview-source-identity')).toBe(backendIdentity)
    expect(article.attributes('data-preview-render-complete')).toBe(backendIdentity)
    expect(article.attributes('data-preview-render-markdown-identity')).toBe(fsusuiIdentity)
    expect(article.attributes('data-preview-activation-markdown-identity')).toBe(fsusuiIdentity)
    expect(backendIdentity).not.toBe(fsusuiIdentity)
  })

  it('waits for required features that activate in separate FsusUI batches', async () => {
    const wrapper = mountCompletionPanel(preview(`preview:sha256:${'b'.repeat(64)}`))
    const renderer = wrapper.getComponent(MarkdownRendererStub)
    const result = markdownResult('markdown:fixture:chunked')
    const contentVersion = renderer.props('contentVersion')
    renderer.vm.$emit('render-complete', result, contentVersion)

    for (const kind of ['code-highlight', 'latex'] as const) {
      renderer.vm.$emit('features-activated', {
        activated: [{ count: 1, kind }],
        errors: []
      }, result, contentVersion)
      await nextTick()
      expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
        .toBeUndefined()
    }

    renderer.vm.$emit('features-activated', {
      activated: [{ count: 1, kind: 'mermaid' }],
      errors: []
    }, result, contentVersion)
    await nextTick()
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBe(wrapper.props('preview')?.sourceIdentity)
  })

  it('rejects stale events from the previous backend preview generation', async () => {
    const first = preview(`preview:sha256:${'c'.repeat(64)}`)
    const second = preview(`preview:sha256:${'d'.repeat(64)}`)
    const wrapper = mountCompletionPanel(first)
    const staleRenderer = wrapper.getComponent(MarkdownRendererStub)

    await wrapper.setProps({ preview: second })
    const staleResult = markdownResult('markdown:fixture:shared')
    staleRenderer.vm.$emit(
      'render-complete',
      staleResult,
      staleRenderer.props('contentVersion')
    )
    staleRenderer.vm.$emit(
      'features-activated',
      successfulActivation(),
      staleResult,
      staleRenderer.props('contentVersion')
    )
    await nextTick()

    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBeUndefined()
    await emitCompletion(wrapper, staleResult)
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBe(second.sourceIdentity)
  })

  it('fails closed for mismatched render and activation Markdown identities', async () => {
    const wrapper = mountCompletionPanel(preview(`preview:sha256:${'e'.repeat(64)}`))
    const renderer = wrapper.getComponent(MarkdownRendererStub)
    const contentVersion = renderer.props('contentVersion')
    renderer.vm.$emit(
      'render-complete',
      markdownResult('markdown:fixture:render'),
      contentVersion
    )
    renderer.vm.$emit(
      'features-activated',
      successfulActivation(),
      markdownResult('markdown:fixture:activation'),
      contentVersion
    )
    await nextTick()

    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBeUndefined()
    await emitCompletion(wrapper, markdownResult('markdown:fixture:render'))
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBeUndefined()
  })

  it('latches activation and render errors until a new backend preview arrives', async () => {
    const initial = preview(`preview:sha256:${'f'.repeat(64)}`)
    const wrapper = mountCompletionPanel(initial)
    const result = markdownResult('markdown:fixture:error')
    await emitCompletion(wrapper, result)
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBe(initial.sourceIdentity)

    const renderer = wrapper.getComponent(MarkdownRendererStub)
    renderer.vm.$emit('features-activated', {
      activated: [],
      errors: [{ kind: 'latex', message: 'failed' }]
    }, result, renderer.props('contentVersion'))
    await nextTick()
    await emitCompletion(wrapper, result)
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBeUndefined()

    const next = preview(`preview:sha256:${'0'.repeat(64)}`)
    await wrapper.setProps({ preview: next })
    const nextRenderer = wrapper.getComponent(MarkdownRendererStub)
    const nextResult = markdownResult('markdown:fixture:next')
    nextRenderer.vm.$emit(
      'render-error',
      new Error('render failed'),
      nextRenderer.props('contentVersion')
    )
    await emitCompletion(wrapper, nextResult)
    expect(wrapper.get('.author-preview').attributes('data-preview-render-complete'))
      .toBeUndefined()
  })

  it('clears completion synchronously when preview identity or source changes', async () => {
    const wrapper = mountCompletionPanel(preview(`preview:sha256:${'1'.repeat(64)}`))
    await emitCompletion(wrapper, markdownResult('markdown:fixture:first'))

    await wrapper.setProps({
      preview: preview(`preview:sha256:${'2'.repeat(64)}`, 'next markdown')
    })

    const article = wrapper.get('.author-preview')
    expect(article.attributes('data-preview-source-identity'))
      .toBe(`preview:sha256:${'2'.repeat(64)}`)
    expect(article.attributes('data-preview-render-complete')).toBeUndefined()
    expect(article.attributes('data-preview-render-markdown-identity')).toBeUndefined()
    expect(article.attributes('data-preview-activation-markdown-identity')).toBeUndefined()
  })

  it('keeps performance completion attributes on the private panel article only', () => {
    const wrapper = mountCompletionPanel(preview(`preview:sha256:${'3'.repeat(64)}`))

    expect(wrapper.findAll('[data-preview-source-identity]')).toHaveLength(1)
    expect(wrapper.get('.article-private-preview-panel')
      .attributes('data-preview-source-identity')).toBeUndefined()
    expect(wrapper.get('[data-preview-markdown]')
      .attributes('data-preview-source-identity')).toBeUndefined()
  })
})
