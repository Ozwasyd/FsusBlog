import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('pre-hydration browser API safety contracts', () => {
  const adminSettings = readRepoFile('src/frontend/src/composables/useAdminSettingsPage.ts')
  const adminArticleWrite = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts')
  const consoleWelcomeCallout = readRepoFile('src/frontend/src/composables/useConsoleWelcomeCallout.ts')
  const articleToc = readRepoFile('src/frontend/src/composables/article/useArticleToc.ts')
  const fullApp = readRepoFile('src/frontend/src/bootstrap/fullApp.ts')
  const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

  it('does not read browser origin during setup or initial computed render', () => {
    expect(adminSettings).not.toContain('import.meta.env.VITE_API_BASE_URL || window.location.origin')
    expect(adminArticleWrite).not.toContain("typeof window !== 'undefined' ? window.location.origin : ''")
    expect(adminSettings).toContain('mountedBrowserBaseUrl')
    expect(adminArticleWrite).toContain('mountedBrowserSeoBaseUrl')
  })

  it('keeps document and storage reads out of initial render-visible state', () => {
    expect(consoleWelcomeCallout).not.toContain('ref(readDismissed(storageKey.value))')
    expect(consoleWelcomeCallout).toContain('hasMounted')
    expect(consoleWelcomeCallout).toContain('onMounted')
  })

  it('guards article TOC DOM access at the composable boundary', () => {
    expect(articleToc).toContain('getDocumentOrNull')
    expect(articleToc).toContain('getWindowOrNull')
    expect(articleToc).toContain('const documentRef = getDocumentOrNull()')
  })

  it('keeps full-app public takeover render-visible state gated until hydration completes', () => {
    expect(fullApp.indexOf('beginPublicTakeoverCommit({')).toBeLessThan(fullApp.indexOf('app.mount'))
    expect(fullApp.indexOf('completePublicTakeoverCommit({')).toBeGreaterThan(fullApp.indexOf('app.mount'))
    expect(blogLayout).toContain("publicTakeoverPhaseState.value !== 'spa-active'")
    expect(blogLayout).not.toContain('isRuntimeAuthResolved: isMounted.value && runtimeReady.value')
  })
})
