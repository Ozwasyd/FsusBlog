// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  FsusUiSegmentedControl,
  type FsusUiSegmentedControlItem,
  type FsusUiSegmentedControlValue
} from '@/fsusui/segmentedControl'

const ALL_ARTICLES = 'all'
const longLabel = '已发布并完成公开索引与跨区域缓存同步的文章'
const baseItems = [
  { label: '全部', value: ALL_ARTICLES },
  { label: '草稿', value: 0 },
  { label: '定时', value: 1 },
  { label: longLabel, value: 2 },
  { label: '归档', value: 3 }
] satisfies readonly FsusUiSegmentedControlItem[]

const ConsumerHarness = defineComponent({
  name: 'AdminArticleSegmentedConsumerHarness',
  props: {
    busy: Boolean
  },
  emits: {
    status: (_value: number | undefined) => true
  },
  setup(props, { emit }) {
    const selected = ref<FsusUiSegmentedControlValue>(ALL_ARTICLES)
    const items = computed<FsusUiSegmentedControlItem[]>(() =>
      baseItems.map((item) => ({ ...item, disabled: props.busy }))
    )
    const update = (value: FsusUiSegmentedControlValue): void => {
      selected.value = value
      emit('status', typeof value === 'number' ? value : undefined)
    }

    return () => h(FsusUiSegmentedControl, {
      ariaLabel: '文章状态筛选',
      modelValue: selected.value,
      items: items.value,
      'onUpdate:modelValue': update
    })
  }
})

describe('admin article direct FsusUI segmented consumer contract (#1888)', () => {
  it('keeps option order, long labels, radio selection and business status values', async () => {
    const wrapper = mount(ConsumerHarness)
    const group = wrapper.get('[role="radiogroup"]')
    const radios = wrapper.findAll('[role="radio"]')

    expect(group.attributes('aria-label')).toBe('文章状态筛选')
    expect(radios.map((radio) => radio.text())).toEqual(baseItems.map((item) => item.label))
    expect(radios[0].attributes('aria-checked')).toBe('true')
    expect(radios[3].text()).toBe(longLabel)

    await radios[3].trigger('click')
    await nextTick()

    expect(wrapper.emitted('status')).toEqual([[2]])
    expect(wrapper.findAll('[role="radio"]')[3].attributes('aria-checked')).toBe('true')

    await wrapper.findAll('[role="radio"]')[0].trigger('click')
    expect(wrapper.emitted('status')?.at(-1)).toEqual([undefined])
  })

  it('delegates Arrow/Home/End keyboard behavior to the public control', async () => {
    const wrapper = mount(ConsumerHarness)
    const first = wrapper.findAll('[role="radio"]')[0]

    await first.trigger('keydown', { key: 'End' })
    await nextTick()
    expect(wrapper.emitted('status')?.at(-1)).toEqual([3])
    expect(wrapper.findAll('[role="radio"]')[4].attributes('tabindex')).toBe('0')

    await wrapper.findAll('[role="radio"]')[4].trigger('keydown', { key: 'Home' })
    await nextTick()
    expect(wrapper.emitted('status')?.at(-1)).toEqual([undefined])

    await wrapper.findAll('[role="radio"]')[0].trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('status')?.at(-1)).toEqual([0])
  })

  it('maps the consumer busy state to every typed item without a compatibility wrapper', () => {
    const wrapper = mount(ConsumerHarness, { props: { busy: true } })
    const radios = wrapper.findAll('[role="radio"]')

    expect(radios).toHaveLength(baseItems.length)
    expect(radios.every((radio) => radio.attributes('disabled') === '')).toBe(true)
    expect(wrapper.findComponent(FsusUiSegmentedControl).exists()).toBe(true)
  })

  it.each(['light', 'dark'])('keeps the same public semantics in %s at 375px and 200%% zoom', (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    window.innerWidth = 375
    document.documentElement.style.setProperty('zoom', '2')
    window.dispatchEvent(new Event('resize'))

    const wrapper = mount(ConsumerHarness)
    expect(wrapper.get('[role="radiogroup"]').classes()).toContain('el-segmented-control')
    expect(wrapper.findAll('[role="radio"]').map((radio) => radio.text())).toEqual(baseItems.map((item) => item.label))

    wrapper.unmount()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.removeProperty('zoom')
  })
})
