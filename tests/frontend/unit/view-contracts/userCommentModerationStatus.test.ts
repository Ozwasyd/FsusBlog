import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserCommentViewContract } from '@/view-contracts/commentDetail'

const listSource = readFileSync(
  resolve(process.cwd(), 'src/components/user/UserCommentsList.vue'),
  'utf8'
)

describe('user comment moderation status view contract', () => {
  it('maps backend visibility fields to user-facing badge copy', () => {
    const view = createUserCommentViewContract({
      id: '77',
      content: 'pending comment',
      createTime: '2026-06-17T00:00:00.000Z',
      articleId: 5,
      articleTitle: 'Article Title',
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

  it('renders moderation badges without mobile content compression', () => {
    expect(listSource).toContain('<el-tag')
    expect(listSource).toContain('item.moderation.statusLabel')
    expect(listSource).toContain('item.moderation.reasonText')
    expect(listSource).toContain('user-comment-moderation')
    expect(listSource).toContain('flex-wrap')
    expect(listSource).toContain('min-w-0')
    expect(listSource).toContain('break-words')
  })
})
