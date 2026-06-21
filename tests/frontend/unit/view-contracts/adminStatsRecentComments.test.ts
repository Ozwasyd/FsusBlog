import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createAdminDashboardViewContract } from '@/view-contracts/adminStats'
import type { AdminStatsOverview, RecentCommentStatItem } from '@/api/stats'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

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

  it('keeps admin dashboard panels off deprecated userName and userId identity fields', () => {
    const panelPaths = [
      'src/frontend/src/components/admin/DashboardCommentModerationPanel.vue',
      'src/frontend/src/components/admin/DashboardRecentComments.vue',
      'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'
    ]

    for (const panelPath of panelPaths) {
      const source = readRepoFile(panelPath)
      expect(source, panelPath).not.toMatch(/\b(?:userName|userId)\b/)
    }

    const recentComments = readRepoFile('src/frontend/src/components/admin/DashboardRecentComments.vue')
    const moderationPanel = readRepoFile('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue')
    const authorAnalytics = readRepoFile('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue')

    expect(recentComments).toContain('comment.authorDisplayName')
    expect(moderationPanel).toContain('comment.actorDisplayName')
    expect(authorAnalytics).toContain('props.view.authorAnalytics')
  })

  it('runs the admin dashboard identity guard from frontend static checks', () => {
    const packageJson = JSON.parse(readRepoFile('src/frontend/package.json')) as { scripts?: Record<string, string> }
    const scripts = packageJson.scripts ?? {}
    const checkScript = 'node ../../tests/frontend/checks/static/check-admin-dashboard-panel-identity.mjs'

    expect(scripts['check:admin-dashboard-panel-identity']).toBe(checkScript)
    expect(scripts['check:views-constraints']).toContain('check:admin-dashboard-panel-identity')
  })
})
