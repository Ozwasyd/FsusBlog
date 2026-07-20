// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell-base.css'),
  'utf8'
)
const routeFrameSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountRouteFrame.vue'),
  'utf8'
)

describe('account shell geometry', () => {
  it('uses the compact desktop gutter contract at the sidebar boundary', () => {
    const desktopRules = shellCss.match(
      /@media \(min-width: 1024px\)\s*\{([\s\S]*?)\n\}/
    )?.[1] ?? ''

    expect(desktopRules).toMatch(
      /\.account-route-frame\s*\{[\s\S]*?gap:\s*var\(--fsus-space-8\);[\s\S]*?padding-inline:\s*var\(--fsus-space-6\);/
    )
    expect(desktopRules).not.toContain('calc(var(--fsus-space-5) * 2)')
  })

  it('owns mobile drawer title typography without reaching into FsusUI internals', () => {
    expect(routeFrameSource).toContain('<template #header="{ titleId, titleClass }">')
    expect(routeFrameSource).toContain("[titleClass, 'account-mobile-drawer__title']")
    expect(shellCss).toMatch(
      /\.account-mobile-drawer__title\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?font-weight:\s*700;/
    )
    expect(shellCss).toMatch(
      /\.account-mobile-drawer\s*\{[\s\S]*?--el-drawer-padding-primary:\s*var\(--fsus-space-5\);/
    )
    expect(shellCss).not.toMatch(/\.el-drawer__(?:header|title)/)
  })

  it('derives the desktop scroll region from the actual 89px site header', () => {
    expect(shellCss).toMatch(
      /\.account-shell\s*\{[\s\S]*?--fsusblog-account-header-height:\s*5\.5625rem;/
    )
    expect(shellCss).toContain(
      'max-height: calc(100dvh - var(--fsusblog-account-header-height) - var(--fsus-space-8) - var(--fsus-space-8));'
    )
    expect(shellCss).not.toContain('max-height: calc(100dvh - 7rem);')
  })
})
