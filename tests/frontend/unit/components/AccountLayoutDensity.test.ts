import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountNavSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/accountNav.ts'),
  'utf8',
)
const accountShellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell.css'),
  'utf8',
)
const dashboardSource = readFileSync(
  resolve(process.cwd(), 'src/views/admin/Dashboard.vue'),
  'utf8',
)
const analyticsSource = readFileSync(
  resolve(process.cwd(), 'src/views/admin/Analytics.vue'),
  'utf8',
)
const routerSource = readFileSync(
  resolve(process.cwd(), 'src/router/index.ts'),
  'utf8',
)

describe('AccountLayout navigation density', () => {
  it('keeps high-frequency account navigation as labels first', () => {
    expect(accountNavSource).toContain("label: '身份中心'")
    expect(accountNavSource).toContain("to: '/user/identity'")
    expect(accountNavSource).toContain("label: '我的消息'")
    expect(accountNavSource).toContain("to: '/user/messagebox'")
    expect(accountNavSource).not.toContain('资料与安全')
    expect(accountNavSource).not.toContain('站内会话')
    expect(accountNavSource).not.toContain('登录与公开身份')
  })

  it('keeps only terse helpers for complex governance entries', () => {
    expect(accountNavSource).toContain("helper: '证明'")
    expect(accountNavSource).toContain("helper: '风险桶'")
    expect(accountNavSource).toContain("helper: 'PoW'")
    expect(accountNavSource).not.toContain('评论、词库与策略')
    expect(accountNavSource).not.toContain(
      '系统设置、安全系统、备份迁移、审计日志',
    )
  })

  it('reduces account page header spacing and title scale', () => {
    expect(accountShellCss).toContain(
      '.account-page-header {\n  margin-bottom: 2rem;',
    )
    expect(accountShellCss).toContain(
      '.account-page-header--compact {\n  margin-bottom: 1.25rem;',
    )
    expect(accountShellCss).toContain(
      'font-size: clamp(1.5rem, 2.4vw, 2.25rem);',
    )
    expect(accountShellCss).toContain('font-size: clamp(1.35rem, 8vw, 2rem);')
    expect(accountShellCss).not.toContain(
      'font-size: clamp(2.1rem, 4vw, 3.8rem);',
    )
  })

  it('keeps account and admin page headers on the local stable layout contract', () => {
    expect(dashboardSource).toContain('class="account-page-header account-page-header--compact"')
    expect(dashboardSource).toContain('class="account-page-title"')
    expect(dashboardSource).toContain('class="account-page-description"')
    expect(dashboardSource).not.toContain('<FsusUiPageHeader')
    expect(dashboardSource).not.toContain('FsusUiPageHeader,')
  })

  it('keeps the admin dashboard inside task-surface density bounds', () => {
    expect(dashboardSource).not.toContain('class="mb-12"')
    expect(dashboardSource).not.toContain('class="mb-16')
    expect(dashboardSource).not.toContain(' p-8')
    expect(dashboardSource).not.toContain('min-height: 9rem')
    expect(dashboardSource).toContain('class="mb-8"')
    expect(dashboardSource).toContain('min-height: 7rem')
  })

  it('keeps the manage dashboard lightweight and splits analytics to a dedicated route', () => {
    expect(routerSource).toContain("path: 'manage/analytics'")
    expect(routerSource).toContain("name: 'ManageAnalytics'")
    expect(accountNavSource).toContain("label: '数据概览'")
    expect(accountNavSource).toContain("to: '/user/manage/analytics'")
    expect(accountNavSource).toContain("helper: '统计'")

    expect(dashboardSource).toContain("label: '数据概览'")
    expect(dashboardSource).toContain("to: { name: 'ManageAnalytics' }")
    expect(dashboardSource).not.toContain('DashboardAuthorAnalyticsPanel')
    expect(dashboardSource).not.toContain('DashboardCommentModerationPanel')
    expect(dashboardSource).not.toContain('DashboardQuickActionsPanel')
    expect(dashboardSource).not.toContain('DashboardPopularArticles')
    expect(dashboardSource).not.toContain('DashboardRecentComments')
    expect(dashboardSource).not.toContain('访客来源')
    expect(dashboardSource).not.toContain('地域访问')

    expect(analyticsSource).toContain('DashboardAuthorAnalyticsPanel')
    expect(analyticsSource).toContain('访客来源')
    expect(analyticsSource).toContain('地域访问')
  })
})
