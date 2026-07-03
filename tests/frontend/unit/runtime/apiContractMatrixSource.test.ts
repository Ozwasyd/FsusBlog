import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('api contract matrix runtime resilience', () => {
  it('resets local public-read risk state and retries once after 429 responses', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/runtime/api-contract-matrix.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('response.status === 429')
    expect(source).toContain('resetLocalSecurityRiskState()')
    expect(source).toContain('api-contract-rate-limit-retry')
  })

  it('clears persisted local security risk events before retrying public-read contracts', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/runtime/api-contract-matrix.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('FSUSBLOG_PG_CONTAINER')
    expect(source).toContain('delete from security_risk_event')
    expect(source).toContain('resetLocalPersistedSecurityRiskState()')
  })

  it('materializes public article routes from bootstrap fixture ids', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/runtime/api-contract-matrix.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('readPublicFixtureIds')
    expect(source).toContain('publicFixtureIds.articleId')
    expect(source).toContain('publicFixtureIds.categoryId')
    expect(source).toContain('publicFixtureIds.tagId')
  })

  it('suppresses notification stream during runtime resilience page sweeps', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/resilience/check-runtime-resilience.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__')
    expect(source).toContain('fsusDisableNotificationStream')
    expect(source).toContain('addRuntimeIsolation')
  })

  it('accepts fixture sessions that only expose cookie headers', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/resilience/check-runtime-resilience.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('function toCookieEntries')
    expect(source).toContain('session.cookieMap ?? session.cookieHeader')
  })

  it('opens a fresh Playwright page for each runtime resilience route', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/resilience/check-runtime-resilience.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('async function visitAuditedRoute')
    expect(source).toContain('const page = await context.newPage()')
    expect(source).toContain('await page.close().catch(() => {})')
  })

  it('does not require document complete before asserting the search runtime shell', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/public/check-search-runtime.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain("waitForSelector('#app'")
    expect(source).not.toContain("document.readyState === 'complete' && Boolean(document.querySelector('#app'))")
  })

  it('sends trusted origin and one-time admin proof for runtime resilience article mutations', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/resilience/check-runtime-resilience.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('createAdminStepUpProofToken')
    expect(source).toContain('const trustedOrigin =')
    expect(source).toContain('headers: { Origin: trustedOrigin }')
    expect(source).toContain("'X-Fsus-Mfa-Proof': trashProofToken")
    expect(source).toContain("'X-Fsus-Mfa-Proof': permanentProofToken")
  })

  it('sends trusted origin and upload token for upload resilience mutations', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/resilience/check-upload-resilience.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('const trustedOrigin =')
    expect(source).toContain('Origin: trustedOrigin')
    expect(source).toContain("'X-Fsus-Upload-Token': uploadToken")
    expect(source).toContain('upload init missing uploadToken')
    expect(source).toContain('tiny upload init missing uploadToken')
  })

  it('accepts article detail artifact 404 only through the explicit public artifact miss branch', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../tests/frontend/checks/runtime/api-contract-matrix.mjs', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('optionalNotFoundPublicChecks')
    expect(source).toContain('binary_get_article_id_aeds')
    expect(source).toContain('binary_get_article_list_category_categoryId_page_size_aeds')
    expect(source).toContain('binary_get_article_list_tag_tagId_page_size_aeds')
    expect(source).toContain('optional-not-found')
  })
})
