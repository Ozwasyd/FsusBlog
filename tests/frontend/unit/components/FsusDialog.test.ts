// @vitest-environment happy-dom

import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import FsusDialog from '@/components/ui/FsusDialog.vue'
import { fsusDialogWidths } from '@/fsusui/dialog'
import PolicyModal from '@/components/PolicyModal.vue'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import UserBanDialog from '@/components/admin/users/UserBanDialog.vue'
import { getPageData } from '@/api/system'
import { activateLocaleRuntime, resetLocaleRuntimeForTests } from '@/locales'

vi.mock('@/api/system', () => ({
  getPageData: vi.fn()
}))

vi.mock('@/fsusui/dialog', async () => {
  const actual = await vi.importActual<typeof import('@/fsusui/dialog')>('@/fsusui/dialog')
  const { defineComponent } = await import('vue')
  const FsusUiDialog = defineComponent({
    name: 'FsusUiDialogStub',
    props: {
      modelValue: { type: Boolean, default: false },
      title: { type: String, default: '' },
      width: { type: [String, Number], default: '' },
      destroyOnClose: { type: Boolean, default: false },
      closeOnClickModal: { type: Boolean, default: true },
      showClose: { type: Boolean, default: true },
      alignCenter: { type: Boolean, default: false },
      appendToBody: { type: Boolean, default: false },
      modalClass: { type: String, default: undefined }
    },
    emits: ['update:modelValue', 'close', 'closed', 'opened'],
    template: `
      <div
        v-if="modelValue"
        role="dialog"
        data-test="fsus-ui-dialog"
        :data-title="title"
        :data-width="String(width)"
        :data-destroy-on-close="String(destroyOnClose)"
        :data-close-on-click-modal="String(closeOnClickModal)"
        :data-show-close="String(showClose)"
        :data-align-center="String(alignCenter)"
        :data-append-to-body="String(appendToBody)"
        :data-modal-class="modalClass || ''"
        v-bind="$attrs"
      >
        <h2 data-test="dialog-title">{{ title }}</h2>
        <div data-test="dialog-body"><slot /></div>
        <footer v-if="$slots.footer" data-test="dialog-footer"><slot name="footer" /></footer>
        <button type="button" data-test="dialog-close" @click="$emit('close'); $emit('update:modelValue', false); $emit('closed')">close</button>
        <button type="button" data-test="dialog-opened" @click="$emit('opened')">opened</button>
      </div>
    `
  })
  return {
    ...actual,
    FsusUiDialog
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  vi.mocked(getPageData).mockReset()
  resetLocaleRuntimeForTests()
})

describe('FsusDialog shell (#1787)', () => {
  it('forwards workflow props/emits/slots without modal-class bridge', async () => {
    const onClose = vi.fn()
    const onClosed = vi.fn()
    const onOpened = vi.fn()
    const wrapper = mount(FsusDialog, {
      props: {
        modelValue: true,
        title: 'Confirm',
        width: fsusDialogWidths.compact,
        destroyOnClose: true,
        closeOnClickModal: false,
        showClose: false,
        'onUpdate:modelValue': (value: boolean) => wrapper.setProps({ modelValue: value }),
        onClose,
        onClosed,
        onOpened
      },
      slots: {
        default: '<p data-test="slot-body">body copy</p>',
        footer: '<button type="button" data-test="slot-footer-action">OK</button>'
      }
    })

    await nextTick()
    const dialog = wrapper.get('[data-test="fsus-ui-dialog"]')
    expect(dialog.attributes('data-title')).toBe('Confirm')
    expect(dialog.attributes('data-width')).toBe(fsusDialogWidths.compact)
    expect(dialog.attributes('data-destroy-on-close')).toBe('true')
    expect(dialog.attributes('data-close-on-click-modal')).toBe('false')
    expect(dialog.attributes('data-show-close')).toBe('false')
    expect(dialog.attributes('data-align-center')).toBe('true')
    expect(dialog.attributes('data-append-to-body')).toBe('true')
    expect(dialog.attributes('data-modal-class')).toBe('')
    expect(wrapper.get('[data-test="slot-body"]').text()).toBe('body copy')
    expect(wrapper.get('[data-test="slot-footer-action"]').text()).toBe('OK')
    expect(wrapper.find('.fsus-dialog__content').exists()).toBe(true)
    expect(wrapper.find('.fsus-dialog__footer').exists()).toBe(true)

    await wrapper.get('[data-test="dialog-opened"]').trigger('click')
    expect(onOpened).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-test="dialog-close"]').trigger('click')
    await flushPromises()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(wrapper.props('modelValue')).toBe(false)

    wrapper.unmount()
  })

  it('falls back illegal width literals to the default preset', async () => {
    const wrapper = mount(FsusDialog, {
      props: {
        modelValue: true,
        // @ts-expect-error intentional illegal width
        width: '40rem'
      }
    })
    await nextTick()
    expect(wrapper.get('[data-test="fsus-ui-dialog"]').attributes('data-width')).toBe(
      fsusDialogWidths.default
    )
    wrapper.unmount()
  })

  it('does not invent a second body scroll-lock owner', async () => {
    const overflowBefore = document.body.style.overflow
    const open = ref(true)
    const Host = defineComponent({
      components: { FsusDialog },
      setup() {
        return { open, width: fsusDialogWidths.compact }
      },
      template: `
        <FsusDialog v-model="open" title="Lock probe" :width="width">
          <button type="button" data-test="focus-target">focus me</button>
          <template #footer>
            <button type="button" data-test="footer-action">done</button>
          </template>
        </FsusDialog>
      `
    })

    const wrapper = mount(Host, { attachTo: document.body })
    await nextTick()
    const focusTarget = wrapper.get('[data-test="focus-target"]').element as HTMLButtonElement
    focusTarget.focus()
    expect(document.activeElement).toBe(focusTarget)
    expect(new DOMWrapper(wrapper.get('[data-test="footer-action"]').element).exists()).toBe(true)
    expect(document.body.style.overflow).toBe(overflowBefore)
    open.value = false
    await nextTick()
    wrapper.unmount()
  })
})

