// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
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
})
