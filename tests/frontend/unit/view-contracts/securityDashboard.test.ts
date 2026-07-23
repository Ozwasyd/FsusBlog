import { describe, expect, it } from 'vitest'
import type { SecurityOverviewResponse } from '@/api/security'
import { createSecurityDashboardModel } from '@/view-contracts/securityDashboard'

const createOverview = (overrides: {
  fakeCrawlerEvents?: number
  highRiskSnapshotCount?: number
  replayRejectsLastHour?: number
  unknownBotEvents?: number
  validationFailuresLastHour?: number
} = {}): SecurityOverviewResponse => ({
  status: 'healthy',
  checkedAtUtc: '2026-07-23T08:00:00.000Z',
  antiCrawler: {
    mode: 'enforce',
    fakeCrawlerEvents: overrides.fakeCrawlerEvents ?? 0,
    unknownBotEvents: overrides.unknownBotEvents ?? 0
  },
  pow: {
    policy: {
      snapshotId: 'pow-7',
      updatedAtUtc: '2026-07-23T07:30:00.000Z',
      updatedBy: 'admin:7',
      options: { mode: 'strict' }
    },
    replayRejectsLastHour: overrides.replayRejectsLastHour ?? 0,
    validationFailuresLastHour: overrides.validationFailuresLastHour ?? 0
  },
  risk: {
    eventsLastHour: 4,
    eventsLastDay: 12,
    highRiskSnapshotCount: overrides.highRiskSnapshotCount ?? 0,
    topReason: 'crawler'
  }
} as unknown as SecurityOverviewResponse)

describe('security dashboard view contract', () => {
  it('produces a compact healthy state instead of normal-status cards', () => {
    const model = createSecurityDashboardModel(createOverview())

    expect(model.status).toBe('healthy')
    expect(model.tasks).toEqual([])
    expect(model.statusCopy).toContain('系统处于预期状态')
    expect(model.trends.map((item) => item.value)).toEqual(['4', '12', '0', 'crawler'])
    expect(model.changes).toEqual([
      expect.objectContaining({
        actor: 'admin:7',
        label: 'PoW 策略',
        value: 'strict'
      })
    ])
  })

  it('turns every actionable aggregate into a direct contextual task', () => {
    const model = createSecurityDashboardModel(createOverview({
      fakeCrawlerEvents: 3,
      highRiskSnapshotCount: 2,
      replayRejectsLastHour: 1,
      unknownBotEvents: 4,
      validationFailuresLastHour: 5
    }))

    expect(model.status).toBe('attention')
    expect(model.tasks).toHaveLength(5)
    expect(model.tasks.map((item) => item.to.name)).toEqual([
      'ManageSecurityEvents',
      'ManageSecurityPow',
      'ManageSecurityPow',
      'ManageSecurityCrawler',
      'ManageSecurityCrawler'
    ])
    expect(model.tasks.map((item) => item.actionLabel)).toEqual([
      '查看风险事件',
      '检查 PoW',
      '检查 PoW',
      '检查反爬虫',
      '检查反爬虫'
    ])
  })
})
