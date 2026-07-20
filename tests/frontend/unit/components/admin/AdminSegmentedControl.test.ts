// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AdminSegmentedControl from '@/components/admin/AdminSegmentedControl.vue'

const items = [
  { label: '全部文章', value: 'all' },
  { label: '已发布', value: 'published' },
  { label: '草稿', value: 'draft' }
] as const

const mountControl = (props: Record<string, unknown> = {}) => mount(AdminSegmentedControl, {
  props: {
    ariaLabel: '文章状态',
    items,
    modelValue: 'published',
    ...props
  }
})

const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (hex: string): number => {
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255)
    return channels
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  }

  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('AdminSegmentedControl', () => {
  it('uses the flat Ink-on-Paper active treatment without a shadow', () => {
    const wrapper = mountControl()
    const buttons = wrapper.findAll('button')
    const active = buttons[1]

    expect(active.attributes('aria-pressed')).toBe('true')
    expect(active.classes()).toContain('bg-[var(--fsusblog-text-primary)]')
    expect(active.classes()).toContain('text-[var(--fsusblog-page-bg)]')
    expect(active.classes()).not.toContain('shadow-sm')
    expect(wrapper.html()).not.toContain('shadow-')
    expect(buttons[0].classes()).toContain('text-[var(--fsusblog-text-muted)]')
  })

  it('keeps its group semantics, selection event, and 40px controls', async () => {
    const wrapper = mountControl()
    const group = wrapper.get('[role="group"]')
    const buttons = wrapper.findAll('button')

    expect(group.attributes('aria-label')).toBe('文章状态')
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => button.classes().includes('min-h-10'))).toBe(true)
    expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual(['false', 'true', 'false'])

    await buttons[2].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['draft']])
  })

  it('preserves the disabled state', async () => {
    const wrapper = mountControl({ disabled: true })
    const buttons = wrapper.findAll('button')

    expect(buttons.every((button) => button.attributes('disabled') === '')).toBe(true)
    expect(buttons.every((button) => button.classes().includes('cursor-not-allowed'))).toBe(true)
    expect(buttons.every((button) => button.classes().includes('opacity-55'))).toBe(true)

    await buttons[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('retains wrapping geometry at a 375px viewport', () => {
    window.innerWidth = 375
    window.dispatchEvent(new Event('resize'))
    const wrapper = mountControl()

    expect(wrapper.get('[role="group"]').classes()).toEqual(expect.arrayContaining([
      'inline-flex',
      'max-w-full',
      'flex-wrap'
    ]))
    expect(wrapper.findAll('button').every((button) => button.classes().includes('px-2'))).toBe(true)
  })

  it('keeps the Ink-on-Paper token pairs above WCAG AA contrast', () => {
    expect(contrastRatio('#0F0F11', '#F7F7F8')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#F0F0F4', '#09090B')).toBeGreaterThanOrEqual(4.5)
  })
})
