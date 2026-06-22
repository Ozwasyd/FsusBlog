import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public shell ownership boundary', () => {
  const fullApp = readRepoFile('src/frontend/src/bootstrap/fullApp.ts')
  const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')
  const clientHydrate = readRepoFile('src/frontend/src/public-renderers/clientHydrate.ts')
  const aotActionBridge = readRepoFile('src/frontend/src/bootstrap/aotActionBridge.ts')

  it('uses client-only full SPA takeover instead of hydrating App.vue over the AOT shell', () => {
    expect(fullApp).not.toContain('createSSRApp(App)')
    expect(fullApp).toContain('disposePublicShellForClientMount')
    expect(fullApp).toContain('syncRouterToCurrentLocationForClientMount')
    expect(fullApp).toContain('router.replace(targetRoute)')
    expect(fullApp).toContain("app.mount('#app')")
    expect(fullApp).not.toContain("app.mount('#app', shouldHydrate)")
  })

  it('keeps shell disposal inside SPA takeover instead of public HTML remounts', () => {
    expect(clientHydrate).toContain('disposePublicHydrationApp')
    expect(fullApp).toContain('disposePublicHydrationApp')
    expect(fullApp).toContain('disposePublicShellForClientMount')
    expect(publicShell).not.toContain('replacePublicShellForNavigation')
    expect(publicShell).not.toContain('data-public-shell-remount')
    expect(publicShell).not.toContain('function canPatchNode')
    expect(publicShell).not.toContain('replaceChild(')
  })

  it('leaves public route history traversal to Vue Router after takeover', () => {
    expect(publicShell).not.toContain('force?: boolean')
    expect(publicShell).not.toContain("addPublicShellEventListener(window, 'popstate'")
    expect(publicShell).not.toContain('history.scrollRestoration')
    expect(fullApp).toContain('router.push(intent.to)')
  })

  it('owns public shell listeners through an abortable lifetime during SPA commit', () => {
    const lifetime = readRepoFile('src/frontend/src/bootstrap/publicShellLifetime.ts')

    expect(lifetime).toContain('AbortController')
    expect(lifetime).toContain('abortPublicShellLifetime')
    expect(lifetime).toContain('signal: getPublicShellLifetimeSignal()')
    expect(fullApp).toContain("abortPublicShellLifetime('full-app-bootstrap')")
    expect(publicShell).toContain('resetPublicShellLifetime()')
    expect(publicShell).toContain('onPublicShellLifetimeAbort')
    expect(publicShell).toContain("addPublicShellEventListener(document, 'click'")
    expect(publicShell).toContain("addPublicShellEventListener(window, 'fsus:public-shell:takeover'")
    expect(publicShell).toContain("addPublicShellEventListener(window, 'fsus:public-shell:search-focus'")
  })

  it('keeps public shell auth guest-safe instead of probing account endpoints', () => {
    expect(publicShell).toContain('resetPublicShellRuntimeAuthState')
    expect(publicShell).not.toContain('getMe')
    expect(publicShell).not.toContain('getAdminMe')
    expect(publicShell).not.toMatch(/\bsetPublicShellRuntimeAuthState\s*\(/)
    expect(publicShell).not.toMatch(/\bresolvePublicShellRuntimeAuthState\s*\(/)
    expect(publicShell).not.toContain("querySelectorAll<HTMLAnchorElement>('.el-public-shell__auth-link')")
    expect(publicShell).not.toContain('textContent = authState.authLabel')
    expect(publicShell).not.toContain("setAttribute('href', authState.authHref)")
  })

  it('dispatches AOT action events through one shared helper', () => {
    expect(publicShell).toContain('dispatchAotActionEvent')
    expect(aotActionBridge).toContain('dispatchAotActionEvent')
    expect(publicShell).not.toContain("new CustomEvent('fsus:aot:event'")
    expect(aotActionBridge).not.toContain("new CustomEvent('fsus:aot:event'")
  })
})
