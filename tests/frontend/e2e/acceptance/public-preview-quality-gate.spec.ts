import { expect, test, type Page } from '@playwright/test'

import {
  auditPublicPreviewPage,
  type PublicPreviewHeaderSample,
  type PublicPreviewQualityPolicy,
  type PublicPreviewQualityScenario
} from '../../../../tools/docs/public-preview-quality.mjs'

const policy: PublicPreviewQualityPolicy = {
  mobileMaxWidth: 768,
  normalHitTargetMinPx: 40,
  primaryHitTargetHeightMinPx: 44,
  focusClipTolerancePx: 2,
  layoutShiftMaxPx: 1,
  overflowTolerancePx: 1,
  maxTaskPanels: 8,
  maxBadges: 12,
  maxPrimaryActions: 3,
  maxUnscopedRadiusPx: 12,
  reviewerStatuses: ['pass', 'fail', 'needs-design-review'],
  localeTokens: {
    'zh-CN': ['登录', '菜单', '搜索'],
    'en-US': ['Login', 'Menu', 'Search']
  },
  uiChromeSelectors: ['[data-ui-chrome]'],
  userContentSelectors: ['[data-user-content]'],
  primaryHitTargetSelectors: ['[data-public-shell-action]', '[data-primary-action]'],
  panelSelectors: ['[data-task-panel]'],
  badgeSelectors: ['[data-status-badge]'],
  primaryActionSelectors: ['[data-primary-action]']
}

const stableHeader: PublicPreviewHeaderSample[] = [
  { phase: 'application-ready', rect: { x: 0, y: 0, width: 390, height: 44 } },
  { phase: 'stable', rect: { x: 0, y: 0, width: 390, height: 44 } }
]

function scenario(overrides: Partial<PublicPreviewQualityScenario> = {}): PublicPreviewQualityScenario {
  return {
    id: 'quality-negative-fixture',
    route: 'ArticleDetail',
    viewport: { width: 390, height: 844 },
    theme: 'light',
    locale: 'zh-CN',
    zoom: 1,
    scope: 'anonymous',
    surfaceRole: 'public',
    linkedIssues: [1476],
    primaryTaskSelectors: [],
    ...overrides
  }
}

async function audit(page: Page, currentScenario: PublicPreviewQualityScenario, samples = stableHeader) {
  return await auditPublicPreviewPage(page, currentScenario, policy, { headerSamples: samples })
}

test.describe('public-preview quality gate negative fixtures', () => {
  test('passes a coherent public surface while excluding marked user content from locale checks', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <body style="margin:0">
          <header data-public-shell-header data-ui-chrome style="height:44px">
            <a data-public-shell-action href="#" style="display:inline-flex;width:44px;height:44px;align-items:center">菜单</a>
          </header>
          <main>
            <h1>文章标题</h1>
            <p data-user-content>Menu is allowed inside marked author content.</p>
          </main>
        </body>
      </html>
    `)

    const report = await audit(page, scenario())
    expect(report.status).toBe('pass')
    expect(report.machine.localeCoherence.status).toBe('pass')
    expect(report.machine.hitTargets.status).toBe('pass')
  })

  test('fails mixed chrome locale, overflow, clipped text, overlap and undersized mobile actions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <body style="margin:0;width:520px">
          <header data-public-shell-header data-ui-chrome style="height:44px">Menu</header>
          <main>
            <h1 style="width:80px;height:20px;overflow:hidden;white-space:nowrap">不会被静默裁切的长标题</h1>
            <button data-public-shell-action style="position:absolute;left:0;top:80px;width:24px;height:24px">搜索</button>
            <button style="position:absolute;left:12px;top:88px;width:40px;height:40px">操作</button>
          </main>
        </body>
      </html>
    `)

    const report = await audit(page, scenario())
    expect(report.status).toBe('fail')
    expect(report.machine.localeCoherence.status).toBe('fail')
    expect(report.machine.overflow.status).toBe('fail')
    expect(report.machine.clippedText.status).toBe('fail')
    expect(report.machine.overlaps.status).toBe('fail')
    expect(report.machine.hitTargets.status).toBe('fail')
  })

  test('fails a task surface whose primary result is below the first viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <body style="margin:0">
          <header data-public-shell-header data-ui-chrome style="height:44px">菜单</header>
          <main style="padding-top:900px"><section data-primary-result>结果</section></main>
        </body>
      </html>
    `)

    const report = await audit(page, scenario({
      id: 'task-first-viewport-negative',
      route: 'AdminDashboard',
      viewport: { width: 1366, height: 768 },
      scope: 'admin',
      surfaceRole: 'task',
      primaryTaskSelectors: ['[data-primary-result]']
    }), [
      { phase: 'application-ready', rect: { x: 0, y: 0, width: 1366, height: 44 } },
      { phase: 'stable', rect: { x: 0, y: 0, width: 1366, height: 44 } }
    ])

    expect(report.status).toBe('fail')
    expect(report.machine.primaryTask.status).toBe('fail')
  })

  test('routes card nesting to deterministic design review instead of accepting a stable bad baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <body style="margin:0">
          <header data-public-shell-header data-ui-chrome style="height:44px">菜单</header>
          <main><section data-task-panel><div data-task-panel>任务结果</div></section></main>
        </body>
      </html>
    `)

    const report = await audit(page, scenario({
      id: 'nested-task-panel-review',
      route: 'AdminDashboard',
      viewport: { width: 1366, height: 768 },
      scope: 'admin',
      surfaceRole: 'task'
    }), [
      { phase: 'application-ready', rect: { x: 0, y: 0, width: 1366, height: 44 } },
      { phase: 'stable', rect: { x: 0, y: 0, width: 1366, height: 44 } }
    ])

    expect(report.status).toBe('needs-design-review')
    expect(report.reviewer.reasons).toContain('nested panel count=1')
  })
})
