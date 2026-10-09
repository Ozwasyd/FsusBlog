// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import { FsusUiCheckbox } from '@/fsusui/checkbox'
import { FsusUiInput } from '@/fsusui/input'
import { FsusUiSegmentedControl } from '@/fsusui/segmentedControl'
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
  template: '<button v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>'
})

const ElInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue', 'focus', 'keydown', 'compositionstart', 'compositionend'],
  setup(props, { attrs, emit, expose }) {
    const textarea = ref<HTMLTextAreaElement>()
    expose({ textarea, focus: () => textarea.value?.focus() })
    return () => h('textarea', {
      ...attrs,
      ref: textarea,
      value: props.modelValue,
      disabled: props.disabled,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
      onFocus: (event: FocusEvent) => emit('focus', event),
      onKeydown: (event: KeyboardEvent) => emit('keydown', event),
      onCompositionstart: (event: CompositionEvent) => emit('compositionstart', event),
      onCompositionend: (event: CompositionEvent) => emit('compositionend', event)
    })
  }
})

const FsusDialogStub = defineComponent({
  props: { modelValue: Boolean },
  template: '<div><slot /><slot name="footer" /></div>'
})

const RouterLinkStub = defineComponent({
  inheritAttrs: false,
  props: {
    to: { type: [String, Object], required: true }
  },
  template: '<a v-bind="$attrs" :data-to="JSON.stringify(to)"><slot /></a>'
})

