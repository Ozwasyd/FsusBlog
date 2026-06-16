import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shellSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicBlogLayoutShell.vue'),
  'utf8'
)
const complianceFooterSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicComplianceFooter.vue'),
  'utf8'
)
const blogLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/BlogLayout.vue'),
  'utf8'
)
const themeToggleSource = readFileSync(
  resolve(process.cwd(), 'src/components/ui/ThemeModeToggle.vue'),
  'utf8'
)
const themeRuntimeSource = readFileSync(
  resolve(process.cwd(), 'src/services/themeRuntime.ts'),
  'utf8'
)

describe('PublicBlogLayoutShell responsive header integration', () => {
  it('uses the FsusUI trigger mobile search model without duplicating the trigger', () => {
    expect(shellSource).toContain('mobile-search-mode="trigger"')
    expect(shellSource).toContain('mobile-search-trigger-label="搜索"')
    expect(shellSource).toContain('mobile-search-cancel-label="取消"')
    expect(shellSource).toContain('<template #mobile-primary-actions>')
    expect(shellSource).not.toContain('<template #mobile-actions>')
    expect(shellSource).not.toContain('PublicMobileSearchTrigger')
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
    expect(shellSource).toContain('{{ siteTitleText }}')
    expect(shellSource).not.toContain('{{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>')
  })

  it('passes FsusUI theme toggle variant and labels through the Blog wrapper', () => {
    expect(themeToggleSource).toContain(':variant="variant"')
    expect(themeToggleSource).toContain(':labels="labels"')
    expect(themeToggleSource).toContain("variant?: 'segmented' | 'menu-button'")
    expect(themeToggleSource).toContain('labels?: ThemeModeToggleLabels')
  })

  it('keeps public AOT theme toggle hydration-safe before reconciling stored mode', () => {
    expect(themeRuntimeSource).toContain('isHydratingPublicAotShell')
    expect(themeRuntimeSource).toContain("return 'system'")
    expect(themeRuntimeSource).toContain('reconcileThemeRuntimeAfterHydration')
    expect(themeToggleSource).toContain('onMounted(() =>')
    expect(themeToggleSource).toContain('reconcileThemeRuntimeAfterHydration()')
  })

  it('keeps compliance footer year derived from the shell renderYear', () => {
    expect(shellSource).toContain(':render-year="renderYear"')
    expect(complianceFooterSource).toContain('Number(props.renderYear)')
    expect(complianceFooterSource).toContain('Number.isInteger(renderYear)')
    expect(complianceFooterSource).not.toContain('new Date().getFullYear()')
    expect(blogLayoutSource).toContain('const runtimeRenderYear = ref<number | null>')
    expect(blogLayoutSource).toContain('runtimeRenderYear.value = new Date().getFullYear()')
    expect(blogLayoutSource.indexOf('onMounted(() =>')).toBeLessThan(
      blogLayoutSource.indexOf('runtimeRenderYear.value = new Date().getFullYear()')
    )
  })
})
