import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountShell = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell.css'),
  'utf8'
)
const identityCenter = readFileSync(
  resolve(process.cwd(), 'src/views/user/IdentityCenter.vue'),
  'utf8'
)

function ruleBody(source: string, pattern: RegExp): string {
  const body = pattern.exec(source)?.groups?.body
  expect(body).toBeDefined()
  return body ?? ''
}

describe('account page title hierarchy', () => {
  it('keeps shared account page titles at responsive 24/30px with 700 and responsive leading', () => {
    const sharedTitle = ruleBody(
      accountShell,
      /^\.account-page-title\s*\{(?<body>[^}]*)\}/mu
    )
    expect(sharedTitle).toMatch(/font-size:\s*1\.5rem;/u)
    expect(sharedTitle).toMatch(/font-weight:\s*700;/u)
    expect(sharedTitle).toMatch(/line-height:\s*1\.25;/u)
    expect(sharedTitle).not.toMatch(/clamp\(/u)

    const sharedDesktopTitle = ruleBody(
      accountShell,
      /@media \(min-width:\s*640px\)\s*\{\s*\.account-page-title\s*\{(?<body>[^}]*)\}/u
    )
    expect(sharedDesktopTitle).toMatch(/font-size:\s*1\.875rem;/u)
    expect(sharedDesktopTitle).toMatch(/line-height:\s*1\.2;/u)

    const identityTitle = ruleBody(
      identityCenter,
      /\.identity-section-header__copy h1\s*\{(?<body>[^}]*)\}/u
    )
    expect(identityTitle).toMatch(/font-size:\s*1\.5rem;/u)
    expect(identityTitle).toMatch(/font-weight:\s*700;/u)
    expect(identityTitle).toMatch(/line-height:\s*1\.25;/u)

    const identityDesktopTitle = ruleBody(
      identityCenter,
      /@media \(min-width:\s*640px\)\s*\{\s*\.identity-section-header__copy h1\s*\{(?<body>[^}]*)\}/u
    )
    expect(identityDesktopTitle).toMatch(/font-size:\s*1\.875rem;/u)
    expect(identityDesktopTitle).toMatch(/line-height:\s*1\.2;/u)
  })

  it('keeps mobile title ownership limited to width', () => {
    const mobileTitle = ruleBody(
      accountShell,
      /@media \(max-width:\s*640px\)[\s\S]*?\.account-page-title\s*\{(?<body>[^}]*)\}/u
    )
    expect(mobileTitle).toContain('max-width: none;')
    expect(mobileTitle).not.toMatch(/font-size:|font-weight:|line-height:/u)
  })
})