const baseProps = {
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

const mountComposer = (props: Partial<InstanceType<typeof ArticleCommentComposer>['$props']> = {}) => mount(ArticleCommentComposer, {
  props: { ...baseProps, ...props },
  global: {
    stubs: {
      FsusUiButton: ElButtonStub,
      FsusUiInput: ElInputStub,
      FsusDialog: FsusDialogStub,
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
    const identityToggle = wrapper.get<HTMLInputElement>('input[type=checkbox]')

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

  it.each(['policy-42', 'policy-old'])('requires review and a new public choice for a restored draft with %s', async policyHash => {
    useDraftFakeTimers()
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3,
      content: '跨刷新公开草稿',
      savedAt: 123,
      policyHash,
      clientMutationId: '018ff003-1234-7abc-8def-0123456789ab'
    })

    const stored = localStorage.getItem(key)
    const wrapper = mountComposer({ articleId: 42, accountId: 7, authorMode: 'public', publicSendConfirmed: true })
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('update:authorMode')).toEqual([['zk_anonymous']])
    expect(wrapper.emitted('update:publicSendConfirmed')).toEqual([[false]])
    expect(wrapper.text()).toContain('请先审查草稿，本次发布身份需重新确认')
    const identity = wrapper.get<HTMLInputElement>('input[type=checkbox]')
    expect(identity.element.checked).toBe(false)
    expect(identity.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('请先审查恢复的草稿，再确认本次公开署名')
    await wrapper.setProps({ authorMode: 'zk_anonymous', publicSendConfirmed: false })
    await vi.advanceTimersByTimeAsync(1000)
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem(key)).toBe(stored)
    const submit = wrapper.findAll('button').find(button => button.text().includes('发送'))!
    await submit.trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.get('.comment-composer-draft__actions button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toContainEqual(['跨刷新公开草稿'])
    expect(wrapper.emitted('update:authorMode')).not.toContainEqual(['public'])
    expect(wrapper.emitted('update:publicSendConfirmed')).not.toContainEqual([true])
    expect(localStorage.getItem(key)).toBeNull()
    await wrapper.setProps({ modelValue: '跨刷新公开草稿' })
    expect(identity.element.checked).toBe(false)
    expect(identity.element.disabled).toBe(false)
    await identity.setValue(true)
    expect(wrapper.emitted('update:authorMode')).toContainEqual(['public'])
    expect(wrapper.emitted('update:publicSendConfirmed')).toContainEqual([true])

    await wrapper.setProps({
      modelValue: '跨刷新公开草稿',
      authorMode: 'public',
      publicSendConfirmed: true
    })
    await submit.trigger('click')
    const mutationId = wrapper.emitted('submit')![0]![0]
    if (policyHash === 'policy-42') expect(mutationId).toBe('018ff003-1234-7abc-8def-0123456789ab')
    else expect(mutationId).not.toBe('018ff003-1234-7abc-8def-0123456789ab')
    await submit.trigger('click')
    expect(wrapper.emitted('submit')![1]![0]).toBe(mutationId)

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
    expect(wrapper.emitted('update:authorMode')).toEqual([['zk_anonymous']])
    expect(wrapper.emitted('update:publicSendConfirmed')).toEqual([[false]])
    expect(wrapper.get('button').exists()).toBe(true)

    await wrapper.get('.comment-composer-draft__actions button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toContainEqual(['旧策略公开草稿'])
    expect(wrapper.emitted('update:authorMode')).toContainEqual(['zk_anonymous'])
    expect(wrapper.emitted('update:publicSendConfirmed')).toContainEqual([false])
    expect(localStorage.getItem(key)).toBeNull()

    wrapper.unmount()
  })

  it('preserves the private in-memory body and unreviewed stored candidate across restoration and unmount', async () => {
    useDraftFakeTimers()
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3, content: '待审公开草稿', savedAt: 123, policyHash: 'policy-42',
      clientMutationId: '018ff005-1234-7abc-8def-0123456789ab'
    })
    const stored = localStorage.getItem(key)
    const wrapper = mountComposer({ articleId: 42, accountId: 7, modelValue: '当前私密正文' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.props('modelValue')).toBe('当前私密正文')
    expect(localStorage.getItem(key)).toBe(stored)
    wrapper.unmount()
    expect(localStorage.getItem(key)).toBe(stored)
  })

  it('discarding an unreviewed draft does not clear an equal private in-memory body', async () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3, content: '相同文字但属于当前私密正文', savedAt: 123, policyHash: 'policy-42',
      clientMutationId: '018ff009-1234-7abc-8def-0123456789ab'
    })
    const wrapper = mountComposer({ articleId: 42, accountId: 7, modelValue: '相同文字但属于当前私密正文' })
    await wrapper.get('.comment-composer-draft__actions button:last-child').trigger('click')
    expect(localStorage.getItem(key)).toBeNull()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.props('modelValue')).toBe('相同文字但属于当前私密正文')
    wrapper.unmount()
  })

  it('uses a new anonymous mutation identity after review and keeps cleanup failures closed', async () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3, content: '审查后匿名发送', savedAt: 123, policyHash: 'policy-42',
      clientMutationId: '018ff006-1234-7abc-8def-0123456789ab'
    })
    const wrapper = mountComposer({ articleId: 42, accountId: 7 })
    await wrapper.get('.comment-composer-draft__actions button').trigger('click')
    await wrapper.setProps({ modelValue: '审查后匿名发送' })
    const submit = wrapper.findAll('button').find(button => button.text().includes('发送'))!
    await submit.trigger('click')
    expect(wrapper.emitted('submit')![0]![0]).not.toBe('018ff006-1234-7abc-8def-0123456789ab')
    wrapper.unmount()

    writeCommentPublicDraft(localStorage, key, {
      version: 3, content: '无法清理的公开草稿', savedAt: 123, policyHash: 'policy-42',
      clientMutationId: '018ff007-1234-7abc-8def-0123456789ab'
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage deletion denied') })
    const blocked = mountComposer({ articleId: 42, accountId: 7 })
    await blocked.get('.comment-composer-draft__actions button').trigger('click')
    await blocked.setProps({ modelValue: '无法清理的公开草稿' })
    expect(blocked.text()).toContain('强匿名发布已暂停')
    await blocked.findAll('button').find(button => button.text().includes('发送'))!.trigger('click')
    expect(blocked.emitted('submit')).toBeUndefined()
    expect(blocked.get<HTMLInputElement>('input[type=checkbox]').element.checked).toBe(false)
    blocked.unmount()
  })

  it('drops reviewed public retry identity when the anonymous credential lifecycle is purged', async () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId!, articleId: 42, replyId: null })
    writeCommentPublicDraft(localStorage, key, {
      version: 3, content: '已审查正文', savedAt: 123, policyHash: 'policy-42',
      clientMutationId: '018ff008-1234-7abc-8def-0123456789ab'
    })
    const wrapper = mountComposer({ articleId: 42, accountId: 7 })
    await wrapper.get('.comment-composer-draft__actions button').trigger('click')
    await wrapper.setProps({ modelValue: '已审查正文' })
    await purgeCommentPrivacyCredentialState('epoch-changed', { broadcast: false })
    expect(wrapper.emitted('update:modelValue')).toContainEqual([''])
    await wrapper.setProps({ modelValue: '' })
    await wrapper.get<HTMLInputElement>('input[type=checkbox]').setValue(true)
    await wrapper.setProps({ modelValue: '已审查正文', authorMode: 'public', publicSendConfirmed: true })
    await wrapper.findAll('button').find(button => button.text().includes('发送'))!.trigger('click')
    expect(wrapper.emitted('submit')![0]![0]).not.toBe('018ff008-1234-7abc-8def-0123456789ab')
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


