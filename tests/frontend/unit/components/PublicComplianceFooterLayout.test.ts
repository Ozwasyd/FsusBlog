import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const foundationCss = readFileSync(
  resolve(process.cwd(), 'src/assets/public-shell-foundation.css'),
  'utf8',
)
const footerSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicComplianceFooter.vue'),
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

  it('centers record icons in a fixed box alongside multiline text', () => {
    const recordLinkRule = ruleBody('#fsus-aot-shell .public-colophon__record-link')
    const recordIconRule = ruleBody('#fsus-aot-shell .public-colophon__record-icon')

    expect(recordLinkRule).toContain('line-height: 20px;')
    expect(recordIconRule).toContain('display: inline-flex;')
    expect(recordIconRule).toContain('flex: 0 0 16px;')
    expect(recordIconRule).toContain('width: 16px;')
    expect(recordIconRule).toContain('height: 16px;')
    expect(recordIconRule).toContain('align-items: center;')
    expect(recordIconRule).toContain('justify-content: center;')
    expect(footerSource).toMatch(
      /<span v-if="record\.icon" class="public-colophon__record-icon">\s*<img/u,
    )
  })
})
