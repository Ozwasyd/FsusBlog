import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shellSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicBlogLayoutShell.vue'),
  'utf8',
)
const complianceFooterSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicComplianceFooter.vue'),
  'utf8',
)
const blogLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/BlogLayout.vue'),
  'utf8',
)
const themeToggleSource = readFileSync(
  resolve(process.cwd(), 'src/components/ui/ThemeModeToggle.vue'),
  'utf8',
)
const themeRuntimeSource = readFileSync(
  resolve(process.cwd(), 'src/services/themeRuntime.ts'),
  'utf8',
)
const publicShellCriticalCss = readFileSync(
  resolve(process.cwd(), 'src/assets/public-shell-critical.css'),
  'utf8',
)

describe('PublicBlogLayoutShell responsive header integration', () => {
  it('uses the FsusUI trigger mobile search model without duplicating the trigger', () => {
    expect(shellSource).toContain('mobileSearchExpanded')
    expect(shellSource).toContain('mobileSearchButtonLabel')
    expect(shellSource).toContain('el-public-shell__mobile-search-trigger')
    expect(shellSource).toContain(
      "mobileSearchExpanded.value ? '取消' : '搜索'",
    )
    expect(shellSource).toContain('<template #mobile-primary-actions>')
    expect(shellSource).not.toContain('<template #mobile-actions>')
    expect(shellSource).not.toContain('PublicMobileSearchTrigger')
  })

  it('wires public nav active indicator motion into desktop and mobile nav', () => {
    expect(shellSource).toContain('desktopNavRef')
    expect(shellSource).toContain('mobileNavRef')
    expect(shellSource).toContain('activeNavIndicatorEnabled')
    expect(shellSource).toContain('syncNavIndicators')
    expect(shellSource).toContain('el-public-shell__active-nav-indicator')
    expect(shellSource).toContain("'is-indicator-motion': activeNavIndicatorEnabled")
    expect(shellSource).toContain(':data-active-nav="activeNavIndicatorKey"')
    expect(shellSource).toContain(
      '--el-public-shell-active-nav-indicator-x',
    )
    expect(shellSource).toContain(
      '--el-public-shell-active-nav-indicator-width',
    )
    expect(shellSource).toContain(
      '--el-public-shell-active-nav-indicator-opacity',
    )
  })

  it('keeps public nav as links but hands clicks to the SPA router when enabled', () => {
    expect(shellSource).toContain('spaNavigation: false')
    expect(shellSource).toContain("spaNavigation: boolean")
    expect(shellSource).toContain("(event: 'navigate', href: string): void")
    expect(shellSource).toContain('@click="handleNavClick($event, item.href)"')
    expect(shellSource).toContain('function handleNavClick(event: MouseEvent, href: string): void')
    expect(shellSource).toContain('if (!props.spaNavigation || isModifiedClick(event))')
    expect(shellSource).toContain('event.preventDefault()')
    expect(shellSource).toContain("emit('navigate', href)")
    expect(blogLayoutSource).toContain('@navigate="handleNavigate"')
    expect(blogLayoutSource).toContain('spa-navigation')
    expect(blogLayoutSource).toContain('await router.push(href)')
  })

  it('composes the public header through the Blog site chrome adapter', () => {
    expect(shellSource).toContain('SiteChromeHeaderAdapter')
    expect(shellSource).toContain(':site-title="shellIdentity.siteTitle"')
    expect(shellSource).toContain('brand-link-class="el-public-shell__brand"')
    expect(shellSource).toContain(
      'header-class="el-public-shell__header is-sticky"',
    )
    expect(shellSource).toContain('inner-class="el-public-shell__inner"')
    expect(shellSource).not.toContain('<el-public-shell')
  })

  it('renders mobile theme mode as a localized menu button', () => {
    expect(shellSource).toContain('variant="menu-button"')
    expect(shellSource).toContain(':labels="PUBLIC_THEME_MODE_LABELS"')
    expect(shellSource).toContain("light: '浅色'")
    expect(shellSource).toContain("dark: '深色'")
    expect(shellSource).toContain("system: '跟随系统'")
    expect(shellSource).toContain("systemShort: '系统'")
    expect(shellSource).not.toContain('visibility="mobile" compact')
  })

  it('keeps the header brand text equal to the configured site title', () => {
    expect(shellSource).toContain(':site-title="shellIdentity.siteTitle"')
    expect(shellSource).not.toContain(
      '{{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>',
    )
    expect(complianceFooterSource).toContain('{{ siteTitleText }}')
    expect(complianceFooterSource).not.toContain(
      '{{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>',
    )
  })

  it('provides one public site identity from the shell to page content and footer', () => {
    expect(shellSource).toContain('createPublicSiteIdentity')
    expect(shellSource).toContain('const shellIdentity = computed(() =>')
    expect(shellSource).toContain('createPublicSiteIdentity({')
    expect(shellSource).toContain('siteTitle: siteTitleText.value')
    expect(shellSource).toContain('siteDescription: siteDescriptionText.value')
    expect(shellSource).toContain('providePublicSiteIdentity(shellIdentity)')
    expect(shellSource).toContain(':site-title="shellIdentity.siteTitle"')
    expect(shellSource).toContain(':site-title="shellIdentity.siteTitle"')
    expect(shellSource).toContain(':compliance="shellIdentity.compliance"')
    expect(shellSource).toContain(':render-year="shellIdentity.renderYear"')
  })

  it('uses the shared public fallback title before site data loads', () => {
    expect(shellSource).toContain('PUBLIC_SHELL_DEFAULTS.siteTitle')
    expect(shellSource).not.toContain("siteTitle: '站点'")
  })

  it('passes FsusUI theme toggle variant and labels through the Blog wrapper', () => {
    expect(themeToggleSource).toContain(':variant="variant"')
    expect(themeToggleSource).toContain(':labels="labels"')
    expect(themeToggleSource).toContain("variant?: 'segmented' | 'menu-button'")
    expect(themeToggleSource).toContain('labels?: ThemeModeToggleLabels')
  })

  it('keeps mobile public shell actions aligned when packaged FsusUI CSS lags local DOM', () => {
    expect(publicShellCriticalCss).toContain('.el-public-shell__primary-row')
    expect(publicShellCriticalCss).toContain(
      'grid-template-columns: minmax(0, 1fr) auto;',
    )
    expect(publicShellCriticalCss).toContain(
      '.el-public-shell__mobile-primary-actions',
    )
    expect(publicShellCriticalCss).toContain('display: inline-flex;')
    expect(publicShellCriticalCss).toContain('gap: 8px;')
    expect(publicShellCriticalCss).toContain(
      '.el-public-shell__mobile-search-row',
    )
    expect(publicShellCriticalCss).toContain('margin-top: 12px;')
    expect(publicShellCriticalCss).toContain('margin-bottom: 12px;')
    expect(publicShellCriticalCss).toContain(
      '.el-public-shell__search--trigger',
    )
    expect(publicShellCriticalCss).toContain('width: 100%;')
    expect(publicShellCriticalCss).toContain(
      '.el-public-shell__mobile-search-trigger,',
    )
    expect(publicShellCriticalCss).toContain(
      '.el-theme-mode-toggle__menu-button',
    )
    expect(publicShellCriticalCss).toContain('min-height: 40px;')
  })

  it('applies public main and footer minimum height rules to the current FsusUI shell DOM', () => {
    expect(publicShellCriticalCss).toContain(
      '#fsus-aot-shell .el-public-shell__main',
    )
    expect(publicShellCriticalCss).toContain('min-height: 55vh;')
    expect(publicShellCriticalCss).toContain(
      '#fsus-aot-shell .el-public-shell__footer',
    )
    expect(publicShellCriticalCss).toContain('min-height: 6.5rem;')
  })

  it('keeps public AOT theme toggle hydration-safe before reconciling stored mode', () => {
    expect(themeRuntimeSource).toContain('isHydratingPublicAotShell')
    expect(themeRuntimeSource).toContain("return 'system'")
    expect(themeRuntimeSource).toContain('reconcileThemeRuntimeAfterHydration')
    expect(themeToggleSource).toContain('onMounted(() =>')
    expect(themeToggleSource).toContain('reconcileThemeRuntimeAfterHydration()')
  })

  it('keeps compliance footer year derived from the shell renderYear', () => {
    expect(shellSource).toContain(':render-year="shellIdentity.renderYear"')
    expect(complianceFooterSource).toContain('Number(props.renderYear)')
    expect(complianceFooterSource).toContain('Number.isInteger(renderYear)')
    expect(complianceFooterSource).not.toContain('new Date().getFullYear()')
    expect(blogLayoutSource).toContain(
      'const runtimeRenderYear = ref<number | null>',
    )
    expect(blogLayoutSource).toContain(
      'runtimeRenderYear.value = new Date().getFullYear()',
    )
    expect(blogLayoutSource.indexOf('onMounted(() =>')).toBeLessThan(
      blogLayoutSource.indexOf(
        'runtimeRenderYear.value = new Date().getFullYear()',
      ),
    )
  })
})
