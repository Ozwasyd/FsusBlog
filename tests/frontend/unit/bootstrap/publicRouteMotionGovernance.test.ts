import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public route motion governance', () => {
  it('routes all public shell SPA views through App-level FsusUI route motion', () => {
    const appVue = readRepoFile('src/frontend/src/App.vue')
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(appVue).toContain('isPublicShellRoute')
    expect(appVue).toContain('v-if="isPublicShellRoute"')
    expect(appVue).toContain('<Transition')
    expect(appVue).toContain('@enter="runAppRouteEnter"')
    expect(appVue).toContain('@leave="runAppRouteLeave"')
    expect(appVue).toContain(':key="route.fullPath"')
    expect(appVue).toContain('runMotion')
    expect(appVue).toContain('useMotionRouteCleanup')
    expect(appVue).toContain('fsusBlogMotionPresets.route')
    expect(appVue).not.toContain('v-if="isPublicSeoRoute"')
    expect(appVue).not.toContain('<RouterView v-if="isPublicSeoRoute"')
    expect(blogLayout).toContain(':spa-navigation="isMounted"')
    expect(blogLayout).toContain('@navigate="handleNavigate"')
    expect(blogLayout).not.toContain('v-if="isSeoShellRoute"')
    expect(blogLayout).not.toContain('isPublicSeoRouteName')
    expect(blogLayout).not.toContain('FsusBlogRouteTransition')
    expect(blogLayout).not.toContain('name="fade-fast"')
    expect(blogLayout).not.toContain('.fade-fast-')
  })

  it('keeps the reusable route transition component keyed when it is used outside App shell routing', () => {
    const transition = readRepoFile('src/frontend/src/components/ui/FsusBlogRouteTransition.vue')

    expect(transition).toMatch(/h\(\s*Transition/u)
    expect(transition).toContain('routeKey')
    expect(transition).toContain('cloneVNode')
    expect(transition).toContain('renderRouteSlot')
    expect(transition).not.toContain('<slot')
  })

  it('does not split Search and SEO public shell routes across different App branches', () => {
    const appVue = readRepoFile('src/frontend/src/App.vue')
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(appVue).toContain('isPublicShellRouteName')
    expect(appVue).toContain('isPublicShellRoute')
    expect(appVue).not.toContain('isPublicSeoRouteName')
    expect(appVue).not.toContain('isPublicSeoRoute =')
    expect(blogLayout).not.toContain('v-if="isSeoShellRoute"')
    expect(blogLayout).not.toContain('v-else :name="fsusBlogMotionPresets.route"')
  })

  it('keeps public shell navigation out of detached DOM route motion', () => {
    const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')

    expect(publicShell).toContain('navigateWithAtomicPublicTakeover')
    expect(publicShell).toContain('commitPreparedFullApp')
    expect(publicShell).not.toContain('settlePublicNavigationMotionForShell')
    expect(publicShell).not.toContain('replacePublicShellForNavigation')
    expect(publicShell).not.toContain('applyPublicNavigationDocument')
  })

  it('pins public route motion rules in the static governance checker', () => {
    const check = readRepoFile('tests/frontend/checks/static/check-motion-governance.mjs')

    expect(check).toContain('src/frontend/src/App.vue')
    expect(check).toContain('isPublicShellRoute')
    expect(check).toContain('runAppRouteMotion')
    expect(check).toContain('src/frontend/src/layouts/BlogLayout.vue')
    expect(check).toContain('name="fade-fast"')
    expect(check).toContain('.fade-fast-')
    expect(check).toContain('navigateWithAtomicPublicTakeover')
    expect(check).toContain('commitPreparedFullApp')
    expect(check).toContain('settlePublicNavigationMotionForShell')
    expect(check).toContain('replacePublicShellForNavigation')
    expect(check).toContain('fsusBlogMotionPresets.route')
  })
})
