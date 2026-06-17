import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public route motion governance', () => {
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
})
