import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommentAuthorView, CommentThreadItem, CursorResponse } from '@/contracts/binaryApi'

const getComments = vi.hoisted(() => vi.fn())
const getThreadReplies = vi.hoisted(() => vi.fn())

vi.mock('@/api/comment', () => ({
  getComments,
  getThreadReplies,
  resolveCommentAuthorView: (input: { author?: CommentAuthorView | null }) => input.author
}))

import { useArticleCommentStream } from '@/composables/useArticleCommentStream'

const publicAuthor: CommentAuthorView = {
  mode: 'public',
  displayName: '公开作者',
  displayLanguage: 'zh-CN'
}

function cursor(data: CommentThreadItem[]): CursorResponse<CommentThreadItem> {
  return { data, nextCursor: null, hasMore: false }
}

function rootWithLeaf(): CommentThreadItem {
  return {
    id: '100',
    content: 'root',
    createTime: '2026-07-19T00:00:00Z',
    author: publicAuthor,
    rootId: '100',
    isDeleted: false,
    replyCount: 1,
    hasMoreReplies: false,
    repliesPreview: [{
      id: '101',
      content: 'leaf secret',
      createTime: '2026-07-19T00:00:01Z',
      author: publicAuthor,
      replyToAuthor: publicAuthor,
      isDeleted: false
    }]
  }
}

describe('useArticleCommentStream comment tombstones', () => {
  beforeEach(() => {
    getComments.mockReset()
    getThreadReplies.mockReset()
  })

  it('redacts optimistic deletion and reconciles to the authoritative cold-read shape', async () => {
    getComments
      .mockResolvedValueOnce(cursor([rootWithLeaf()]))
      .mockResolvedValueOnce(cursor([{ ...rootWithLeaf(), replyCount: 0, repliesPreview: [] }]))
    const stream = useArticleCommentStream({
      getArticleId: () => 42,
      isMounted: () => true
    })

    await stream.loadMoreComments()
    expect(stream.removeCommentById('101', '100', '100')).toBe(true)
    expect(stream.threads.value[0]?.repliesPreview[0]).toMatchObject({
      content: '该回复已删除',
      isDeleted: true,
      author: {
        mode: 'legacy_server_visible_pseudonymous',
        displayName: '已删除评论'
      }
    })

    await stream.reconcileCommentsAfterMutation()

    expect(stream.threads.value[0]?.repliesPreview).toEqual([])
    expect(getComments).toHaveBeenLastCalledWith(42, null, 10, expect.any(Object))
  })

  it('increments the exact thread count for a visible realtime reply', async () => {
    const root = rootWithLeaf()
    root.replyCount = 0
    root.repliesPreview = []
    getComments.mockResolvedValueOnce(cursor([root]))
    const stream = useArticleCommentStream({
      getArticleId: () => 42,
      isMounted: () => true
    })
    await stream.loadMoreComments()

    expect(stream.prependCommentIfAbsent({
      id: '101',
      content: 'realtime reply',
      createTime: '2026-07-19T00:00:01Z',
      author: publicAuthor,
      parentId: '100',
      rootId: '100',
      replyToAuthor: publicAuthor,
      replyToCommentId: '100',
      depth: 1,
      isDeleted: false
    })).toBe(true)

    expect(stream.threads.value[0]?.replyCount).toBe(1)
    expect(stream.threads.value[0]?.repliesPreview).toHaveLength(1)
  })
})
