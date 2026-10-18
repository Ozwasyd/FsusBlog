// @vitest-environment happy-dom

import { DOMWrapper, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'

const ElFormItemStub = defineComponent({
  name: 'ElFormItem',
  props: {
    prop: {
      type: String,
      default: ''
    }
  },
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  }
})

const ElInputStub = defineComponent({
  name: 'ElInput',
  props: {
    modelValue: {
      type: String,
      default: ''
    },
    label: {
      type: String,
      default: ''
    },
    name: {
      type: String,
      default: ''
    },
    type: {
      type: String,
      default: 'text'
    },
    textareaVariant: {
      type: String,
      default: ''
    },
    autosize: {
      type: [Boolean, Object],
      default: false
    },
    maxlength: {
      type: [Number, String],
      default: undefined
    }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', { 'data-textarea-variant': props.textareaVariant }, [
      h('textarea', {
        'aria-label': props.label,
        name: props.name,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
      })
    ])
  }
})

describe('ArticleWriteTitleField', () => {
  it('delegates editor title presentation to the public FsusUI textarea variant', async () => {
    const wrapper = mount(ArticleWriteTitleField, {
      global: {
        stubs: {
          ElFormItem: ElFormItemStub,
          ElInput: ElInputStub
        }
      },
      props: {
        modelValue: '',
      },
    })

    const textareaRoot = wrapper.find('[data-textarea-variant="editor-title"]')
    const textarea = wrapper.get('textarea')

    expect(textareaRoot.exists()).toBe(true)
    expect(textarea.attributes('aria-label')).toBe('文章标题')
    expect(textareaRoot.attributes('style')).toBeUndefined()
    expect(wrapper.getComponent(ElInputStub).props('autosize')).toEqual({ minRows: 1, maxRows: 5 })
    expect(Number(wrapper.getComponent(ElInputStub).props('maxlength'))).toBe(100)

    await textarea.setValue('由公共 variant 承载的标题')
    expect(wrapper.emitted('update:modelValue')).toEqual([
      ['由公共 variant 承载的标题'],
    ])

    wrapper.unmount()
  })

  it('lets a long title wrap inside the editor title field instead of clipping', () => {
    const wrapper = mount(ArticleWriteTitleField, {
      global: {
        stubs: {
          ElFormItem: ElFormItemStub,
          ElInput: ElInputStub
        }
      },
      props: {
        modelValue: '从一次真实故障复盘中整理可验证的工程决策，并让标题在编辑列内自然换行',
      },
    })

    const titleField = new DOMWrapper(wrapper.get('.write-title-field').element)
    expect(titleField.exists()).toBe(true)
    expect(wrapper.getComponent(ElInputStub).props('type')).toBe('textarea')
    expect(wrapper.getComponent(ElInputStub).props('autosize')).toEqual({ minRows: 1, maxRows: 5 })
    wrapper.unmount()
  })
})
