// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminSettingsPage } from '@/composables/useAdminSettingsPage'

const mocks = vi.hoisted(() => ({
  getAdminPageData: vi.fn(),
  updatePageData: vi.fn(),
  refreshPageData: vi.fn(),
  getAdminSiteConfig: vi.fn(),
  updateAdminSiteConfig: vi.fn(),
  getAdminSiteComplianceConfig: vi.fn(),
  updateAdminSiteComplianceConfig: vi.fn(),
  toastSuccess: vi.fn(),
  showErrorToast: vi.fn()
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
    wasmOnlyMode: ref(false),
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
  showErrorToast: mocks.showErrorToast,
  showWarningToast: vi.fn()
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: mocks.toastSuccess.mockImplementation(() => ({ close: vi.fn() })),
    error: vi.fn().mockReturnValue({ close: vi.fn() }),
    info: vi.fn().mockReturnValue({ close: vi.fn() }),
    warning: vi.fn().mockReturnValue({ close: vi.fn() }),
    loading: vi.fn().mockReturnValue({ close: vi.fn() })
  },
  showErrorToast: mocks.showErrorToast,
  showWarningToast: vi.fn(),
  confirmWarning: vi.fn().mockResolvedValue(true)
}))

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: 'default' }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>'
})

const FsusDialogStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: '' }
  },
  emits: ['update:modelValue'],
  template: '<div v-if="modelValue" role="dialog" :aria-label="title" class="fsus-dialog"><slot /><slot name="footer" /></div>'
})

const ElTabsInteractiveStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: '<div><button class="activate-pages" @click="$emit(\'update:modelValue\', \'pages\')">页面编辑</button><slot /></div>'
})

const SettingsPageEditorInteractiveStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: '<button class="edit-page-content" @click="$emit(\'update:modelValue\', \'Dirty Content from mounted editor\')">修改内容</button>'
})

