// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CollectionWorkbench from '@/components/admin/CollectionWorkbench.vue'

const mountWorkbench = (selectedCount = 0, state = 'ready') => mount(CollectionWorkbench, {
  props: {
    title: '审核队列',
    titleId: 'fixture-title',
    selectedCount,
    state: state as 'ready' | 'loading' | 'empty' | 'error'
  },
  slots: {
    'primary-filter': '<button data-fixture="filter">筛选</button>',
    'selection-actions': '<button data-fixture="bulk">批量通过</button>',
    results: '<div data-fixture="results">rows</div>',
    loading: '<div data-fixture="loading">loading</div>',
    empty: '<div data-fixture="empty">empty</div>',
    error: '<div data-fixture="error">error</div>',
    pagination: '<button data-fixture="next">下一页</button>'
  }
})

describe('CollectionWorkbench', () => {
  it('removes selection actions from layout and tab order until rows are selected', () => {
    expect(mountWorkbench(0).find('[data-workbench-region="selection-actions"]').exists()).toBe(false)
    expect(mountWorkbench(1).find('[data-fixture="bulk"]').exists()).toBe(true)
  })

  it.each(['loading', 'empty', 'error', 'ready'] as const)('renders only the %s result state', (state) => {
    const wrapper = mountWorkbench(0, state)
    const visible = ['loading', 'empty', 'error', 'results'].filter((name) =>
      wrapper.find(`[data-fixture="${name}"]`).exists())
    expect(visible).toEqual([state === 'ready' ? 'results' : state])
    expect(wrapper.find('[data-fixture="next"]').exists()).toBe(state === 'ready')
  })

  it('preserves the fixed semantic region order', () => {
    const regions = mountWorkbench(1).findAll('[data-workbench-region]').map((node) =>
      node.attributes('data-workbench-region'))
    expect(regions).toEqual(['summary', 'primary-filter', 'selection-actions', 'results', 'pagination'])
  })
})
