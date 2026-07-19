// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleReadingNotice from '@/components/article/ArticleReadingNotice.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('ArticleReadingNotice hierarchy', () => {
  it('keeps numeric answers as the only primary focal points', () => {
    const wrapper = mount(ArticleReadingNotice, {
      props: {
        notice: {
          visible: true,
          wordCount: 8432,
          readingMinutes: 34
        }
      }
    })

    expect(wrapper.get('section').attributes('aria-label')).toBe('长文阅读提示')
    expect(wrapper.text()).toContain('全文约 8,432 字')
    expect(wrapper.text()).toContain('预计阅读 34 分钟')

    const label = wrapper.get('section > div > span')
    expect(label.classes()).toContain('font-medium')
    expect(label.classes()).toContain('text-[var(--fsusblog-text-secondary)]')
    expect(label.classes()).not.toContain('text-[var(--fsusblog-text-primary)]')

    const details = wrapper.get('section > div > div')
    expect(details.classes()).toContain('font-normal')
    expect(details.classes()).toContain('text-[var(--fsusblog-text-secondary)]')

    const metrics = details.findAll('.font-bold')
    expect(metrics).toHaveLength(2)
    for (const metric of metrics) {
      expect(metric.classes()).toContain('tabular-nums')
      expect(metric.classes()).toContain('text-[var(--fsusblog-text-primary)]')
    }

    wrapper.unmount()
  })

  it('does not render the notice below the long-read threshold', () => {
    const wrapper = mount(ArticleReadingNotice, {
      props: {
        notice: {
          visible: false,
          wordCount: 1200,
          readingMinutes: 5
        }
      }
    })

    expect(wrapper.find('section').exists()).toBe(false)

    wrapper.unmount()
  })
})