describe('ArticleCommentComposer public primitive delegation', () => {
  it('delegates the two mode surfaces to one public configuration and state', async () => {
    const wrapper = mountComposer({ modelValue: '正文' })
    const modes = wrapper.findAllComponents(FsusUiSegmentedControl)
    expect(modes).toHaveLength(2)
    expect(modes[0]!.props('items')).toBe(modes[1]!.props('items'))
    expect(modes[0]!.props('ariaLabel')).toBe(modes[1]!.props('ariaLabel'))
    modes[1]!.vm.$emit('update:modelValue', 'preview')
    await nextTick()
    expect(modes.map(mode => mode.props('modelValue'))).toEqual(['preview', 'preview'])
    modes[0]!.vm.$emit('update:modelValue', 'unexpected')
    await nextTick()
    expect(modes[0]!.props('modelValue')).toBe('preview')
    wrapper.unmount()
  })

  it('delegates the same input contract and content to normal and expanded editors', async () => {
    const wrapper = mountComposer({ modelValue: '共享正文', isSubmitting: true })
    const editors = wrapper.findAllComponents(FsusUiInput)
    expect(editors).toHaveLength(2)
    for (const editor of editors) {
      expect(editor.props('modelValue')).toBe('共享正文')
      expect(editor.props('disabled')).toBe(true)
      expect(editor.attributes('aria-label')).toBe('发表评论')
      expect(editor.attributes('type')).toBe('textarea')
      expect(editor.attributes('resize')).toBe('none')
    }
    editors[1]!.vm.$emit('update:modelValue', '扩展输入')
    expect(wrapper.emitted('update:modelValue')).toContainEqual(['扩展输入'])
    wrapper.unmount()
  })

  it.each([
    [{ isBanned: true }, '当前账号已被禁言'],
    [{ isPowCalculating: true }, '正在准备发送'],
    [{ isSubmitting: true }, '正在发送评论'],
    [{ publicCommentsEnabled: false }, '不允许公开署名评论']
  ] as const)('keeps a reason in the disabled checkbox label and refuses updates: %s', async (props, reason) => {
    const wrapper = mountComposer(props)
    const checkbox = wrapper.getComponent(FsusUiCheckbox)
    expect(checkbox.props('disabled')).toBe(true)
    expect(checkbox.text()).toContain(reason)
    checkbox.vm.$emit('update:modelValue', true)
    await nextTick()
    expect(wrapper.emitted('update:authorMode')).toBeUndefined()
    expect(wrapper.emitted('update:publicSendConfirmed')).toBeUndefined()
    wrapper.unmount()
  })

  it('explains anonymous unavailability while retaining explicit public choice', () => {
    const wrapper = mountComposer({ zkAnonymousEnabled: false })
    expect(wrapper.getComponent(FsusUiCheckbox).props('disabled')).toBe(false)
    expect(wrapper.getComponent(FsusUiCheckbox).text()).toContain('勾选后将公开署名')
    wrapper.unmount()
  })

  it('changes only this submit choice, with no mutation or account preference write', async () => {
    const wrapper = mountComposer({ modelValue: '公开评论' })
    await nextTick()
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await wrapper.get<HTMLInputElement>('input[type=checkbox]').setValue(true)
    expect(storageWrite).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.emitted('submit')).toBeUndefined()
    await wrapper.setProps({ authorMode: 'public', publicSendConfirmed: true })
    const submit = wrapper.findAll('button').find(button => button.text().includes('发送'))!
    await submit.trigger('click')
    expect(wrapper.emitted('submit')).toHaveLength(1)
    wrapper.unmount()
    const nextComposer = mountComposer()
    expect(nextComposer.getComponent(FsusUiCheckbox).props('modelValue')).toBe(false)
    nextComposer.unmount()
  })

  it('blocks composing submit shortcuts and submits once after composition finishes', async () => {
    const wrapper = mountComposer({ modelValue: '输入中文' })
    const editor = wrapper.getComponent(FsusUiInput)
    editor.vm.$emit('compositionstart', new CompositionEvent('compositionstart'))
    editor.vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true }))
    expect(wrapper.emitted('submit')).toBeUndefined()
    editor.vm.$emit('compositionend', new CompositionEvent('compositionend'))
    await nextTick()
    editor.vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    expect(wrapper.emitted('submit')).toHaveLength(1)
    wrapper.unmount()
  })
})
