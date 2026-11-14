// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ElButton, ElFormItem, ElOption, ElSelect, ElSlider, ElSwitch } from '@ozwasyd/element-plus'
import { afterEach, describe, expect, it } from 'vitest'

import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import type { ImageCompressionOptions } from '@/api/upload'

const options: ImageCompressionOptions = {
  format: 'webp',
  quality: 80,
  scaleRatio: 0.8,
  maxEdge: 2048,
  preserveAlpha: true
}
const sliderCases = [
  { index: 0, key: 'quality', value: 81 },
  { index: 1, key: 'scaleRatio', value: 0.85 },
  { index: 2, key: 'maxEdge', value: 2112 }
] as const

let wrapper: VueWrapper | undefined

function mountPanel(props: Record<string, unknown> = {}) {
  wrapper = mount(ImageUploadOptionsPanel, {
    props: { options: { ...options }, ...props },
    global: { components: { ElButton, ElFormItem, ElOption, ElSelect, ElSlider, ElSwitch } }
  })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.replaceChildren()
})

describe('ImageUploadOptionsPanel', () => {
  it('keeps each public slider in single-value mode with its existing bounds and step', () => {
    const panel = mountPanel()
    const sliders = panel.findAllComponents(ElSlider)

    expect(sliders).toHaveLength(3)
    expect(sliders.map(slider => ({
      value: slider.props('modelValue'),
      min: slider.props('min'),
      max: slider.props('max'),
      step: slider.props('step'),
      range: slider.props('range'),
      showInput: slider.props('showInput')
    }))).toEqual([
      { value: 80, min: 1, max: 100, step: 1, range: false, showInput: true },
      { value: 0.8, min: 0.1, max: 1, step: 0.05, range: false, showInput: true },
      { value: 2048, min: 256, max: 4096, step: 64, range: false, showInput: true }
    ])
    expect(panel.emitted('update:options')).toBeUndefined()
  })

  it.each(sliderCases)('forwards a real public slider keyboard update for $key', async ({ index, key, value }) => {
    const panel = mountPanel()
    const slider = panel.findAllComponents(ElSlider)[index]!

    await slider.get('[tabindex="0"]').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()

    expect(panel.emitted('update:options')).toEqual([[{ [key]: value }]])
    expect(panel.props('options')).toEqual(options)
  })

  it.each(sliderCases)('ignores array payload shapes for $key and still accepts a scalar', async ({ index, key, value }) => {
    const panel = mountPanel()
    const slider = panel.findAllComponents(ElSlider)[index]!

    // Exercise the public event contract without replacing the real Slider.
    for (const payload of [[], [value], [value, value + 1]]) {
      slider.vm.$emit('update:modelValue', payload)
      await flushPromises()
      expect(panel.emitted('update:options')).toBeUndefined()
      expect(panel.props('options')).toEqual(options)
    }

    slider.vm.$emit('update:modelValue', value)
    await flushPromises()
    expect(panel.emitted('update:options')).toEqual([[{ [key]: value }]])
  })

  it('emits reset without changing options or switch values', async () => {
    const panel = mountPanel({ wasmOnly: true })
    await panel.getComponent(ElButton).trigger('click')

    expect(panel.emitted('reset')).toEqual([[]])
    expect(panel.emitted('update:options')).toBeUndefined()
    expect(panel.emitted('update:wasm-only')).toBeUndefined()
    expect(panel.props('options')).toEqual(options)
  })

  it('preserves alpha and WASM-only boolean switch updates', async () => {
    const panel = mountPanel()
    const switches = panel.findAllComponents(ElSwitch)

    expect(switches.map(control => control.props('modelValue'))).toEqual([true, false])
    for (const value of [false, true]) {
      switches[0]!.vm.$emit('update:modelValue', value)
      switches[1]!.vm.$emit('update:modelValue', value)
    }
    await flushPromises()

    expect(panel.emitted('update:options')).toEqual([[{ preserveAlpha: false }], [{ preserveAlpha: true }]])
    expect(panel.emitted('update:wasm-only')).toEqual([[false], [true]])
  })

  it.each([
    { index: 0, label: '透明通道 (Alpha Channel)' },
    { index: 1, label: 'WASM-only 模式' }
  ])('names the real public switch input with $label', ({ index, label }) => {
    const panel = mountPanel()
    const control = panel.findAllComponents(ElSwitch)[index]!

    expect(control.props('label')).toBe(label)
    expect(control.get('input[role="switch"]').attributes('aria-label')).toBe(label)
    expect(panel.emitted('update:options')).toBeUndefined()
    expect(panel.emitted('update:wasm-only')).toBeUndefined()
  })

  it('updates a pre-existing text-only status region with recovery buttons outside it', async () => {
    const panel = mountPanel()
    const status = panel.get('[role="status"]')
    const statusElement = status.element
    expect(status.text()).toBe('')
    expect(status.findAllComponents(ElButton)).toHaveLength(0)

    await panel.setProps({ statusText: '已暂停', canResume: true, canAbort: true })
    expect(panel.get('[role="status"]').element).toBe(statusElement)
    expect(status.text()).toBe('已暂停')
    expect(status.findAllComponents(ElButton)).toHaveLength(0)
    expect(panel.findAllComponents(ElButton).map(button => button.text())).toEqual(['重置', '继续上传', '中止上传'])

    await panel.setProps({ statusText: '正在上传' })
    expect(panel.findAll('[role="status"]')).toHaveLength(1)
    expect(panel.get('[role="status"]').element).toBe(statusElement)
    expect(panel.get('[role="status"]').text()).toBe('正在上传')
    expect(panel.findAll('[aria-live], [role="alert"]')).toHaveLength(0)
    expect(status.element.querySelector('[role="status"]')).toBeNull()
    expect(panel.emitted('update:options')).toBeUndefined()
    expect(panel.emitted('update:wasm-only')).toBeUndefined()

    await panel.setProps({ statusText: '' })
    expect(panel.get('[role="status"]').element).toBe(statusElement)
    expect(status.text()).toBe('')
  })

  it('defers announcements to the consumer without hiding visible status or recovery controls', async () => {
    const panel = mountPanel({ announceStatus: false, statusText: '已暂停', canResume: true, canAbort: true })
    expect(panel.findAll('[role="status"], [aria-live]')).toHaveLength(0)
    expect(panel.text()).toContain('已暂停')
    expect(panel.findAllComponents(ElButton).map(button => button.text())).toEqual(['重置', '继续上传', '中止上传'])

    await panel.setProps({ statusText: '正在上传' })
    expect(panel.findAll('[role="status"], [aria-live]')).toHaveLength(0)
    expect(panel.text()).toContain('正在上传')
    expect(panel.get('footer > div > span').attributes('aria-hidden')).toBeUndefined()
  })

  it('keeps Write summary as the sole upload announcement owner and Settings on the panel default', () => {
    const write = readFileSync(new URL('../../../../src/frontend/src/views/admin/article/Write.vue', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../../../../src/frontend/src/views/admin/Settings.vue', import.meta.url), 'utf8')
    const writePanels = write.match(/<ImageUploadOptionsPanel\b[^>]*>/g) ?? []
    const settingsPanels = settings.match(/<ImageUploadOptionsPanel\b[^>]*>/g) ?? []

    expect(writePanels).toHaveLength(1)
    expect(writePanels[0]).toContain(':announce-status="false"')
    expect(writePanels[0]).toContain(':status-text="imageUploadRuntime.statusText"')
    expect(write.match(/<span\b[^>]*aria-live="polite"[^>]*>\s*\{\{\s*imageUploadRuntime\.statusText\s*\}\}/g)).toHaveLength(1)
    expect(settingsPanels).toHaveLength(1)
    expect(settingsPanels[0]).not.toContain('announce-status')
    expect(settingsPanels[0]).toContain(':status-text="imageUploadRuntime.statusText"')
  })

  it('preserves supported format updates and rejects other formats', async () => {
    const panel = mountPanel()
    const select = panel.getComponent(ElSelect)
    expect(select.props('modelValue')).toBe('webp')
    for (const format of ['webp', 'avif', 'png', 'jpeg', 'gif', 'unsupported']) {
      select.vm.$emit('update:modelValue', format)
    }
    await flushPromises()

    expect(panel.emitted('update:options')).toEqual(
      ['webp', 'avif', 'png', 'jpeg', 'gif'].map(format => [{ format }])
    )
  })

  it('keeps optional status, preview, WASM mode and supported-format defaults', async () => {
    const panel = mountPanel()
    expect(panel.findAllComponents(ElButton)).toHaveLength(1)
    expect(panel.findAll('.preview-metric')).toHaveLength(0)
    expect(panel.text()).toContain('WASM 支持：png')
    expect(panel.findAllComponents(ElSwitch)[1]!.props('modelValue')).toBe(false)

    await panel.setProps({ wasmSupportedFormats: ['', 'avif'] })
    expect(panel.text()).toContain('WASM 支持：avif')
    await panel.setProps({ wasmSupportedFormats: [] })
    expect(panel.text()).toContain('WASM 支持：png')
  })

  it('preserves resume and abandon actions when their status controls are enabled', async () => {
    const panel = mountPanel({ statusText: '已暂停', canResume: true, canAbort: true })
    const buttons = panel.findAllComponents(ElButton)
    expect(buttons.map(button => button.text())).toEqual(['重置', '继续上传', '中止上传'])

    await buttons[1]!.trigger('click')
    await buttons[2]!.trigger('click')
    expect(panel.emitted('resume')).toEqual([[]])
    expect(panel.emitted('abandon')).toEqual([[]])
    expect(panel.emitted('update:options')).toBeUndefined()
  })
})
