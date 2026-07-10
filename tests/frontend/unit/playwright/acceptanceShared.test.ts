import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'fsusblog-acceptance-shared-unit-'))
const fixtureFile = join(fixtureRoot, 'public.aeds')
const originalFixtureFile = process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
const fixturePayload = {
  generatedAt: '2026-07-10T00:00:00.000Z',
  baseUrl: 'http://127.0.0.1:3000',
  articleId: '1',
  articleTitle: 'Unit fixture',
  categoryId: '1',
  tagId: '1',
  searchKeyword: 'fixture',
  bodyProbeText: 'fixture body',
  showReadingNotice: 'false',
  wordCount: '10',
  estimatedReadingMinutes: '1'
}
writeFileSync(fixtureFile, `${Object.entries(fixturePayload)
  .map(([key, value]) => `${key}\t${Buffer.from(value).toString('base64url')}`)
  .join('\n')}\n`)
process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE = fixtureFile

const {
  DESKTOP_VIEWPORT,
  MOBILE_LANDSCAPE_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  SHORT_MOBILE_VIEWPORT,
  ULTRA_WIDE_VIEWPORT,
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX
} = await import('../../support/playwright/acceptance-shared')

const repoRoot = resolve(__dirname, '../../../..')

afterAll(() => {
  if (originalFixtureFile === undefined) delete process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
  else process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE = originalFixtureFile
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
  })

  it('treats sandboxed srcdoc script blocking as an expected preview isolation signal', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')

    expect(source).toContain("Blocked script execution in 'about:srcdoc'")
    expect(source).toContain("the document's frame is sandboxed")
    expect(source).toContain("'allow-scripts' permission is not set")
  })

  it('does not count expected MFA step-up challenge responses as runtime noise', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')

    expect(source).toContain("url.includes('/api/binary/auth/mfa/challenge/start') && status === 428")
    expect(source).toContain("text.includes('PASSWORD_OR_STEP_UP_PROOF_REQUIRED')")
    expect(source).toContain("text.includes('status: 428')")
  })

  it('pins audited browser contexts to the configured frontend base URL', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')

    expect(source).toContain('baseURL: process.env.PLAYWRIGHT_BASE_URL')
    expect(source).toContain("process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'")
  })

  it('keeps mobile landscape chrome checks scoped to navigation chrome', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')

    expect(source).toContain("header.closest('main, article')")
  })
})
