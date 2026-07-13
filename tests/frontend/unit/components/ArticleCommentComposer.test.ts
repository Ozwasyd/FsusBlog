// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  emits: ['click'],
  template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'
})

const ElInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false }
  },
  template: '<textarea :value="modelValue" :disabled="disabled" />'
})

const baseProps = {
  modelValue: '',
  isLoggedIn: true,
  isBanned: false,
  isPowCalculating: false,
  isSubmitting: false,
  redirectPath: '/articles/42',
  replyTarget: null,
  authorMode: 'anonymous' as const,
  publicSendConfirmed: false,
  anonymousCommentsEnabled: true,
  publicCommentsEnabled: true,
  zkAnonymousEnabled: true,
  articleId: null,
  accountId: null,
  commentMaxChars: 1000,
  commentMaxUtf8Bytes: 4096,
  policySnapshotHash: 'policy-42',
  privacyState: 'ready' as const,
  displayLanguage: 'zh-CN' as const,
  anonymousScope: 'article:42'
}

const mountComposer = () => mount(ArticleCommentComposer, {
  props: baseProps,
  global: {
    stubs: {
      ElButton: ElButtonStub,
      ElInput: ElInputStub,
      FsusDialog: true,
      CommentMarkdownRenderer: true,
      RouterLink: true
    }
  }
})

type ObserverRecord = {
  callback: IntersectionObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

const observerRecords: ObserverRecord[] = []

class TestIntersectionObserver {
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()
  readonly takeRecords = vi.fn(() => [])
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]

  constructor(callback: IntersectionObserverCallback) {
    observerRecords.push({
      callback,
      observe: this.observe,
      disconnect: this.disconnect
    })
  }
}

afterEach(() => {
  observerRecords.length = 0
  window.localStorage.clear()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ArticleCommentComposer mounted identity behavior', () => {
  it('defaults to anonymous and requires a user toggle before public attribution', async () => {
    const wrapper = mountComposer()
    const identityToggle = wrapper.get<HTMLInputElement>('.comment-identity-toggle__input')

    expect(identityToggle.element.checked).toBe(false)
    expect(wrapper.text()).toContain('匿名发布')
    expect(wrapper.text()).toContain('公开显示我的名称')
    expect(wrapper.text()).not.toContain('强匿名')
    expect(wrapper.text()).not.toContain('zk_anonymous')
    expect(wrapper.text().toLowerCase()).not.toContain('proof')
    expect(wrapper.emitted('update:authorMode')).toBeUndefined()
    expect(wrapper.emitted('update:publicSendConfirmed')).toBeUndefined()

    await identityToggle.setValue(true)

    expect(wrapper.emitted('update:authorMode')).toEqual([['public']])
    expect(wrapper.emitted('update:publicSendConfirmed')).toEqual([[true]])

    await wrapper.setProps({
      authorMode: 'public',
      publicSendConfirmed: true
    })

    expect(identityToggle.element.checked).toBe(true)
    expect(wrapper.text()).toContain('公开发布后，其他人会看到你的公开名称。')

    await identityToggle.setValue(false)

    expect(wrapper.emitted('update:authorMode')).toEqual([['public'], ['anonymous']])
    expect(wrapper.emitted('update:publicSendConfirmed')).toEqual([[true], [false]])
    wrapper.unmount()
  })

  it('prewarms privacy only after the mounted composer becomes visible', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const wrapper = mountComposer()
    await nextTick()

    expect(observerRecords).toHaveLength(1)
    const observer = observerRecords[0]!
    expect(observer.observe).toHaveBeenCalledWith(wrapper.element)
    expect(wrapper.emitted('privacy-intent')).toBeUndefined()

    observer.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
    expect(wrapper.emitted('privacy-intent')).toBeUndefined()

    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
    expect(wrapper.emitted('privacy-intent')).toHaveLength(1)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})
