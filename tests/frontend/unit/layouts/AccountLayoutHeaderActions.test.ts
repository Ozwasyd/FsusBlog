// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
  'utf8'
)
const shellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell-base.css'),
  'utf8'
)

describe('AccountLayout desktop header actions', () => {
  it('gives the locale action the same 40px paper control treatment', () => {
    const desktopActions = layoutSource.match(
      /<template #desktop-actions>([\s\S]*?)<\/template>/
    )?.[1] ?? ''
    const mobileActions = layoutSource.match(
      /<template #mobile-primary-actions>([\s\S]*?)<\/template>/
    )?.[1] ?? ''

    expect(desktopActions).toContain('class="account-header-locale-action"')
    expect(desktopActions).toContain('bordered')
    expect(mobileActions).not.toContain('account-header-locale-action')
    expect(shellCss).toMatch(
      /\.account-site-header__actions \.account-header-link,[\s\S]*?\.account-header-theme-action > button,[\s\S]*?\.account-header-locale-action\.fsusblog-locale-toggle,[\s\S]*?\.account-header-menu__trigger\.account-header-menu__trigger[\s\S]*?height:\s*var\(--fsus-control-height-compact\);[\s\S]*?border:\s*1px solid var\(--fsusblog-panel-border\)/
    )
    expect(shellCss).toMatch(
      /\.account-site-header__actions \.account-header-link:hover,[\s\S]*?border-color:\s*var\(--fsusblog-color-primary\);[\s\S]*?background:\s*var\(--fsusblog-page-bg-soft\);/
    )
  })
})
