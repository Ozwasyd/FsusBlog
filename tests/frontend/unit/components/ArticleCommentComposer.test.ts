// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import {
  COMMENT_PUBLIC_DRAFT_SCOPE_KEY,
  COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX,
  LEGACY_COMMENT_DRAFT_STORAGE_PREFIX,
  createCommentPublicDraftStorageKey,
  prepareCommentPublicDraftStorage,
  writeCommentPublicDraft
} from '@/privacy/commentPublicDraftStorage'
import {
  purgeCommentPrivacyCredentialState,
  resetCommentPrivacyCredentialLifecycleForTests
} from '@/privacy/commentPrivacyCredentialLifecycle'

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

const RouterLinkStub = defineComponent({
  inheritAttrs: false,
  props: {
    to: { type: [String, Object], required: true }
  },
  template: '<a v-bind="$attrs" :data-to="JSON.stringify(to)"><slot /></a>'
})

type ComposerProps = InstanceType<typeof ArticleCommentComposer>['$props']

const baseProps: ComposerProps = {
  modelValue: '',
  isLoggedIn: true,
  isBanned: false,
  isPowCalculating: false,
  isSubmitting: false,
  redirectPath: '/articles/42',
  replyTarget: null,
  authorMode: 'zk_anonymous' as const,
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

const mountComposer = (props: Partial<ComposerProps> = {}) => mount(ArticleCommentComposer, {
  props: { ...baseProps, ...props },
  global: {
    stubs: {
      ElButton: ElButtonStub,
      ElInput: ElInputStub,
      FsusDialog: true,
      CommentMarkdownRenderer: true,
      RouterLink: RouterLinkStub
    }
  }
})

type ObserverRecord = {
  callback: IntersectionObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

const observerRecords: ObserverRecord[] = []

const useDraftFakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

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
  vi.useRealTimers()
  resetCommentPrivacyCredentialLifecycleForTests()
})

