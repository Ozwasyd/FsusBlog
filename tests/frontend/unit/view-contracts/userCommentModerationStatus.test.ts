import { describe, expect, it } from 'vitest'
import { createUserCommentViewContract } from '@/view-contracts/commentDetail'

describe('user comment moderation status view contract', () => {
  it('maps backend visibility fields to user-facing badge copy', () => {
    const view = createUserCommentViewContract({
      id: '77',
      content: 'pending comment',
      createTime: '2026-06-17T00:00:00.000Z',
      articleId: 5,
      articleTitle: 'Article Title',
      author: {
        mode: 'public',
        displayName: 'Comment author',
        displayLanguage: 'zh-CN'
      },
      moderationStatus: 0,
      moderationStatusLabel: '待审核，仅自己可见',
      visibilityState: 'pending',
      visibilityReasonCode: 'pending_review',
      isPubliclyVisible: false
    })

    expect(view.moderation).toEqual({
      status: 0,
      statusLabel: '待审核，仅自己可见',
      visibilityState: 'pending',
      reasonCode: 'pending_review',
      reasonText: '等待审核通过后才会公开显示。',
      tone: 'warning',
      publiclyVisible: false
    })
  })

})