describe('representative workflow shells (#1787)', () => {
  const workflowDialogStub = defineComponent({
    props: {
      modelValue: { type: Boolean, default: false },
      title: { type: String, default: '' },
      width: { type: String, default: '' },
      destroyOnClose: { type: Boolean, default: false },
      closeOnClickModal: { type: Boolean, default: true },
      showClose: { type: Boolean, default: true },
      modalClass: { type: String, default: undefined }
    },
    emits: ['update:modelValue', 'closed', 'close', 'opened'],
    template: `
      <section
        v-if="modelValue"
        role="dialog"
        data-test="workflow-dialog"
        :class="$attrs.class"
        :data-title="title"
        :data-width="width"
        :data-destroy-on-close="String(destroyOnClose)"
        :data-close-on-click-modal="String(closeOnClickModal)"
        :data-show-close="String(showClose)"
        :data-modal-class="modalClass || ''"
      >
        <h2 data-test="dialog-title">{{ title }}</h2>
        <div data-test="dialog-body"><slot /></div>
        <footer v-if="$slots.footer" data-test="dialog-footer"><slot name="footer" /></footer>
        <button type="button" data-test="emit-closed" @click="$emit('closed'); $emit('update:modelValue', false)">x</button>
      </section>
    `
  })

  it('PolicyModal long-form shell wires close/footer without modal-class', async () => {
    vi.mocked(getPageData).mockResolvedValue({
      data: { content: 'Policy body' }
    } as never)

    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'auth', 'errors'])

    const wrapper = mount(PolicyModal, {
      props: { type: 'privacy', visible: true },
      global: {
        stubs: {
          FsusDialog: workflowDialogStub,
          MarkdownRenderer: true,
          ElButton: true,
          ElScrollbar: { template: '<div><slot /></div>' },
          ElSkeleton: true
        }
      }
    })

    await flushPromises()
    const dialog = wrapper.get('[data-test="workflow-dialog"]')
    expect(dialog.attributes('data-width')).toBe(fsusDialogWidths.longForm)
    expect(dialog.attributes('data-modal-class')).toBe('')
    expect(new DOMWrapper(wrapper.get('[data-test="dialog-footer"]').element).exists()).toBe(true)

    await wrapper.get('[data-test="emit-closed"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:visible')?.at(-1)?.[0]).toBe(false)
    wrapper.unmount()
  })

  it('MfaSetupModal compact shell keeps destroy-on-close and hides close control', async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'security', 'errors'])

    const wrapper = mount(MfaSetupModal, {
      props: {
        visible: true,
        loading: false,
        secret: 'SECRET',
        otpAuthUrl: 'otpauth://totp/test',
        setupCode: '',
        recoveryCodes: [],
        errorMessage: ''
      },
      global: {
        stubs: {
          FsusDialog: workflowDialogStub,
          ElButton: true,
          ElCheckbox: true,
          ElInput: true,
          ElSkeleton: true,
          QrcodeVue: true,
          CopyDocument: true
        }
      }
    })

    await nextTick()
    const dialog = wrapper.get('[data-test="workflow-dialog"]')
    expect(dialog.attributes('data-width')).toBe(fsusDialogWidths.compact)
    expect(dialog.attributes('data-destroy-on-close')).toBe('true')
    expect(dialog.attributes('data-show-close')).toBe('false')
    expect(dialog.attributes('data-modal-class')).toBe('')
    wrapper.unmount()
  })

  it('UserBanDialog admin confirm keeps frame class on the surface, not modal-class', async () => {
    const wrapper = mount(UserBanDialog, {
      props: {
        visible: true,
        reason: 'spam',
        quickReasons: ['spam'],
        isProcessing: false,
        isCalculating: false,
        targetAccountLabel: 'alice',
        targetInitials: 'A',
        confirmAccountLabel: '',
        canSubmit: false,
        validation: {
          isEmpty: true,
          isTooLong: false,
          hasUnsafeChars: false,
          preview: 'preview'
        }
      },
      global: {
        stubs: {
          FsusDialog: workflowDialogStub,
          ElAvatar: true,
          ElButton: true,
          ElForm: { template: '<form><slot /></form>' },
          ElFormItem: { template: '<div><slot /></div>' },
          ElSelect: true,
          ElOption: true,
          ElInput: true
        }
      }
    })

    await nextTick()
    const dialog = wrapper.get('[data-test="workflow-dialog"]')
    expect(dialog.classes()).toContain('admin-workspace-frame')
    expect(dialog.attributes('data-modal-class')).toBe('')
    expect(dialog.attributes('data-width')).toBe(fsusDialogWidths.compact)
    expect(new DOMWrapper(wrapper.get('[data-test="dialog-footer"]').element).exists()).toBe(true)
    wrapper.unmount()
  })
})
