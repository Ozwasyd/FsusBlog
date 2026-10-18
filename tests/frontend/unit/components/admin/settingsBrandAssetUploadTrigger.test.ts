// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElUpload } from '@ozwasyd/element-plus'

import BrandAssetUploadField from '@/components/admin/settings/BrandAssetUploadField.vue'
import {
  assertSingleActivationOwner,
  fsusUiSourceMode,
  inspectSettingsUploadSurface
} from '../../../support/settingsBrandUploadTriggerDom'

const PREVIEW_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const fsusUiMode = fsusUiSourceMode()

const mocks = vi.hoisted(() => ({
  getAdminPageData: vi.fn(),
  updatePageData: vi.fn(),
  refreshPageData: vi.fn(),
  getAdminSiteConfig: vi.fn(),
  updateAdminSiteConfig: vi.fn(),
  getAdminSiteComplianceConfig: vi.fn(),
  updateAdminSiteComplianceConfig: vi.fn()
}))

vi.mock('@/api/system', () => ({
  getAdminPageData: mocks.getAdminPageData,
  updatePageData: mocks.updatePageData,
  refreshPageData: mocks.refreshPageData,
  getAdminSiteConfig: mocks.getAdminSiteConfig,
  updateAdminSiteConfig: mocks.updateAdminSiteConfig,
  getAdminSiteComplianceConfig: mocks.getAdminSiteComplianceConfig,
  updateAdminSiteComplianceConfig: mocks.updateAdminSiteComplianceConfig,
  deleteImage: vi.fn()
}))

vi.mock('@/store/admin', () => ({
  useAdminStore: () => ({
    setPageTitle: vi.fn()
  })
}))

vi.mock('@/composables/useImageUploadPreferences', () => ({
  useImageUploadPreferences: () => ({
    options: {},
    wasmOnlyMode: { value: false },
    setOptions: vi.fn(),
    setWasmOnlyMode: vi.fn()
  })
}))

vi.mock('@/composables/useImageUploadFlow', () => ({
  useImageUploadFlow: () => ({
    run: vi.fn(),
    cancel: vi.fn()
  })
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn()
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: vi.fn().mockReturnValue({ close: vi.fn() }),
    error: vi.fn().mockReturnValue({ close: vi.fn() }),
    info: vi.fn().mockReturnValue({ close: vi.fn() }),
    warning: vi.fn().mockReturnValue({ close: vi.fn() }),
    loading: vi.fn().mockReturnValue({ close: vi.fn() })
  },
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  confirmWarning: vi.fn().mockResolvedValue({ kind: 'cancelled' })
}))

const passthroughStub = (tag: string) => defineComponent({
  inheritAttrs: false,
  template: `<${tag} v-bind="$attrs"><slot /><slot name="title" /><slot name="actions" /><slot name="footer" /><slot name="prepend" /></${tag}>`
})

function surfaceOf(wrapper: VueWrapper, name: string): Element {
  const selector = `[data-settings-upload-surface="${name}"]`
  if (wrapper.element instanceof Element && wrapper.element.matches(selector)) {
    return wrapper.element
  }
  const node = wrapper.element.querySelector(selector)
  if (!node) {
    throw new Error(`missing upload surface ${name}`)
  }
  return node
}

function mountFsusUi<T>(component: T, options: Parameters<typeof mount<T>>[1] = {}) {
  return mount<T>(component, {
    attachTo: document.body,
    global: {
      components: { ElUpload },
      directives: { loading: () => undefined },
      stubs: {
        ElFormItem: passthroughStub('div'),
        ElInput: defineComponent({
          inheritAttrs: false,
          template: '<input v-bind="$attrs" />'
        }),
        ElIcon: passthroughStub('span'),
        ElButton: defineComponent({
          inheritAttrs: false,
          props: {
            disabled: { type: Boolean, default: false },
            loading: { type: Boolean, default: false }
          },
          template: '<button type="button" :disabled="disabled || loading" v-bind="$attrs"><slot /></button>'
        }),
        ElTabs: passthroughStub('div'),
        ElTabPane: passthroughStub('div'),
        ElForm: passthroughStub('form'),
        ElSwitch: defineComponent({ template: '<input type="checkbox" />' }),
        ElSelect: passthroughStub('select'),
        ElOption: passthroughStub('option'),
        ElRadioGroup: passthroughStub('div'),
        ElRadioButton: passthroughStub('button'),
        ElInputNumber: defineComponent({ template: '<input type="number" />' }),
        FsusUiTaskPageHeader: passthroughStub('header'),
        FsusDialog: passthroughStub('div'),
        SettingsPageEditor: passthroughStub('div'),
        ImageUploadOptionsPanel: passthroughStub('div')
      },
      ...(options.global ?? {})
    },
    ...options
  })
}

