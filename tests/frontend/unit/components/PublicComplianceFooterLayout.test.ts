import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const foundationCss = readFileSync(
  resolve(process.cwd(), 'src/assets/public-shell-foundation.css'),
  'utf8',
)

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = foundationCss.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'u'))
  return match?.groups?.body ?? ''
}

describe('PublicComplianceFooter layout', () => {
  it('keeps footer links comfortably padded without shrinking the touch target', () => {
    const linkRule = ruleBody('#fsus-aot-shell .public-colophon__link')

    expect(linkRule).toContain('min-width: 44px;')
    expect(linkRule).toContain('min-height: 44px;')
    expect(linkRule).toContain('padding-inline: 8px;')
  })

  it('uses the compact two-dimensional gap for wrapping link groups', () => {
    expect(foundationCss).toMatch(
      /\.public-colophon__policy-links,\s*#fsus-aot-shell \.public-colophon__records\s*\{[^}]*gap: 2px 12px;/u,
    )
  })
})
