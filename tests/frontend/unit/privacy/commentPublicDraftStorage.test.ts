// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMMENT_PUBLIC_DRAFT_SCOPE_KEY,
  COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX,
  LEGACY_COMMENT_DRAFT_STORAGE_PREFIX,
  clearAllCommentDraftStorage,
  createCommentPublicDraftStorageKey,
  prepareCommentPublicDraftStorage,
  readCommentPublicDraft,
  writeCommentPublicDraft
} from '@/privacy/commentPublicDraftStorage'

describe('comment public draft storage', () => {
  beforeEach(() => localStorage.clear())

  it('uses a random local scope and persists only the public draft payload', () => {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    expect(preparation).toMatchObject({ cleanupComplete: true, persistenceAvailable: true })
    expect(preparation.scopeId).toMatch(/^[a-f0-9]{32}$/u)

    const key = createCommentPublicDraftStorageKey({
      scopeId: preparation.scopeId!,
      articleId: 42,
      replyId: null
    })
    expect(key).toMatch(new RegExp(`^${COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX}`))
    expect(key).not.toContain(':7:')

    expect(writeCommentPublicDraft(localStorage, key, {
      version: 2,
      content: '公开草稿',
      savedAt: 123,
      policyHash: 'policy-a'
    })).toBe(true)
    expect(readCommentPublicDraft(localStorage, key)).toEqual({
      draft: {
        version: 2,
        content: '公开草稿',
        savedAt: 123,
        policyHash: 'policy-a'
      },
      cleanupComplete: true
    })
  })

  it('purges legacy plaintext drafts before opening the new scope', () => {
    localStorage.setItem(`${LEGACY_COMMENT_DRAFT_STORAGE_PREFIX}7:42:root`, JSON.stringify({
      content: '旧匿名正文',
      authorMode: 'zk_anonymous'
    }))

    const preparation = prepareCommentPublicDraftStorage(localStorage)

    expect(preparation.cleanupComplete).toBe(true)
    expect(localStorage.getItem(`${LEGACY_COMMENT_DRAFT_STORAGE_PREFIX}7:42:root`)).toBeNull()
    expect(localStorage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY)).toBe(preparation.scopeId)
  })

  it('rotates the scope and removes every draft on identity cleanup', () => {
    const first = prepareCommentPublicDraftStorage(localStorage)
    const key = createCommentPublicDraftStorageKey({ scopeId: first.scopeId!, articleId: 42, replyId: '9' })
    writeCommentPublicDraft(localStorage, key, {
      version: 2,
      content: '公开回复',
      savedAt: 456,
      policyHash: 'policy-a'
    })

    expect(clearAllCommentDraftStorage(localStorage)).toBe(true)
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY)).toBeNull()

    const second = prepareCommentPublicDraftStorage(localStorage)
    expect(second.scopeId).not.toBe(first.scopeId)
  })
})
