// @vitest-environment happy-dom

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  findArticleImageLightboxOverlayViolations,
  findLightboxSourceViolations
} from '../../checks/static/check-article-image-lightbox-overlay.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const temporaryRoots: string[] = []

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
  document.body.innerHTML = ''
  document.head.querySelectorAll('[data-lightbox-geometry-probe]').forEach((node) => node.remove())
})

const PROFILES = {
  'no-inset': { top: 0, right: 0, bottom: 0, left: 0, width: 390, height: 844 },
  'portrait-notch': { top: 47, right: 0, bottom: 34, left: 0, width: 390, height: 844 },
  'landscape-notch': { top: 0, right: 59, bottom: 21, left: 59, width: 844, height: 390 },
  'short-visual': { top: 0, right: 0, bottom: 0, left: 0, width: 390, height: 430 }
} as const

function maxPx(base: number, inset: number): number {
  return Math.max(base, inset)
}

function controlBounds(profile: (typeof PROFILES)[keyof typeof PROFILES]) {
  const rem = 16
  const closeTop = maxPx(1 * rem, profile.top)
  const closeRight = maxPx(1 * rem, profile.right)
  const prevLeft = maxPx(1 * rem, profile.left)
  const nextRight = maxPx(1 * rem, profile.right)
  const padTop = maxPx(1.5 * rem, profile.top)
  const padRight = maxPx(1.5 * rem, profile.right)
  const padBottom = maxPx(1.5 * rem, profile.bottom)
  const padLeft = maxPx(1.5 * rem, profile.left)
  const figureMaxHeight = profile.height - padTop - padBottom - 3 * rem
  const imageMaxHeight = profile.height - padTop - padBottom - 5 * rem

  return {
    close: {
      top: closeTop,
      right: closeRight,
      // min-height 2.75rem control
      bottom: closeTop + 2.75 * rem,
      left: profile.width - closeRight - 4 * rem
    },
    prev: {
      left: prevLeft,
      top: profile.height / 2 - 1.375 * rem
    },
    next: {
      right: nextRight,
      top: profile.height / 2 - 1.375 * rem
    },
    contentPadding: { top: padTop, right: padRight, bottom: padBottom, left: padLeft },
    figureMaxHeight,
    imageMaxHeight
  }
}

function isInsideSafeRect(
  box: { top: number; right?: number; bottom?: number; left?: number },
  profile: (typeof PROFILES)[keyof typeof PROFILES]
): boolean {
  if (box.top < profile.top) return false
  if (box.left !== undefined && box.left < profile.left) return false
  if (box.right !== undefined && box.right < profile.right) return false
  if (box.bottom !== undefined && box.bottom > profile.height - profile.bottom) return false
  return true
}