const ElRadioGroupInteractiveStub = defineComponent({
  props: { modelValue: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  template: '<button class="switch-page" :disabled="disabled" @click="$emit(\'update:modelValue\', modelValue === \'about\' ? \'privacy\' : \'about\')">切换页面</button>'
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function mountSettingsPage() {
  let settingsInstance: ReturnType<typeof useAdminSettingsPage> | null = null
  const TestComp = defineComponent({
    setup() {
      const settings = useAdminSettingsPage()
      settingsInstance = settings
      return settings
    },
    template: '<div></div>'
  })
  const wrapper = mount(TestComp)
  await flushPromises()
  return { wrapper, settings: settingsInstance! }
}

describe('useAdminSettingsPage dirty page switch state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAdminPageData.mockReset().mockImplementation((slug: string) => Promise.resolve({
      slug,
      content: `Content of ${slug}`,
      updatedAt: '2026-08-01T00:00:00.000Z'
    }))
    mocks.updatePageData.mockReset().mockResolvedValue({ success: true })
    mocks.refreshPageData.mockReset().mockResolvedValue({ success: true })
    mocks.getAdminSiteConfig.mockResolvedValue({ siteName: 'Test' })
    mocks.getAdminSiteComplianceConfig.mockResolvedValue({})
  })

  it('switches page directly without prompt when page content is clean', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    expect(settings.currentSlug.value).toBe('about')
    expect(settings.isPageDirty.value).toBe(false)
    expect(settings.pageContent.value).toBe('Content of about')

    await settings.requestPageSwitch('privacy')
    await flushPromises()

    expect(settings.currentSlug.value).toBe('privacy')
    expect(settings.pendingPageSwitchSlug.value).toBe('')
    expect(settings.pageContent.value).toBe('Content of privacy')
    wrapper.unmount()
  })

  it('requires user decision and opens prompt when attempting to switch away from dirty page', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    expect(settings.currentSlug.value).toBe('about')
    settings.pageContent.value = 'Edited About Content with dirty changes'
    expect(settings.isPageDirty.value).toBe(true)

    // Request switch to privacy
    await settings.requestPageSwitch('privacy')
    await flushPromises()

    // Does NOT immediately switch currentSlug
    expect(settings.currentSlug.value).toBe('about')
    expect(settings.pendingPageSwitchSlug.value).toBe('privacy')
    wrapper.unmount()
  })

  it('cancels pending switch on cancelPageSwitch leaving dirty content and slug intact', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'Edited Content'
    await settings.requestPageSwitch('friends')

    expect(settings.pendingPageSwitchSlug.value).toBe('friends')
    expect(settings.currentSlug.value).toBe('about')

    settings.cancelPageSwitch()

    expect(settings.pendingPageSwitchSlug.value).toBe('')
    expect(settings.currentSlug.value).toBe('about')
    expect(settings.isPageDirty.value).toBe(true)
    expect(settings.pageContent.value).toBe('Edited Content')
    wrapper.unmount()
  })

  it('discards dirty changes on discardPageChangesAndSwitch and completes switch to target slug', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'Edited Content to Discard'
    await settings.requestPageSwitch('privacy')

    expect(settings.pendingPageSwitchSlug.value).toBe('privacy')

    await settings.discardPageChangesAndSwitch()
    await flushPromises()

    expect(settings.pendingPageSwitchSlug.value).toBe('')
    expect(settings.currentSlug.value).toBe('privacy')
    expect(settings.pageContent.value).toBe('Content of privacy')
    expect(settings.isPageDirty.value).toBe(false)
    expect(mocks.updatePageData).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('saves dirty changes on savePageAndSwitch, refreshes cache, and switches to target slug on success', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'New Valid About Content'
    await settings.requestPageSwitch('privacy')

    expect(settings.pendingPageSwitchSlug.value).toBe('privacy')

    await settings.savePageAndSwitch()
    await flushPromises()

    expect(mocks.updatePageData).toHaveBeenCalledWith({
      slug: 'about',
      content: 'New Valid About Content'
    })
    expect(mocks.refreshPageData).toHaveBeenCalledWith('about')
    expect(settings.pendingPageSwitchSlug.value).toBe('')
    expect(settings.currentSlug.value).toBe('privacy')
    expect(settings.pageContent.value).toBe('Content of privacy')
    expect(settings.isPageDirty.value).toBe(false)
    wrapper.unmount()
  })

  it('aborts switch and preserves dirty state when savePageAndSwitch fails during save', async () => {
    mocks.updatePageData.mockRejectedValue(new Error('Network error saving page'))

    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'Dirty Content Failing Save'
    await settings.requestPageSwitch('friends')

    expect(settings.pendingPageSwitchSlug.value).toBe('friends')

    await settings.savePageAndSwitch()
    await flushPromises()

    // Must NOT clear pending slug or switch page
    expect(mocks.showErrorToast).toHaveBeenCalled()
    expect(settings.currentSlug.value).toBe('about')
    expect(settings.pendingPageSwitchSlug.value).toBe('friends')
    expect(settings.pageContent.value).toBe('Dirty Content Failing Save')
    expect(settings.isPageDirty.value).toBe(true)
    wrapper.unmount()
  })

  it('keeps the last rapid target when an older page load resolves late', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    const privacy = deferred<{ slug: string; content: string; updatedAt: string }>()
    const guidelines = deferred<{ slug: string; content: string; updatedAt: string }>()
    mocks.getAdminPageData.mockImplementation((slug: string) => {
      if (slug === 'privacy') return privacy.promise
      if (slug === 'guidelines') return guidelines.promise
      return Promise.resolve({ slug, content: `Content of ${slug}`, updatedAt: '2026-08-01T00:00:00.000Z' })
    })

    const privacySwitch = settings.requestPageSwitch('privacy')
    await nextTick()
    const guidelinesSwitch = settings.requestPageSwitch('guidelines')

    guidelines.resolve({ slug: 'guidelines', content: 'Authoritative C', updatedAt: '2026-08-03T00:00:00.000Z' })
    await guidelinesSwitch
    privacy.resolve({ slug: 'privacy', content: 'Late B', updatedAt: '2026-08-02T00:00:00.000Z' })
    await privacySwitch

    expect(settings.currentSlug.value).toBe('guidelines')
    expect(settings.pageContent.value).toBe('Authoritative C')
    expect(settings.isPageDirty.value).toBe(false)
    wrapper.unmount()
  })

  it('ignores a late page load after leaving the pages tab', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    const privacy = deferred<{ slug: string; content: string; updatedAt: string }>()
    mocks.getAdminPageData.mockImplementation((slug: string) => slug === 'privacy'
      ? privacy.promise
      : Promise.resolve({ slug, content: `Content of ${slug}`, updatedAt: '2026-08-01T00:00:00.000Z' }))

    const switchPromise = settings.requestPageSwitch('privacy')
    await nextTick()
    settings.activeTab.value = 'site'
    await nextTick()
    privacy.resolve({ slug: 'privacy', content: 'Late privacy', updatedAt: '2026-08-02T00:00:00.000Z' })
    await switchPromise

    expect(settings.currentSlug.value).toBe('about')
    expect(settings.pageContent.value).toBe('Content of about')
    wrapper.unmount()
  })

  it('uses the latest pending target after a late save succeeds without losing the saved source content', async () => {
    const update = deferred<{ success: boolean }>()
    mocks.updatePageData.mockReturnValue(update.promise)
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'Saved About Content'
    await settings.requestPageSwitch('privacy')
    const saveAndSwitch = settings.savePageAndSwitch()
    await nextTick()
    await settings.requestPageSwitch('guidelines')
    update.resolve({ success: true })
    await saveAndSwitch

    expect(mocks.updatePageData).toHaveBeenCalledWith({ slug: 'about', content: 'Saved About Content' })
    expect(mocks.refreshPageData).toHaveBeenCalledWith('about')
    expect(settings.currentSlug.value).toBe('guidelines')
    expect(settings.pageContent.value).toBe('Content of guidelines')
    expect(settings.pendingPageSwitchSlug.value).toBe('')
    wrapper.unmount()
  })

  it('treats a revision conflict as a failed save and preserves the dirty source page', async () => {
    mocks.updatePageData.mockRejectedValue(new Error('page_revision_conflict'))
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    settings.pageContent.value = 'Conflicting About Content'
    await settings.requestPageSwitch('privacy')
    await settings.savePageAndSwitch()

    expect(settings.currentSlug.value).toBe('about')
    expect(settings.pendingPageSwitchSlug.value).toBe('privacy')
    expect(settings.pageContent.value).toBe('Conflicting About Content')
    expect(settings.isPageDirty.value).toBe(true)
    expect(mocks.refreshPageData).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('prevents browser unload when page has dirty changes and allows unload when clean', async () => {
    const { wrapper, settings } = await mountSettingsPage()
    settings.activeTab.value = 'pages'
    await flushPromises()

    expect(settings.isPageDirty.value).toBe(false)

    const cleanEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    const cleanSpy = vi.spyOn(cleanEvent, 'preventDefault')

    // Clean state: beforeunload is NOT prevented
    window.dispatchEvent(cleanEvent)
    expect(cleanSpy).not.toHaveBeenCalled()

    // Dirty state: beforeunload IS prevented
    settings.pageContent.value = 'Dirty Unsaved Content'
    expect(settings.isPageDirty.value).toBe(true)

    const dirtyEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    const dirtySpy = vi.spyOn(dirtyEvent, 'preventDefault')

    window.dispatchEvent(dirtyEvent)
    expect(dirtySpy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('mounts Settings.vue and wires accessible cancel, discard, and save decisions to their owners', async () => {
    const Settings = (await import('@/views/admin/Settings.vue')).default

    const wrapper = mount(Settings, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          FsusDialog: FsusDialogStub,
          ElTabs: ElTabsInteractiveStub,
          ElTabPane: defineComponent({ template: '<div><slot /></div>' }),
          ElForm: defineComponent({ template: '<form><slot /></form>' }),
          ElFormItem: defineComponent({ template: '<div><slot /></div>' }),
          ElInput: defineComponent({ template: '<input />' }),
          ElSwitch: defineComponent({ template: '<input type="checkbox" />' }),
          ElSelect: defineComponent({ template: '<select><slot /></select>' }),
          ElOption: defineComponent({ template: '<option><slot /></option>' }),
          ElRadioGroup: ElRadioGroupInteractiveStub,
          ElRadioButton: defineComponent({ template: '<button><slot /></button>' }),
          ElIcon: defineComponent({ template: '<span><slot /></span>' }),
          ElUpload: defineComponent({ template: '<div><slot /></div>' }),
          ElInputNumber: defineComponent({ template: '<input type="number" />' }),
          FsusUiTaskPageHeader: defineComponent({ template: '<header><slot name="title" /><slot name="actions" /></header>' }),
          SettingsPageEditor: SettingsPageEditorInteractiveStub,
          BrandAssetUploadField: defineComponent({ template: '<div />' }),
          ImageUploadOptionsPanel: defineComponent({ template: '<div />' })
        },
        directives: {
          loading: () => {}
        }
      }
    })

    await flushPromises()
    await wrapper.get('.activate-pages').trigger('click')
    await flushPromises()
    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)

    await wrapper.get('.edit-page-content').trigger('click')
    await wrapper.get('.switch-page').trigger('click')
    let dialog = wrapper.get('[role="dialog"][aria-label="当前页面有未发布修改"]')
    let decisionButtons = dialog.findAll('button')
    expect(decisionButtons.map((button) => button.text())).toEqual(['取消', '放弃修改', '保存并切换'])
    await decisionButtons[0]!.trigger('click')
    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)
    expect(mocks.updatePageData).not.toHaveBeenCalled()

    await wrapper.get('.switch-page').trigger('click')
    dialog = wrapper.get('[role="dialog"][aria-label="当前页面有未发布修改"]')
    decisionButtons = dialog.findAll('button')
    await decisionButtons[1]!.trigger('click')
    await flushPromises()
    expect(mocks.updatePageData).not.toHaveBeenCalled()
    expect(mocks.getAdminPageData).toHaveBeenCalledWith('privacy', expect.any(Object))

    await wrapper.get('.edit-page-content').trigger('click')
    await wrapper.get('.switch-page').trigger('click')
    const update = deferred<{ success: boolean }>()
    mocks.updatePageData.mockReturnValueOnce(update.promise)
    dialog = wrapper.get('[role="dialog"][aria-label="当前页面有未发布修改"]')
    decisionButtons = dialog.findAll('button')
    await decisionButtons[2]!.trigger('click')
    await nextTick()
    expect(decisionButtons.every((button) => button.attributes('disabled') !== undefined)).toBe(true)
    update.resolve({ success: true })
    await flushPromises()

    expect(mocks.updatePageData).toHaveBeenCalledWith({
      slug: 'privacy',
      content: 'Dirty Content from mounted editor'
    })
    expect(mocks.getAdminPageData).toHaveBeenCalledWith('about', expect.any(Object))
    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)
    wrapper.unmount()
  })
})
