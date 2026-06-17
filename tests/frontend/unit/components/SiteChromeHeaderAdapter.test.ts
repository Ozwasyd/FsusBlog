import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const adapterSource = readFileSync(
  resolve(process.cwd(), 'src/components/layout/SiteChromeHeaderAdapter.vue'),
  'utf8',
)
const fsusUiSiteHeaderSource = readFileSync(
  resolve(process.cwd(), 'src/fsusui/siteHeader.ts'),
  'utf8',
)
const fsusUiExportContractSource = readFileSync(
  resolve(
    process.cwd(),
    '../../tests/frontend/typecheck/fsusui-export-contract.ts',
  ),
  'utf8',
)

describe('SiteChromeHeaderAdapter contract', () => {
  it('keeps the Blog header adapter on the FsusUI site header primitive', () => {
    expect(fsusUiSiteHeaderSource).toContain(
      "import { ElSiteHeader } from '@ozwasyd/element-plus'",
    )
    expect(adapterSource).toContain('<FsusUiSiteHeader')
    expect(adapterSource).toContain(':inner-class="innerClass"')
    expect(adapterSource).toContain(
      ':desktop-actions-class="desktopActionsClass"',
    )
    expect(adapterSource).toContain(
      ':mobile-primary-actions-class="mobilePrimaryActionsClass"',
    )
  })

  it('centralizes brand image fallback order for all layouts', () => {
    const publicLightStart = adapterSource.indexOf('const publicLight = [')
    const publicDarkStart = adapterSource.indexOf('const publicDark = [')
    const authStart = adapterSource.indexOf(
      "if (props.brandContext === 'auth')",
    )

    expect(publicLightStart).toBeGreaterThan(-1)
    expect(publicDarkStart).toBeGreaterThan(publicLightStart)
    expect(authStart).toBeGreaterThan(publicDarkStart)

    const publicLight = adapterSource.slice(publicLightStart, publicDarkStart)
    const publicDark = adapterSource.slice(publicDarkStart, authStart)

    expect(publicLight.indexOf('props.siteWordmarkUrl')).toBeLessThan(
      publicLight.indexOf('props.siteLogoUrl'),
    )
    expect(publicLight.indexOf('props.siteLogoUrl')).toBeLessThan(
      publicLight.indexOf('props.siteLogoDarkUrl'),
    )
    expect(publicDark.indexOf('props.siteWordmarkUrl')).toBeLessThan(
      publicDark.indexOf('props.siteLogoDarkUrl'),
    )
    expect(publicDark.indexOf('props.siteLogoDarkUrl')).toBeLessThan(
      publicDark.indexOf('props.siteLogoUrl'),
    )
    expect(adapterSource).toContain("if (props.brandContext === 'auth')")
    expect(adapterSource).toContain("if (props.brandContext === 'account')")
    expect(adapterSource).toContain('site-chrome-header__brand-image--light')
    expect(adapterSource).toContain('site-chrome-header__brand-image--dark')
  })

  it('owns public navigation and theme toggle composition at the Blog boundary', () => {
    expect(adapterSource).toContain('export type SiteChromeNavItem')
    expect(adapterSource).toContain('showDesktopThemeToggle')
    expect(adapterSource).toContain('showMobileThemeToggle')
    expect(adapterSource).toContain('ThemeModeToggle')
    expect(adapterSource).toContain("system: '跟随系统'")
    expect(adapterSource).toContain(':data-public-nav="item.key"')
  })

  it('includes the new primitive in the local FsusUI export contract', () => {
    expect(fsusUiExportContractSource).toContain('ElSiteHeader')
  })
})