describe(`settings brand upload trigger contract (${fsusUiMode} FsusUI)`, () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('probes the public FsusUI Upload trigger as a single activation owner', () => {
    const legal = mountFsusUi(defineComponent({
      setup: () => () => h(ElUpload, {
        action: '#',
        showFileList: false,
        'data-settings-upload-surface': 'probe-legal',
        'data-upload-state': 'empty'
      }, () => h('span', '选择文件'))
    }))
    const legalReport = inspectSettingsUploadSurface(surfaceOf(legal, 'probe-legal'))
    expect(legalReport.activationOwners).toBe(1)
    expect(legalReport.tabbableOwners).toBe(1)
    expect(legalReport.nativeButtons).toBe(0)
    expect(legalReport.nestedInteractive).toBe(0)
    expect(legalReport.accessibleName).toContain('选择文件')
    assertSingleActivationOwner(legalReport)
    legal.unmount()

    const nested = mountFsusUi(defineComponent({
      setup: () => () => h(ElUpload, {
        action: '#',
        showFileList: false,
        'data-settings-upload-surface': 'probe-nested',
        'data-upload-state': 'empty'
      }, () => h('button', { type: 'button' }, '选择文件'))
    }))
    const nestedReport = inspectSettingsUploadSurface(surfaceOf(nested, 'probe-nested'))
    expect(nestedReport.nativeButtons).toBe(1)
    expect(nestedReport.nestedInteractive).toBeGreaterThan(0)
    expect(nestedReport.tabbableOwners).toBeGreaterThan(1)
    expect(() => assertSingleActivationOwner(nestedReport)).toThrow(/native button|nested interactive|one tab stop/u)
    nested.unmount()
  })

  it('keeps BrandAssetUploadField empty, preview, failed, disabled and uploading on one owner', async () => {
    const wrapper = mountFsusUi(BrandAssetUploadField, {
      props: {
        label: '站点 Logo',
        modelValue: '',
        targetField: 'siteLogoUrl',
        uploadText: '上传 Logo'
      }
    })

    const empty = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    expect(empty.state).toBe('empty')
    expect(empty.accessibleName).toContain('上传 Logo')
    assertSingleActivationOwner(empty)

    await wrapper.setProps({ previewUrl: PREVIEW_PNG })
    await nextTick()
    const image = wrapper.get('img')
    image.element.dispatchEvent(new Event('load'))
    await nextTick()
    const preview = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    expect(preview.state).toBe('preview')
    expect(preview.accessibleName).toMatch(/预览/)
    expect(preview.accessibleName).toMatch(/点击更换/)
    assertSingleActivationOwner(preview)

    image.element.dispatchEvent(new Event('error'))
    await nextTick()
    const failed = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    expect(failed.state).toBe('preview-failed')
    expect(failed.accessibleName).toMatch(/预览加载失败/)
    expect(wrapper.get('[role="status"]').text()).toContain('预览加载失败')
    assertSingleActivationOwner(failed)

    await wrapper.setProps({ previewUrl: '', disabled: true })
    await nextTick()
    const disabled = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    expect(disabled.state).toBe('disabled')
    assertSingleActivationOwner(disabled)

    await wrapper.setProps({ disabled: false, uploading: true })
    await nextTick()
    const uploading = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    expect(uploading.state).toBe('uploading')
    expect(wrapper.get('[role="status"]').text()).toContain('正在上传')
    assertSingleActivationOwner(uploading)
    wrapper.unmount()
  })

  it('keeps Settings social preview and icon-set generation on one activation owner', async () => {
    mocks.getAdminPageData.mockResolvedValue({
      slug: 'about',
      content: 'About',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })
    mocks.getAdminSiteConfig.mockResolvedValue({
      title: 'FsusBlog',
      ogImage: ''
    })
    mocks.getAdminSiteComplianceConfig.mockResolvedValue({})

    const Settings = (await import('@/views/admin/Settings.vue')).default
    const wrapper = mountFsusUi(Settings)
    await flushPromises()
    await nextTick()

    const ogImage = inspectSettingsUploadSurface(surfaceOf(wrapper, 'og-image'))
    expect(['empty', 'preview', 'preview-loading']).toContain(ogImage.state)
    expect(ogImage.accessibleName.length).toBeGreaterThan(0)
    assertSingleActivationOwner(ogImage)

    const iconSet = inspectSettingsUploadSurface(surfaceOf(wrapper, 'icon-set'))
    expect(iconSet.accessibleName).toContain('从图片生成图标组')
    assertSingleActivationOwner(iconSet)

    const brand = inspectSettingsUploadSurface(surfaceOf(wrapper, 'brand:siteLogoUrl'))
    assertSingleActivationOwner(brand)
    wrapper.unmount()
  })
})
