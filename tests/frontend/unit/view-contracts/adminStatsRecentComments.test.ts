import { describe, expect, it } from 'vitest'
import { createAdminDashboardViewContract } from '@/view-contracts/adminStats'
import type { AdminStatsOverview, RecentCommentStatItem } from '@/api/stats'

describe('admin stats recent comments privacy contract', () => {
  it('renders recent comment authors from anonymous-safe author display fields', () => {
    const overview: AdminStatsOverview = {
      summary: {
        totalArticles: 0,
        totalComments: 0,
        trashCount: 0,
        totalReads: 0,
        humanVerifiedReads: 0,
        uniqueViewerKeyEstimate: 0,
        articleReads: 0,
        siteReads: 0
      },
      popularArticles: []
    }
    const comments: RecentCommentStatItem[] = [{
      authorDisplayName: '强匿名评论者',
      authorMode: 'zk_anonymous',
      authorBadge: '已验证匿名凭证',
      authorScopeLabel: 'article:42',
      credentialLevel: 'strong_anonymous',
      content: '匿名反馈',
      createTime: '2026-01-02T00:00:00.000Z'
    }]

    const view = createAdminDashboardViewContract(overview, comments, [])

    expect(view.recentComments[0]).toMatchObject({
      id: '强匿名评论者-0',
      authorDisplayName: '强匿名评论者',
      authorMode: 'zk_anonymous',
      authorBadge: '已验证匿名凭证',
      authorScopeLabel: 'article:42',
      credentialLevel: 'strong_anonymous'
    })
  })

})