describe('ArticleCommentComposer mounted identity behavior', () => {
  it('renders the guest auth gate with its semantic copy and login route', () => {
    const wrapper = mountComposer({ isLoggedIn: false })
    const authGate = wrapper.get('section.fsus-comment-login')

    expect(authGate.attributes('aria-label')).toBe('评论登录提示')
    expect(authGate.get('.fsus-comment-login__text').text()).toBe('登录后可发表评论与回复。')
    expect(authGate.get('.fsus-comment-login__btn').text()).toBe('登录')
    expect(authGate.get('.fsus-comment-login__btn').attributes('data-to')).toContain('/login')

    wrapper.unmount()
  })

  it('defaults to strong anonymous and requires a user toggle before public attribution', async () => {
    const wrapper = mountComposer()
    const identityToggle = wrapper.get<HTMLInputElement>('.comment-identity-toggle__input')

    expect(identityToggle.element.checked).toBe(false)
    expect(wrapper.text()).toContain('强匿名发布')
    expect(wrapper.text()).toContain('公开显示我的名称')
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

    expect(wrapper.emitted('update:authorMode')).toEqual([['public'], ['zk_anonymous']])
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

  it('persists public drafts without exposing the raw account id', async () => {
    useDraftFakeTimers()
    const wrapper = mountComposer({
      articleId: 42,
      accountId: 7,
      authorMode: 'public',
      publicSendConfirmed: true
    })

    await wrapper.setProps({ modelValue: '公开草稿' })
    await vi.advanceTimersByTimeAsync(700)

    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? '')
    const draftKey = keys.find(key => key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))
    expect(draftKey).toBeTruthy()
    expect(draftKey).not.toContain(':7:')
    expect(localStorage.getItem(draftKey!)).toContain('公开草稿')
    expect(localStorage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY)).toMatch(/^[a-f0-9]{32}$/u)

    wrapper.unmount()
  })

  it('keeps strong anonymous drafts in memory and removes a prior public copy on mode switch', async () => {
    useDraftFakeTimers()
    const wrapper = mountComposer({
      articleId: 42,
      accountId: 7,
      authorMode: 'public',
      publicSendConfirmed: true
    })
    await wrapper.setProps({ modelValue: '同一正文' })
    await vi.advanceTimersByTimeAsync(700)
    expect([...Array(localStorage.length).keys()].map(index => localStorage.key(index) ?? '')
      .some(key => key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))).toBe(true)

    await wrapper.setProps({ authorMode: 'zk_anonymous', publicSendConfirmed: false })
    await nextTick()
    await vi.advanceTimersByTimeAsync(700)

    expect([...Array(localStorage.length).keys()].map(index => localStorage.key(index) ?? '')
      .some(key => key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))).toBe(false)
    expect(wrapper.props('modelValue')).toBe('同一正文')

    wrapper.unmount()
  })

  it('restores a matching public draft after a new mount', async () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3,
      content: '跨刷新公开草稿',
      savedAt: 123,
      policyHash: 'policy-42',
      clientMutationId: '018ff003-1234-7abc-8def-0123456789ab'
    })

    const wrapper = mountComposer({ articleId: 42, accountId: 7 })
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toContainEqual(['跨刷新公开草稿'])
    expect(wrapper.emitted('update:authorMode')).toContainEqual(['public'])
    expect(wrapper.emitted('update:publicSendConfirmed')).toContainEqual([true])
    expect(wrapper.text()).toContain('已恢复公开草稿')

    await wrapper.setProps({
      modelValue: '跨刷新公开草稿',
      authorMode: 'public',
      publicSendConfirmed: true
    })
    const submit = wrapper.findAll('button').find(button => button.text().includes('发送'))
    expect(submit).toBeTruthy()
    await submit!.trigger('click')
    expect(wrapper.emitted('submit')).toEqual([
      ['018ff003-1234-7abc-8def-0123456789ab']
    ])

    wrapper.unmount()
  })

  it('requires explicit review when the policy hash changed and does not restore the author mode', async () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3,
      content: '旧策略公开草稿',
      savedAt: 123,
      policyHash: 'policy-old',
      clientMutationId: '018ff004-1234-7abc-8def-0123456789ab'
    })

    const wrapper = mountComposer({ articleId: 42, accountId: 7, policySnapshotHash: 'policy-new' })
    await nextTick()

    expect(wrapper.text()).toContain('评论策略已更新')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('update:authorMode')).toBeUndefined()
    expect(wrapper.get('button').element.tagName).toBe('BUTTON')

    await wrapper.get('.comment-composer-draft__actions button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toContainEqual(['旧策略公开草稿'])
    expect(wrapper.emitted('update:authorMode')).toContainEqual(['zk_anonymous'])
    expect(wrapper.emitted('update:publicSendConfirmed')).toContainEqual([false])
    expect(localStorage.getItem(key)).toBeNull()

    wrapper.unmount()
  })

  it('clears anonymous memory on credential epoch rotation and public storage on account switch', async () => {
    const anonymous = mountComposer({ articleId: 42, accountId: 7, modelValue: '匿名内存草稿' })
    await purgeCommentPrivacyCredentialState('epoch-changed', { broadcast: false })
    expect(anonymous.emitted('update:modelValue')).toContainEqual([''])
    anonymous.unmount()

    useDraftFakeTimers()
    const publicDraft = mountComposer({
      articleId: 42,
      accountId: 7,
      modelValue: '账号 A 草稿',
      authorMode: 'public',
      publicSendConfirmed: true
    })
    await vi.advanceTimersByTimeAsync(700)
    const firstScope = localStorage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY)

    await publicDraft.setProps({ accountId: 8 })
    await nextTick()

    expect(publicDraft.emitted('update:modelValue')).toContainEqual([''])
    expect(localStorage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY)).not.toBe(firstScope)
    expect([...Array(localStorage.length).keys()].map(index => localStorage.key(index) ?? '')
      .some(key => key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))).toBe(false)
    publicDraft.unmount()
  })

  it('fails closed for anonymous submit when legacy cleanup is known to fail', async () => {
    localStorage.setItem(`${LEGACY_COMMENT_DRAFT_STORAGE_PREFIX}7:42:root`, JSON.stringify({
      content: '遗留匿名正文',
      authorMode: 'zk_anonymous'
    }))
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const wrapper = mountComposer({ articleId: 42, accountId: 7, modelValue: '新匿名正文' })
    await nextTick()

    expect(wrapper.text()).toContain('强匿名发布已暂停')
    expect(wrapper.findAll('button').some(button => button.attributes('disabled') !== undefined)).toBe(true)
    expect(localStorage.getItem(`${LEGACY_COMMENT_DRAFT_STORAGE_PREFIX}7:42:root`)).not.toBeNull()

    wrapper.unmount()
  })
})
