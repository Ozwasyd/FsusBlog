import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'fsusblog-acceptance-shared-unit-'))
const fixtureFile = join(fixtureRoot, 'public-content-projection.json')
const originalFixtureFile = process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE
const fixtureIdentity = {
  schema: 'fsusblog.prepared-public-id-projection.v1',
  authority: 'derived-from-current-run-prepared-public-content',
  notAuthoritative: true,
  evidenceUse: 'navigation-input-only',
  ...(process.env.FSUSBLOG_TEST_NAMESPACE
    ? { namespace: process.env.FSUSBLOG_TEST_NAMESPACE }
    : {}),
  ...(process.env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST
    ? { catalogDigest: process.env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST }
    : {}),
  ...((process.env.FSUSBLOG_TEST_SOURCE_COMMIT || process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT)
    ? {
        sourceIdentity: {
          ...(process.env.FSUSBLOG_TEST_SOURCE_COMMIT
            ? { commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT }
            : {}),
          ...(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
            ? { worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT }
            : {})
        }
      }
    : {}),
  sourcePrepareStateDigest: `sha256:${'a'.repeat(64)}`,
  articleId: '1',
  articleTitle: 'Unit fixture',
  categoryId: '1',
  tagId: '1',
  searchKeyword: 'fixture',
  entities: [
    { producerId: 'public-content', kind: 'article', id: '1', handle: 'Unit fixture', variantId: null },
    { producerId: 'public-content', kind: 'category', id: '1', handle: 'Category', variantId: null },
    { producerId: 'public-content', kind: 'tag', id: '1', handle: 'Tag', variantId: null }
  ]
}
const fixturePayload: typeof fixtureIdentity & { projectionDigest: string | null } = {
  ...fixtureIdentity,
  projectionDigest: null
}
const { digestCanonical } = await import('../../../../tools/test-fixtures/receipt/canonical.mjs')
fixturePayload.projectionDigest = digestCanonical({ ...fixturePayload, projectionDigest: undefined })
writeFileSync(fixtureFile, `${JSON.stringify(fixturePayload, null, 2)}\n`)
process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE = fixtureFile

const {
  DESKTOP_VIEWPORT,
  isRecoverablePrewarmFailure,
  normalizeDynamicScreenshotText,
  MOBILE_LANDSCAPE_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  PUBLIC_RUNTIME_DIAGNOSTIC_EVENT_NAMES,
  SHORT_MOBILE_VIEWPORT,
  ULTRA_WIDE_VIEWPORT,
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX
} = await import('../../support/playwright/acceptance-shared')

afterAll(() => {
  if (originalFixtureFile === undefined) delete process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE
  else process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE = originalFixtureFile
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('playwright acceptance shared helper', () => {
  it('loads shared viewport helpers through the frontend toolchain', () => {
    expect(DESKTOP_VIEWPORT).toEqual({ width: 1440, height: 960 })
    expect(MOBILE_VIEWPORT).toEqual({ width: 390, height: 844 })
    expect(NARROW_MOBILE_VIEWPORT).toEqual({ width: 360, height: 780 })
    expect(SHORT_MOBILE_VIEWPORT).toEqual({ width: 390, height: 640 })
    expect(MOBILE_LANDSCAPE_VIEWPORT).toEqual({ width: 844, height: 390 })
    expect(ULTRA_WIDE_VIEWPORT).toEqual({ width: 3440, height: 1440 })
    expect(UX_VIEWPORT_MATRIX.modes.smoke.viewports).toContain('ultra-wide')
    expect(UX_CONTENT_BOUNDARY_CORPUS.cases.map((entry) => entry.kind)).toContain('mermaid')
    expect(PUBLIC_RUNTIME_DIAGNOSTIC_EVENT_NAMES).toEqual([
      'public_route_prewarm_failure',
      'public_route_prewarm_timeout',
      'public_shell_hydration_failed'
    ])
  })

  it('normalizes screenshot evidence without changing unrelated route counters', () => {
    const operationsEvidence = '检查时间：7/23/2026, 3:53:05 AM；最近更新 08/25 13:04；队列 0 / 1；detail=queued=1, dropped=0'
    expect(normalizeDynamicScreenshotText(operationsEvidence, '/user/manage/ops')).toBe(
      '检查时间：1/1/2026, 12:00:00 AM；最近更新 01/01 12:00；队列 0 / 0；detail=queued=0, dropped=0'
    )
    expect(normalizeDynamicScreenshotText(
      'fxpc:public-preview-docs-1883356:public-preview-docs-1883:published:primary',
      '/article/1'
    )).toBe('fixture:public-preview:published:primary')
    expect(normalizeDynamicScreenshotText(
      'Published刚刚 · Updateda minute ago · 3 hours ago · 4 分钟前',
      '/article/1'
    )).toBe('Published2026-01-01 · Updated2026-01-01 · 2026-01-01 · 2026-01-01')
    expect(normalizeDynamicScreenshotText('分页 2 / 7', '/user/manage/comments')).toBe('分页 2 / 7')
  })

  it('recognizes recoverable cold-start failures through readiness error causes', () => {
    const targetClosed = new Error('page.waitForFunction: Target page, context or browser has been closed')
    const wrappedTargetClosed = new Error('application readiness failed', { cause: targetClosed })
    const timeout = new Error('page.waitForFunction: Timeout 120000ms exceeded.')
    timeout.name = 'TimeoutError'

    expect(isRecoverablePrewarmFailure(wrappedTargetClosed, true)).toBe(true)
    expect(isRecoverablePrewarmFailure(wrappedTargetClosed, false)).toBe(false)
    expect(isRecoverablePrewarmFailure(
      new Error('application readiness failed', { cause: timeout }),
      true
    )).toBe(true)
    expect(isRecoverablePrewarmFailure(new Error('route assertion failed'), true)).toBe(false)
  })
})