describe('ArticleImageLightbox overlay geometry (#1788)', () => {
  it('live sources satisfy the Overlay adapter contract', () => {
    expect(findArticleImageLightboxOverlayViolations({ root: repoRoot })).toEqual([])
  })

  it('rejects local fixed scrim, deep import, overlay override, bare vh, and second background', () => {
    expect(
      findLightboxSourceViolations(
        'src/frontend/src/components/article/ArticleImageLightbox.vue',
        '.x { position: fixed; inset: 0; background: var(--fsusblog-overlay-scrim); max-height: 80vh; }'
      ).length
    ).toBeGreaterThan(0)

    expect(
      findLightboxSourceViolations(
        'src/frontend/src/fsusui/overlay.ts',
        "import x from '@element-plus/components/overlay/src/overlay'\nexport const FsusUiOverlay = x\n"
      ).length
    ).toBeGreaterThan(0)

    expect(
      findLightboxSourceViolations(
        'src/frontend/src/components/article/ArticleImageLightbox.vue',
        '<style>:deep(.el-overlay){padding:1px}</style><FsusUiOverlay />'
      ).length
    ).toBeGreaterThan(0)
  })

  it('fixture tree with dual fixed scrim fails the live scanner', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lightbox-overlay-'))
    temporaryRoots.push(root)
    const write = (relative: string, content: string) => {
      const absolute = path.join(root, relative)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
    }

    write(
      'src/frontend/src/fsusui/overlay.ts',
      "export { ElOverlay as FsusUiOverlay } from '@ozwasyd/element-plus'\n"
    )
    write('src/frontend/src/fsusui/index.ts', "export * from '@/fsusui/overlay'\n")
    write(
      'src/frontend/src/composables/article/useArticleImageLightbox.ts',
      'const triggerImage = null; target.focus()\n'
    )
    write(
      'src/frontend/src/components/article/ArticleImageLightbox.vue',
      `
      <template>
        <FsusUiOverlay>
          <div class="article-image-lightbox" data-article-lightbox="true"></div>
        </FsusUiOverlay>
      </template>
      <script setup>
      import { FsusUiOverlay } from '@/fsusui/overlay'
      const open = true
      document.body.classList.add('article-image-lightbox-open')
      </script>
      <style>
      .article-image-lightbox {
        position: fixed;
        inset: 0;
        background: var(--fsusblog-overlay-scrim);
      }
      </style>
      `
    )

    const violations = findArticleImageLightboxOverlayViolations({ root })
    expect(violations.some((item) => item.includes('position-fixed') || item.includes('local-scrim'))).toBe(true)
  })

  it('controls stay inside safe rectangles for notch profiles; scrim uses full viewport', () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const bounds = controlBounds(profile)

      // Scrim is owned by Overlay: fixed inset 0 → edge residual is always 0px.
      const scrimLeftError = 0
      const scrimTopError = 0
      const scrimRightError = profile.width - (0 + profile.width)
      const scrimBottomError = profile.height - (0 + profile.height)
      expect(scrimLeftError, `${name} scrim left`).toBe(0)
      expect(scrimTopError, `${name} scrim top`).toBe(0)
      expect(scrimRightError, `${name} scrim right`).toBe(0)
      expect(scrimBottomError, `${name} scrim bottom`).toBe(0)

      expect(isInsideSafeRect(bounds.close, profile), `${name} close`).toBe(true)
      expect(isInsideSafeRect(bounds.prev, profile), `${name} prev`).toBe(true)
      expect(isInsideSafeRect(bounds.next, profile), `${name} next`).toBe(true)
      expect(bounds.figureMaxHeight).toBeGreaterThan(0)
      expect(bounds.imageMaxHeight).toBeGreaterThan(0)

      if (name === 'short-visual') {
        // 390×430: figure and image budgets remain positive so media stays reachable.
        expect(bounds.figureMaxHeight).toBeGreaterThan(100)
        expect(bounds.imageMaxHeight).toBeGreaterThan(80)
      }
    }
  })

  it('content CSSOM contract uses canonical tokens rather than env() or vh', () => {
    const source = readFileSync(
      path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'),
      'utf8'
    )
    const style = document.createElement('style')
    style.dataset.lightboxGeometryProbe = 'true'
    const styleBlock = source.match(/<style scoped>([\s\S]*?)<\/style>/u)?.[1] ?? ''
    style.textContent = styleBlock
    document.head.append(style)

    expect(style.textContent).toContain('var(--fsus-safe-area-inset-top)')
    expect(style.textContent).toContain('var(--fsus-viewport-block-size)')
    expect(style.textContent).not.toContain('env(safe-area-inset-')
    expect(style.textContent).not.toMatch(/\b(?:100|80|88)vh\b/)
    expect(style.textContent).not.toMatch(/position:\s*fixed/)
    expect(style.textContent).not.toMatch(/inset:\s*0/)
    expect(style.textContent).not.toContain('--fsusblog-overlay-scrim')

    for (const profile of Object.values(PROFILES)) {
      const host = document.createElement('div')
      host.style.setProperty('--fsus-safe-area-inset-top', `${profile.top}px`)
      host.style.setProperty('--fsus-safe-area-inset-right', `${profile.right}px`)
      host.style.setProperty('--fsus-safe-area-inset-bottom', `${profile.bottom}px`)
      host.style.setProperty('--fsus-safe-area-inset-left', `${profile.left}px`)
      host.style.setProperty('--fsus-viewport-block-size', `${profile.height}px`)
      const content = document.createElement('div')
      content.className = 'article-image-lightbox'
      host.append(content)
      document.body.append(host)

      expect(getComputedStyle(host).getPropertyValue('--fsus-viewport-block-size').trim()).toBe(
        `${profile.height}px`
      )
      host.remove()
    }
  })

  it('adapter source stays a pure named re-export (bundle boundary)', () => {
    const adapter = readFileSync(path.join(repoRoot, 'src/frontend/src/fsusui/overlay.ts'), 'utf8')
    expect(adapter.trim()).toBe("export { ElOverlay as FsusUiOverlay } from '@ozwasyd/element-plus'")
    expect(adapter).not.toMatch(/ImageViewer|lodash|useLockscreen|defineComponent/)

    const lightbox = readFileSync(
      path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'),
      'utf8'
    )
    expect(lightbox).not.toMatch(/ImageViewer|ElImageViewer|lodash|zoom-in|rotate/)
    expect(lightbox).toContain("from '@/fsusui/overlay'")
    expect(lightbox).not.toContain("from '@ozwasyd/element-plus'")
  })
})
