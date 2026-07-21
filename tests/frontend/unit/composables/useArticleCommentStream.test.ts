import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommentAuthorView, CommentTreeNode, CommentTreeRoot, CursorResponse } from '@/contracts/binaryApi'

const getComments = vi.hoisted(() => vi.fn())
const getThreadReplies = vi.hoisted(() => vi.fn())

vi.mock('@/api/comment', () => ({
  getComments,
  getThreadReplies,
  getCommentChildren: vi.fn(),
  getCommentPermalinkContext: vi.fn(),
  resolveCommentAuthorView: (input: { author?: CommentAuthorView | null }) => input.author
}))

import { useArticleCommentStream } from '@/composables/useArticleCommentStream'

const publicAuthor: CommentAuthorView = {
  mode: 'public',
  displayName: '公开作者',
  displayLanguage: 'zh-CN'
}

function cursor(data: CommentTreeRoot[]): CursorResponse<CommentTreeRoot> {
  return { data, nextCursor: null, hasMore: false }
}

function leafNode(): CommentTreeNode {
  return {
    id: '101',
    content: 'leaf secret',
    createTime: '2026-07-19T00:00:01Z',
    author: publicAuthor,
    replyToAuthor: publicAuthor,
    parentId: '100',
    rootId: '100',
    replyToCommentId: '100',
    depth: 1,
    isDeleted: false,
    isEdited: false,
    childCount: 0,
    hasMoreChildren: false
  }
}

function rootWithLeaf(): CommentTreeRoot {
  return {
    node: {
      id: '100',
      content: 'root',
      createTime: '2026-07-19T00:00:00Z',
      author: publicAuthor,
      parentId: null,
      rootId: '100',
      replyToCommentId: null,
      depth: 0,
      isDeleted: false,
      isEdited: false,
      childCount: 1,
      hasMoreChildren: false
    },
    childrenPreview: [leafNode()]
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
      .mockResolvedValueOnce(cursor([{
        node: {
          ...rootWithLeaf().node,
          childCount: 0
        },
        childrenPreview: []
      }]))
    const stream = useArticleCommentStream({
      getArticleId: () => 42,
      isMounted: () => true
    })

    await stream.loadMoreComments()
    expect(stream.removeCommentById('101', '100', '100')).toBe(true)
    expect(stream.threads.value[0]?.children[0]).toMatchObject({
      content: '该回复已删除',
      isDeleted: true,
      author: {
        mode: 'legacy_server_visible_pseudonymous',
        displayName: '已删除评论'
      }
    })

    await stream.reconcileCommentsAfterMutation()

    expect(stream.threads.value[0]?.children).toEqual([])
    expect(getComments).toHaveBeenLastCalledWith(42, null, 10, expect.any(Object))
  })

  it('increments the exact thread count for a visible realtime reply', async () => {
    const root = rootWithLeaf()
    root.node.childCount = 0
    root.childrenPreview = []
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
    expect(stream.threads.value[0]?.childCount).toBe(1)
    expect(stream.threads.value[0]?.children).toHaveLength(1)
  })
})
