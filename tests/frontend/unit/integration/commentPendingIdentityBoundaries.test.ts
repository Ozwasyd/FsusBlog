// @vitest-environment happy-dom

import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import type { CommentAuthorMode } from '@/api/comment'
import { FsusUiButton } from '@/fsusui/button'
import { ElInput as FsusUiInput } from '@ozwasyd/element-plus'
import {
  createCommentPublicDraftStorageKey,
  prepareCommentPublicDraftStorage,
  readCommentPublicDraft,
  writeCommentPublicDraft
} from '@/privacy/commentPublicDraftStorage'
import {
  purgeCommentPrivacyCredentialState,
  resetCommentPrivacyCredentialLifecycleForTests
} from '@/privacy/commentPrivacyCredentialLifecycle'

// Exercise the actual composer and storage/lifecycle owners. The parent below
// only binds their public props/emits; it does not implement a submit protocol.
const mounted: VueWrapper[] = []
const PUBLIC_RETRY_ID = '10000000-0000-4000-8000-000000000042'
const PUBLIC_BODY = 'Pending public draft must not confirm this session'

function seedPublicDraft(articleId = 42, policyHash = 'policy-42', retryId = PUBLIC_RETRY_ID): string {
  const preparation = prepareCommentPublicDraftStorage(window.localStorage)
  expect(preparation.cleanupComplete).toBe(true)
  expect(preparation.scopeId).not.toBeNull()
  const key = createCommentPublicDraftStorageKey({
    scopeId: preparation.scopeId!, articleId, replyId: null
  })
  expect(writeCommentPublicDraft(window.localStorage, key, {
    version: 3,
    content: PUBLIC_BODY,
    savedAt: Date.now(),
    policyHash,
    clientMutationId: retryId
  })).toBe(true)
  return key
}

function mountBoundComposer(articleId = 42) {
  const state = reactive({
    modelValue: '',
    isLoggedIn: true,
    isBanned: false,
    isPowCalculating: false,
    isSubmitting: false,
    redirectPath: '/articles/42',
    replyTarget: null,
    authorMode: 'zk_anonymous' as CommentAuthorMode,
    publicSendConfirmed: false,
    anonymousCommentsEnabled: true,
    publicCommentsEnabled: true,
    zkAnonymousEnabled: true,
    articleId,
    accountId: 7,
    commentMaxChars: 1000,
    commentMaxUtf8Bytes: 4096,
    policySnapshotHash: 'policy-42',
    privacyState: 'ready' as const,
    displayLanguage: 'zh-CN' as const,
    anonymousScope: 'comment:v1:article:42:top'
  })
  const submit = vi.fn()
  const host = defineComponent({
    setup: () => () => h(ArticleCommentComposer, {
      ...state,
      'onUpdate:modelValue': (value: string) => { state.modelValue = value },
      'onUpdate:authorMode': (value: CommentAuthorMode) => { state.authorMode = value },
      'onUpdate:publicSendConfirmed': (value: boolean) => { state.publicSendConfirmed = value },
      onSubmit: submit
    })
  })
  const wrapper = mount(host, {
    global: {
      components: { ElButton: FsusUiButton, ElInput: FsusUiInput },
      // The closed dialog is outside this identity boundary. Input, Checkbox,
      // Button and the draft/privacy owners execute their actual local source.
      stubs: { FsusDialog: true, RouterLink: true }
    }
  })
  mounted.push(wrapper)
  return { wrapper, state, submit }
}

async function clickAction(wrapper: VueWrapper, label: string): Promise<void> {
  const button = wrapper.findAll('button').find(candidate => candidate.text() === label)
  expect(button, `actual composer action ${label}`).toBeDefined()
  await button!.trigger('click')
  await nextTick()
}

async function confirmPublicIdentity(wrapper: VueWrapper): Promise<void> {
  await wrapper.get<HTMLInputElement>('input[type="checkbox"]').setValue(true)
  await nextTick()
}

afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  resetCommentPrivacyCredentialLifecycleForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('comment pending draft and current public identity integration', () => {
  it('keeps a same-policy persisted public draft pending without granting current-session confirmation', async () => {
    const key = seedPublicDraft()
    const { wrapper, state, submit } = mountBoundComposer()
    await nextTick()

    expect(state.publicSendConfirmed).toBe(false)
    expect(state.authorMode).toBe('zk_anonymous')
    expect(state.modelValue).toBe('')
    const checkbox = wrapper.get<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox.element.checked).toBe(false)
    expect(checkbox.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('请先审查草稿')
    expect(window.localStorage.getItem(key)).toContain(PUBLIC_RETRY_ID)
    expect(submit).not.toHaveBeenCalled()
  })

  it('separates a reviewed public retry identity from an anonymous submit and requires a fresh public choice', async () => {
    const key = seedPublicDraft()
    const { wrapper, state, submit } = mountBoundComposer()
    await nextTick()
    await clickAction(wrapper, '审查草稿')

    expect(state.modelValue).toBe(PUBLIC_BODY)
    expect(state.authorMode).toBe('zk_anonymous')
    expect(state.publicSendConfirmed).toBe(false)
    expect(window.localStorage.getItem(key)).toBeNull()
    await clickAction(wrapper, '发送')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).not.toBe(PUBLIC_RETRY_ID)

    await confirmPublicIdentity(wrapper)
    expect(state.authorMode).toBe('public')
    expect(state.publicSendConfirmed).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    await clickAction(wrapper, '发送')
    expect(submit.mock.calls[1]![0]).toBe(PUBLIC_RETRY_ID)
    const persisted = readCommentPublicDraft(window.localStorage, key).draft
    expect(persisted).toMatchObject({ content: PUBLIC_BODY, clientMutationId: PUBLIC_RETRY_ID })
    expect(Object.keys(persisted!)).toEqual(['version', 'content', 'savedAt', 'policyHash', 'clientMutationId'])
    expect(window.sessionStorage.length).toBe(0)
  })

  it('keeps identical bodies in different articles bound to their own reviewed public retry identities', async () => {
    const otherRetryId = '20000000-0000-4000-8000-000000000043'
    const firstKey = seedPublicDraft()
    const secondKey = seedPublicDraft(43, 'policy-42', otherRetryId)
    const first = mountBoundComposer(42)
    const second = mountBoundComposer(43)
    await nextTick()

    await clickAction(first.wrapper, '审查草稿')
    expect(first.state.modelValue).toBe(PUBLIC_BODY)
    expect(second.state.modelValue).toBe('')
    expect(second.state.publicSendConfirmed).toBe(false)
    expect(window.localStorage.getItem(secondKey)).toContain(otherRetryId)
    await confirmPublicIdentity(first.wrapper)
    await clickAction(first.wrapper, '发送')
    expect(first.submit).toHaveBeenLastCalledWith(PUBLIC_RETRY_ID)

    await clickAction(second.wrapper, '审查草稿')
    await confirmPublicIdentity(second.wrapper)
    await clickAction(second.wrapper, '发送')
    expect(second.submit).toHaveBeenLastCalledWith(otherRetryId)
    expect(readCommentPublicDraft(window.localStorage, firstKey).draft?.clientMutationId).toBe(PUBLIC_RETRY_ID)
    expect(readCommentPublicDraft(window.localStorage, secondKey).draft?.clientMutationId).toBe(otherRetryId)
  })

  it('invalidates the reviewed retry identity on credential revocation before the same text is publicly confirmed', async () => {
    seedPublicDraft()
    const { wrapper, state, submit } = mountBoundComposer()
    await nextTick()
    await clickAction(wrapper, '审查草稿')
    await purgeCommentPrivacyCredentialState('credential-revoked', { broadcast: false })
    await nextTick()

    expect(state.modelValue).toBe('')
    expect(state.publicSendConfirmed).toBe(false)
    expect(wrapper.text()).not.toContain('请先审查草稿')
    state.modelValue = PUBLIC_BODY
    await nextTick()
    await confirmPublicIdentity(wrapper)
    await clickAction(wrapper, '发送')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).not.toBe(PUBLIC_RETRY_ID)
  })

  it('does not grant anonymous publication when review cannot delete the stored public copy', async () => {
    const key = seedPublicDraft()
    const { wrapper, state, submit } = mountBoundComposer()
    await nextTick()
    const storage = window.localStorage
    const removeItem = storage.removeItem.bind(storage)
    vi.spyOn(storage, 'removeItem').mockImplementation(candidate => {
      if (candidate === key) throw new Error('local_storage_deletion_denied')
      removeItem(candidate)
    })

    await clickAction(wrapper, '审查草稿')
    expect(state.modelValue).toBe(PUBLIC_BODY)
    expect(state.authorMode).toBe('zk_anonymous')
    expect(state.publicSendConfirmed).toBe(false)
    expect(storage.getItem(key)).toContain(PUBLIC_BODY)
    expect(wrapper.text()).toContain('强匿名发布已暂停')
    await clickAction(wrapper, '发送')
    expect(submit).not.toHaveBeenCalled()

    await confirmPublicIdentity(wrapper)
    expect(submit).not.toHaveBeenCalled()
    await clickAction(wrapper, '发送')
    expect(submit).toHaveBeenLastCalledWith(PUBLIC_RETRY_ID)
  })

  it('leaves pending public persistence intact on an anonymous credential purge without confirming it', async () => {
    const key = seedPublicDraft()
    const { state, submit } = mountBoundComposer()
    await nextTick()
    await purgeCommentPrivacyCredentialState('credential-revoked', { broadcast: false })
    await nextTick()

    expect(state.modelValue).toBe('')
    expect(state.authorMode).toBe('zk_anonymous')
    expect(state.publicSendConfirmed).toBe(false)
    expect(window.localStorage.getItem(key)).toContain(PUBLIC_RETRY_ID)
    expect(submit).not.toHaveBeenCalled()
  })

  it('cancels a pending public draft save when its composer unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { wrapper, state, submit } = mountBoundComposer()
    await confirmPublicIdentity(wrapper)
    state.modelValue = 'Cancelled draft save sentinel'
    await nextTick()
    const preparation = prepareCommentPublicDraftStorage(window.localStorage)
    const key = createCommentPublicDraftStorageKey({
      scopeId: preparation.scopeId!, articleId: 42, replyId: null
    })
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    await vi.advanceTimersByTimeAsync(701)

    expect(window.localStorage.getItem(key)).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('does not reuse an earlier policy retry identity after review and explicit public confirmation', async () => {
    seedPublicDraft(42, 'retired-policy')
    const { wrapper, state, submit } = mountBoundComposer()
    await nextTick()
    expect(state.modelValue).toBe('')
    await clickAction(wrapper, '审查草稿')
    expect(state.publicSendConfirmed).toBe(false)
    await confirmPublicIdentity(wrapper)
    await clickAction(wrapper, '发送')

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).not.toBe(PUBLIC_RETRY_ID)
  })

  it('blocks a previously confirmed public submit when current public permission is revoked', async () => {
    const { wrapper, state, submit } = mountBoundComposer()
    state.modelValue = 'Current permission controls this public submit'
    await nextTick()
    await confirmPublicIdentity(wrapper)
    expect(state.publicSendConfirmed).toBe(true)
    expect(submit).not.toHaveBeenCalled()

    state.publicCommentsEnabled = false
    await nextTick()
    expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.disabled).toBe(true)
    await clickAction(wrapper, '发送')
    expect(submit).not.toHaveBeenCalled()
  })

  it('starts the next composer unconfirmed after the previous public submission body is cleared', async () => {
    const first = mountBoundComposer()
    first.state.modelValue = 'One explicitly public comment'
    await nextTick()
    await confirmPublicIdentity(first.wrapper)
    await clickAction(first.wrapper, '发送')
    expect(first.submit).toHaveBeenCalledTimes(1)
    // Successful body clearing is a parent-owned prop update, as in production.
    first.state.modelValue = ''
    await nextTick()
    first.wrapper.unmount()
    mounted.splice(mounted.indexOf(first.wrapper), 1)

    const next = mountBoundComposer()
    await nextTick()
    expect(next.state.authorMode).toBe('zk_anonymous')
    expect(next.state.publicSendConfirmed).toBe(false)
    expect(next.wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(false)
    expect(next.submit).not.toHaveBeenCalled()
  })
})
