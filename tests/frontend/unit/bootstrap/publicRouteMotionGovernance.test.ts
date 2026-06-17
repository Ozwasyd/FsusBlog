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

  it('routes non-SEO public SPA views through the shared FsusUI route transition', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')

    expect(blogLayout).toContain('v-if="isSeoShellRoute"')
    expect(blogLayout).toContain('<FsusBlogRouteTransition')
    expect(blogLayout).toContain(':name="fsusBlogMotionPresets.route"')
    expect(blogLayout).toContain('import FsusBlogRouteTransition')
    expect(blogLayout).toContain('fsusBlogMotionPresets')
    expect(blogLayout).not.toContain('name="fade-fast"')
    expect(blogLayout).not.toContain('.fade-fast-')
  })

  it('keeps SEO public shell views outside ordinary Vue route transitions', () => {
    const blogLayout = readRepoFile('src/frontend/src/layouts/BlogLayout.vue')
    const directSeoRenderIndex = blogLayout.indexOf('v-if="isSeoShellRoute"')
    const sharedTransitionIndex = blogLayout.indexOf('<FsusBlogRouteTransition')

    expect(directSeoRenderIndex).toBeGreaterThanOrEqual(0)
    expect(sharedTransitionIndex).toBeGreaterThan(directSeoRenderIndex)
    expect(blogLayout.slice(directSeoRenderIndex, sharedTransitionIndex)).not.toContain('<Transition')
    expect(blogLayout.slice(directSeoRenderIndex, sharedTransitionIndex)).not.toContain('<transition')
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
})
