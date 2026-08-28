// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import FilterHeader from '@/components/filter/FilterHeader.vue'
import type { FilterHeaderViewContract } from '@/view-contracts/filterView'

const createHeaderView = (overrides: Partial<FilterHeaderViewContract> = {}): FilterHeaderViewContract => ({
  labelText: '分类',
  currentName: '架构设计',
  description: null,
  loadingMeta: false,
  ...overrides
})

const global = {
  stubs: {
    ElSkeleton: { template: '<div class="el-skeleton"><slot name="template" /><slot /></div>' },
    ElSkeletonItem: { template: '<div class="el-skeleton-item" />' }
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('FilterHeader', () => {
  it('renders label and title without description when description is null', () => {
    const wrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({ description: null })
      },
      global
    })

    expect(wrapper.find('h1').text()).toBe('架构设计')
    expect(wrapper.text()).toContain('分类')
    expect(wrapper.find('p.mt-4').exists()).toBe(false)
    const paragraphs = wrapper.findAll('p')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0].text()).toBe('分类')

    wrapper.unmount()
  })

  it('does not render description when description is empty or whitespace-only', () => {
    const emptyWrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({ description: '' })
      },
      global
    })
    expect(emptyWrapper.findAll('p')).toHaveLength(1)
    expect(emptyWrapper.find('p.mt-4').exists()).toBe(false)
    emptyWrapper.unmount()

    const whitespaceWrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({ description: '   \t  \n  ' })
      },
      global
    })
    expect(whitespaceWrapper.findAll('p')).toHaveLength(1)
    expect(whitespaceWrapper.find('p.mt-4').exists()).toBe(false)
    whitespaceWrapper.unmount()
  })

  it('renders secondary body description text below h1 when non-empty', () => {
    const wrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({
          description: '关于高并发、分布式架构与工程实践的精选文章'
        })
      },
      global
    })

    const h1 = wrapper.get('h1')
    expect(h1.text()).toBe('架构设计')

    const desc = wrapper.get('p.mt-4')
    expect(desc.text()).toBe('关于高并发、分布式架构与工程实践的精选文章')
    expect(desc.classes()).toContain('text-sm')
    expect(desc.classes()).toContain('font-normal')
    expect(desc.classes()).toContain('leading-6')
    expect(desc.classes()).toContain('text-[var(--fsusblog-text-muted)]')

    wrapper.unmount()
  })

  it('trims whitespace when rendering description', () => {
    const wrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({
          description: '   前后带有空格的描述文本   '
        })
      },
      global
    })

    const desc = wrapper.get('p.mt-4')
    expect(desc.text()).toBe('前后带有空格的描述文本')

    wrapper.unmount()
  })

  it('renders description markup as plain text', () => {
    const wrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({
          description: '<strong>架构设计</strong>'
        })
      },
      global
    })

    const desc = wrapper.get('p.mt-4')
    expect(desc.text()).toBe('<strong>架构设计</strong>')
    expect(desc.find('strong').exists()).toBe(false)

    wrapper.unmount()
  })

  it('renders skeleton and no title or description when loadingMeta is true', () => {
    const wrapper = mount(FilterHeader, {
      props: {
        view: createHeaderView({
          loadingMeta: true,
          description: '加载中不应显示的描述'
        })
      },
      global
    })

    expect(wrapper.find('.fsusblog-skeleton-surface').exists()).toBe(true)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('p.mt-4').exists()).toBe(false)

    wrapper.unmount()
  })
})
