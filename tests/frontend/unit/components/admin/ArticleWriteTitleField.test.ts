// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { ElFormItem, ElInput } from '@ozwasyd/element-plus'
import { describe, expect, it } from 'vitest'

import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'

describe('ArticleWriteTitleField', () => {
  it('delegates editor title presentation to the public FsusUI textarea variant', async () => {
    const wrapper = mount(ArticleWriteTitleField, {
      global: {
        components: {
          ElFormItem,
          ElInput,
        },
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

    await textarea.setValue('由公共 variant 承载的标题')
    expect(wrapper.emitted('update:modelValue')).toEqual([
      ['由公共 variant 承载的标题'],
    ])

    wrapper.unmount()
  })
})
