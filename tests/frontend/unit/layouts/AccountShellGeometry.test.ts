// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell-base.css'),
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
})
