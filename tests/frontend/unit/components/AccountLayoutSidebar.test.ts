import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
  'utf8',
)
const accountNavSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/accountNav.ts'),
  'utf8',
)
const accountShellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell.css'),
  'utf8',
)

const countOccurrences = (source: string, needle: string): number =>
  source.split(needle).length - 1

const sliceBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  return startIndex >= 0 && endIndex >= 0
    ? source.slice(startIndex, endIndex + end.length)
    : ''
}

describe('AccountLayout sidebar navigation framing', () => {
  it('removes hero-like area copy from the desktop sidebar', () => {
    expect(accountLayoutSource).not.toContain('areaMeta.eyebrow')
    expect(accountLayoutSource).not.toContain('areaMeta.title')
    expect(accountLayoutSource).not.toContain('areaMeta.description')
    expect(accountLayoutSource).toContain('id="account-shell-area-title"')
    expect(accountLayoutSource).toContain('aria-labelledby="account-shell-area-title"')
    expect(accountLayoutSource).toContain('account-sidebar-index-label')
  })

  it('keeps the desktop sidebar independently scrollable inside the sticky column', () => {
    expect(accountLayoutSource).toContain('account-sidebar-scroll sticky top-24')
    expect(accountLayoutSource).toContain('max-height: calc(100dvh - 7rem);')
    expect(accountLayoutSource).toContain('overflow-y: auto;')
    expect(accountLayoutSource).toContain('overscroll-behavior: contain;')
  })

  it('keeps the desktop content column independently scrollable beside the sidebar', () => {
    expect(accountLayoutSource).toContain('account-main-scroll min-w-0 flex-1')
    expect(accountLayoutSource).toContain('.account-main-scroll {\n  min-height: 0;\n}')
    expect(accountLayoutSource).toMatch(
      /@media \(min-width: 1024px\) \{[\s\S]*?\.account-main-scroll\s*\{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain;/,
    )
  })

  it('keeps mobile navigation in the header drawer without restoring page-level nav chrome', () => {
    expect(accountLayoutSource).toContain('account-mobile-drawer-trigger')
    expect(accountLayoutSource).toContain('id="account-mobile-drawer"')
    expect(accountLayoutSource).toContain('account-mobile-drawer-nav')
    const mobileDrawer = sliceBetween(accountLayoutSource, '<el-drawer', '</el-drawer>')
    expect(mobileDrawer).not.toContain('account-sidebar-index-label')
    expect(accountLayoutSource).toContain('height: 100dvh;')
    expect(accountLayoutSource).toContain('max-height: 100dvh;')
    expect(accountLayoutSource).toContain('overflow: hidden;')
    const mobileDrawerNavCss = sliceBetween(
      accountLayoutSource,
      '.account-mobile-drawer-nav {',
      '}',
    )
    expect(mobileDrawerNavCss).toContain('display: flex;')
    expect(mobileDrawerNavCss).toContain('flex: 0 1 auto;')
    expect(mobileDrawerNavCss).toContain('flex-direction: column;')
    expect(mobileDrawerNavCss).not.toContain('display: grid;')
    expect(accountLayoutSource).toContain('<Expand />')
    expect(accountLayoutSource).toContain("import { Expand } from '@/fsusui/icons'")
    expect(accountLayoutSource).toContain('class="account-nav-link account-mobile-drawer-nav__link group"')
    expect(accountLayoutSource).toContain(':motion="fsusBlogMotionPresets.mobileDrawer"')
    expect(accountLayoutSource).not.toContain('<Menu />')
    expect(accountLayoutSource).not.toContain("import { Menu } from '@/fsusui/icons'")
    expect(accountLayoutSource).not.toContain('account-mobile-navigation')
    expect(accountLayoutSource).not.toContain('account-mobile-group-control')
    expect(accountLayoutSource).not.toContain('account-mobile-link-strip')
    expect(accountLayoutSource).not.toContain('aria-label="关闭导航"')
    expect(accountLayoutSource).not.toContain(
      'text-[1.75rem] font-bold leading-none',
    )
  })

  it('keeps policy actions in desktop header and mobile drawer without duplicating them in the desktop sidebar', () => {
    const mobileDrawer = sliceBetween(accountLayoutSource, '<el-drawer', '</el-drawer>')
    const desktopSidebar = sliceBetween(accountLayoutSource, '<aside class="hidden', '</aside>')

    expect(countOccurrences(accountLayoutSource, "openPolicy('guidelines')")).toBe(2)
    expect(countOccurrences(accountLayoutSource, "openPolicy('privacy')")).toBe(2)
    expect(mobileDrawer).toContain('account-mobile-drawer-footer')
    expect(mobileDrawer).toContain("openPolicy('guidelines')")
    expect(mobileDrawer).toContain("openPolicy('privacy')")
    expect(desktopSidebar).not.toContain("openPolicy('guidelines')")
    expect(desktopSidebar).not.toContain("openPolicy('privacy')")
  })

  it('keeps account page switching animation owned by the layout transition', () => {
    expect(accountLayoutSource).toContain('<FsuTransition :name="fsusBlogMotionPresets.route"')
    expect(accountLayoutSource).toContain(':duration="220"')
    expect(accountLayoutSource).toContain(':key="accountRouteViewKey"')
    expect(accountShellCss).toContain('.account-motion-enter')
    expect(accountShellCss).not.toMatch(/\.account-motion-enter\s*\{[^}]*blog-motion-page-enter/s)
  })

  it('reduces account area metadata to functional labels', () => {
    expect(accountNavSource).toContain('label: string')
    expect(accountNavSource).toContain("label: '账户'")
    expect(accountNavSource).toContain("label: '管理'")
    expect(accountNavSource).not.toContain('eyebrow:')
    expect(accountNavSource).not.toContain('description:')
  })
})
