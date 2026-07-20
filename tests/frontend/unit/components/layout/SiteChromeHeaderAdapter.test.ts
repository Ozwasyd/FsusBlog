// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/components/layout/SiteChromeHeaderAdapter.vue'),
  'utf8'
)

describe('SiteChromeHeaderAdapter', () => {
  it('caps only account wordmarks to preserve desktop header actions', () => {
    expect(source).toContain(':class="`site-chrome-header__brand-mark--${brandContext}`"')
    expect(source).toMatch(
      /\.site-chrome-header__brand-mark\s*\{[\s\S]*?max-width:\s*min\(14rem, 42vw\)/
    )
    expect(source).toMatch(
      /\.site-chrome-header__brand-mark--account\s*\{[\s\S]*?max-width:\s*min\(10rem, 32vw\)/
    )
    expect(source).not.toMatch(/\.site-chrome-header__brand-mark--public\s*\{/)
  })
})
