import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (relativePath: string): string => fileURLToPath(
  new URL(`../../../../${relativePath}`, import.meta.url)
)

const identityCenter = readFileSync(
  repoFile('src/frontend/src/views/user/IdentityCenter.vue'),
  'utf8'
)
const accountShellBase = readFileSync(
  repoFile('src/frontend/src/assets/account-shell-base.css'),
  'utf8'
)

function ruleBody(source: string, pattern: RegExp): string {
  const body = pattern.exec(source)?.groups?.body
  expect(body).toBeDefined()
  return body ?? ''
}

function expectFontSize(source: string, pattern: RegExp, expected: string): void {
  expect(ruleBody(source, pattern)).toMatch(
    new RegExp(`font-size\\s*:\\s*${expected.replace('.', '\\.')};`, 'u')
  )
}

describe('account integer typography contract', () => {
  it('keeps all explicit target-file pixel sizes on integer boundaries', () => {
    for (const [label, source] of [
      ['IdentityCenter.vue', identityCenter],
      ['account-shell-base.css', accountShellBase]
    ] as const) {
      expect(source, label).not.toMatch(/font-size\s*:\s*0?\.[0-9]+(?:rem|em)/u)
      for (const match of source.matchAll(/font-size\s*:\s*([0-9.]+)px/gu)) {
        expect(Number.isInteger(Number(match[1])), `${label}: ${match[0]}`).toBe(true)
      }
    }
  })

  it('pins IdentityCenter and account-shell roles to the 12/14/16px ladder', () => {
    for (const [pattern, expected] of [
      [/\.identity-status-card strong\s*\{(?<body>[^}]*)\}/u, '16px'],
      [/\.identity-status-card p,\s*\.identity-copy-block p\s*\{(?<body>[^}]*)\}/u, '12px'],
      [/\.identity-status-label\s*\{(?<body>[^}]*)\}/u, '12px'],
      [/\.identity-summary-list,\s*\.identity-state-row\s*\{(?<body>[^}]*)\}/u, '14px'],
      [/\.identity-summary-list dt\s*\{(?<body>[^}]*)\}/u, '12px'],
      [/\.identity-summary-list dt\s*\{[^}]*\}\s*\.identity-summary-list dd\s*\{(?<body>[^}]*)\}/u, '14px'],
      [/\.identity-policy-item\s*\{(?<body>[^}]*)\}/u, '14px'],
      [/\.identity-loading-state,\s*\.identity-error-state\s*\{(?<body>[^}]*)\}/u, '14px'],
      [/\.identity-secret-panel code\s*\{(?<body>[^}]*)\}/u, '14px']
    ] as const) {
      expectFontSize(identityCenter, pattern, expected)
    }

    expectFontSize(
      accountShellBase,
      /\.account-header-link\s*\{(?<body>[^}]*)\}/u,
      '12px'
    )
  })
})
