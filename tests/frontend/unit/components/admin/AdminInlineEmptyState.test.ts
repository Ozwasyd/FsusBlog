// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'

import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'

describe('AdminInlineEmptyState', () => {
  it('keeps inline semantics and forwards the content fallback', () => {
    const wrapper = mount(AdminInlineEmptyState, {
      props: {
        title: '暂无文章',
        content: '调整筛选条件后重试。'
      },
      slots: {
        actions: '<button>清除筛选</button>'
      }
    })

    const root = wrapper.get('.admin-inline-empty-state')
    expect(root.attributes('role')).toBe('status')
    expect(root.attributes('aria-live')).toBe('polite')
    expect(root.classes()).toContain('el-empty-state--inline')
    expect(root.get('.el-empty-state__title').text()).toBe('暂无文章')
    expect(root.get('.el-empty-state__description').text()).toBe('调整筛选条件后重试。')
    expect(root.get('.admin-inline-empty-state__actions button').text()).toBe('清除筛选')
  })

  it('switches neutral, loading and error announcements without losing content', async () => {
    const wrapper = mount(AdminInlineEmptyState, {
      props: {
        title: '正在读取审核队列',
        state: 'neutral'
      }
    })
    const root = wrapper.get('.admin-inline-empty-state')

    expect(root.attributes('data-state')).toBe('neutral')
    expect(root.attributes('role')).toBe('status')
    expect(root.attributes('aria-live')).toBe('polite')
    expect(root.attributes('aria-busy')).toBeUndefined()
    expect(root.get('.el-empty-state__title').text()).toBe('正在读取审核队列')
    expect(root.find('.el-empty-state__description').exists()).toBe(false)

    await wrapper.setProps({ state: 'loading' })
    expect(root.attributes('data-state')).toBe('loading')
    expect(root.attributes('role')).toBe('status')
    expect(root.attributes('aria-live')).toBe('polite')
    expect(root.attributes('aria-busy')).toBe('true')

    await wrapper.setProps({
      state: 'error',
      title: '审核队列读取失败',
      description: '请稍后重试。'
    })
    expect(root.attributes('data-state')).toBe('error')
    expect(root.attributes('role')).toBe('alert')
    expect(root.attributes('aria-live')).toBe('assertive')
    expect(root.attributes('aria-busy')).toBeUndefined()
    expect(root.get('.el-empty-state__title').text()).toBe('审核队列读取失败')
    expect(root.get('.el-empty-state__description').text()).toBe('请稍后重试。')
  })

  it('preserves primary and secondary action conditions supplied through the action slot', async () => {
    const showActions = ref(true)
    const primaryDisabled = ref(true)
    const Harness = defineComponent({
      setup: () => () => h(AdminInlineEmptyState, {
        title: '暂无文章'
      }, {
        actions: () => showActions.value
          ? [
              h('button', { type: 'button' }, '清除筛选'),
              h('button', { type: 'button', disabled: primaryDisabled.value }, '写新文章')
            ]
          : undefined
      })
    })
    const wrapper = mount(Harness)

    const actions = wrapper.get('.admin-inline-empty-state__actions')
    expect(actions.get('button:first-child').text()).toBe('清除筛选')
    expect(actions.get('button:last-child').attributes('disabled')).toBeDefined()

    primaryDisabled.value = false
    await nextTick()
    expect(actions.get('button:last-child').attributes('disabled')).toBeUndefined()

    showActions.value = false
    await nextTick()
    expect(wrapper.find('.admin-inline-empty-state__actions').exists()).toBe(false)
  })
})
