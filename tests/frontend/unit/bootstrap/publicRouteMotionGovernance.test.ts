import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const publicShellMotionPath = repoFile('src/frontend/src/bootstrap/publicShellMotion.ts')

type PublicShellMotionModule = typeof import('@/bootstrap/publicShellMotion')

async function importPublicShellMotion(options: {
  reducedMotion?: boolean
  runMotion?: ReturnType<typeof vi.fn>
} = {}): Promise<{
  module: PublicShellMotionModule
  runMotion: ReturnType<typeof vi.fn>
}> {
  if (!existsSync(publicShellMotionPath)) {
    expect(existsSync(publicShellMotionPath)).toBe(true)
  }

  vi.resetModules()
  const runMotion = options.runMotion ?? vi.fn(() => ({ cancel: vi.fn() }))
  vi.doMock('@/fsusui/motion', () => ({
    fsusBlogMotionPresets: {
      route: 'route-fade'
    },
    runMotion
  }))
  vi.doMock('@/composables/useMotionPreference', () => ({
    getPrefersReducedMotion: vi.fn(() => Boolean(options.reducedMotion))
  }))

  return {
    module: await import('@/bootstrap/publicShellMotion'),
    runMotion
  }
}

describe('public route motion governance', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('data-fsusblog-public-first-paint')
    vi.resetModules()
    vi.clearAllMocks()
  })

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

  it('settles public micro-navigation on the new main content through FsusUI route motion', async () => {
    document.body.innerHTML = `
      <div id="fsus-aot-shell">
        <header>Header</header>
        <main id="main-content">Archive</main>
        <footer>Footer</footer>
      </div>
    `
    const shell = document.querySelector<HTMLElement>('#fsus-aot-shell')
    const main = document.querySelector<HTMLElement>('#main-content')
    expect(shell).toBeInstanceOf(HTMLElement)
    expect(main).toBeInstanceOf(HTMLElement)

    const { module, runMotion } = await importPublicShellMotion()
    const controls = module.settlePublicNavigationMotionForShell(shell!)

    expect(controls).toBeTruthy()
    expect(runMotion).toHaveBeenCalledTimes(1)
    expect(runMotion).toHaveBeenCalledWith(main, expect.objectContaining({
      name: 'route-fade',
      phase: 'enter'
    }))
    expect(runMotion.mock.calls[0]?.[0]).not.toBe(shell)
  })

  it('skips public route settle motion for reduced-motion users and first hydrated DOM', async () => {
    document.body.innerHTML = '<div id="fsus-aot-shell"><main id="main-content">Home</main></div>'
    const shell = document.querySelector<HTMLElement>('#fsus-aot-shell')
    expect(shell).toBeInstanceOf(HTMLElement)

    const reduced = await importPublicShellMotion({ reducedMotion: true })
    expect(reduced.module.settlePublicNavigationMotionForShell(shell!)).toBeNull()
    expect(reduced.runMotion).not.toHaveBeenCalled()

    document.body.setAttribute('data-fsusblog-public-first-paint', 'true')
    const firstPaint = await importPublicShellMotion()
    expect(firstPaint.module.settlePublicNavigationMotionForShell(shell!)).toBeNull()
    expect(firstPaint.runMotion).not.toHaveBeenCalled()
  })

  it('cancels stale public route settle motion during rapid micro-navigation', async () => {
    document.body.innerHTML = `
      <div id="first-shell"><main id="first-main">Archive</main></div>
      <div id="second-shell"><main id="second-main">About</main></div>
    `
    const firstShell = document.querySelector<HTMLElement>('#first-shell')
    const secondShell = document.querySelector<HTMLElement>('#second-shell')
    const firstCancel = vi.fn()
    const secondCancel = vi.fn()
    const runMotion = vi.fn()
      .mockReturnValueOnce({ cancel: firstCancel })
      .mockReturnValueOnce({ cancel: secondCancel })

    expect(firstShell).toBeInstanceOf(HTMLElement)
    expect(secondShell).toBeInstanceOf(HTMLElement)

    const { module } = await importPublicShellMotion({ runMotion })
    module.settlePublicNavigationMotionForShell(firstShell!)
    module.settlePublicNavigationMotionForShell(secondShell!)

    expect(runMotion).toHaveBeenCalledTimes(2)
    expect(firstCancel).toHaveBeenCalledTimes(1)
    expect(secondCancel).not.toHaveBeenCalled()
    expect(runMotion.mock.calls[1]?.[0]).toBe(document.querySelector('#second-main'))
  })

  it('runs public route settle only after a navigation document replaces the shell', () => {
    const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')
    const initialHydrationStart = publicShell.indexOf('async function hydratePublicShell')
    const initialHydrationEnd = publicShell.indexOf('export async function bootstrapPublicShell')
    const applyNavigationStart = publicShell.indexOf('async function applyPublicNavigationDocument')
    const replaceIndex = publicShell.indexOf('const nextShell = replacePublicShellForNavigation', applyNavigationStart)
    const settleIndex = publicShell.indexOf('settlePublicNavigationMotionForShell(nextShell)', applyNavigationStart)

    expect(publicShell).toContain("import { settlePublicNavigationMotionForShell } from '@/bootstrap/publicShellMotion'")
    expect(replaceIndex).toBeGreaterThan(applyNavigationStart)
    expect(settleIndex).toBeGreaterThan(replaceIndex)
    expect(publicShell.slice(initialHydrationStart, initialHydrationEnd)).not.toContain('settlePublicNavigationMotionForShell')
  })

  it('pins public route motion rules in the static governance checker', () => {
    const check = readRepoFile('tests/frontend/checks/static/check-motion-governance.mjs')

    expect(check).toContain('src/frontend/src/App.vue')
    expect(check).toContain('isPublicShellRoute')
    expect(check).toContain('runAppRouteMotion')
    expect(check).toContain('src/frontend/src/layouts/BlogLayout.vue')
    expect(check).toContain('name="fade-fast"')
    expect(check).toContain('.fade-fast-')
    expect(check).toContain('src/frontend/src/bootstrap/publicShellMotion.ts')
    expect(check).toContain('settlePublicNavigationMotionForShell')
    expect(check).toContain('activePublicRouteSettleMotion?.cancel()')
    expect(check).toContain('#main-content, main')
    expect(check).toContain('fsusBlogMotionPresets.route')
  })
})
