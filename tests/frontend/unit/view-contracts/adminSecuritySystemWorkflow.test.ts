import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('admin security system workflow contract', () => {
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const nav = readRepoFile('src/frontend/src/layouts/accountNav.ts')
  const tabs = readRepoFile('src/frontend/src/components/admin/security/SecuritySystemTabs.vue')
  const layout = readRepoFile('src/frontend/src/views/admin/security/SecurityLayout.vue')
  const dashboard = readRepoFile('src/frontend/src/views/admin/security/SecurityDashboard.vue')
  const crawler = readRepoFile('src/frontend/src/views/admin/security/SecurityCrawler.vue')
  const pow = readRepoFile('src/frontend/src/views/admin/security/SecurityPow.vue')
  const api = readRepoFile('src/frontend/src/api/security.ts')
  const endpoints = readRepoFile('src/backend/Modules/Endpoints/SecurityEndpoints.cs')

  it('registers security system as a standalone admin route group', () => {
    expect(router).toContain("path: 'manage/security'")
    expect(router).toContain("name: 'ManageSecuritySystem'")
    expect(router).toContain("name: 'ManageSecurityDashboard'")
    expect(router).toContain("name: 'ManageSecurityCrawler'")
    expect(router).toContain("name: 'ManageSecurityPow'")
    expect(nav).toContain("label: '安全系统'")
    expect(nav).toContain("to: '/user/manage/security'")
    expect(tabs).toContain('安全总览')
    expect(tabs).toContain('反爬虫系统')
    expect(tabs).toContain('PoW 系统')
  })

  it('keeps anti-crawler and PoW as sibling security capabilities', () => {
    expect(layout).toContain('PoW 不是反爬虫子配置')
    expect(layout).toContain('反爬虫只产生 crawler 类风险信号')
    expect(dashboard).toContain('AntiCrawler')
    expect(dashboard).toContain('PoW')
    expect(dashboard).toContain('SecurityRisk')
    expect(crawler).toContain('securityChallengeReference')
    expect(crawler).toContain('Public read challenge')
    expect(crawler).toContain('Search crawler verification')
    expect(crawler).not.toContain('PoW 策略已更新')
    expect(pow).toContain('PoW 页面只管理 challenge')
    expect(pow).toContain('AntiCrawler emits crawler risk')
  })

  it('exposes security admin API client and backend endpoints', () => {
    expect(api).toContain('/api/admin/security/overview')
    expect(api).toContain('/api/admin/security/anti-crawler/overview')
    expect(api).toContain('/api/admin/security/anti-crawler/options')
    expect(api).toContain('/api/admin/security/anti-crawler/crawler-ranges/sync')
    expect(api).toContain('/api/admin/security/risk/ip/reset')
    expect(api).toContain('/api/admin/security/pow/options')
    expect(api).toContain('X-Fsus-Mfa-Proof')
    expect(endpoints).toContain('MapGet("/overview"')
    expect(endpoints).toContain('MapGet("/anti-crawler/overview"')
    expect(endpoints).toContain('MapPut("/anti-crawler/options"')
    expect(endpoints).toContain('MapPost("/anti-crawler/crawler-ranges/sync"')
    expect(endpoints).toContain('MapGet("/pow/overview"')
    expect(endpoints).toContain('MapPut("/pow/options"')
    expect(endpoints).toContain('RequireAdminSensitiveStepUpAsync')
    expect(endpoints).toContain('RecordSecurityAuditAsync')
  })
})
