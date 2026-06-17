import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
  'utf8',
)
const accountNavSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/accountNav.ts'),
  'utf8',
)

describe('AccountLayout sidebar navigation framing', () => {
  it('removes hero-like area copy from the desktop sidebar', () => {
    expect(accountLayoutSource).not.toContain('areaMeta.eyebrow')
    expect(accountLayoutSource).not.toContain('areaMeta.title')
    expect(accountLayoutSource).not.toContain('areaMeta.description')
    expect(accountLayoutSource).not.toContain('account-shell-area-title')
    expect(accountLayoutSource).toContain('account-sidebar-index-label')
  })

  it('keeps the mobile drawer header to a compact area label and close action', () => {
    expect(accountLayoutSource).toContain('{{ areaMeta.label }}导航')
    expect(accountLayoutSource).toContain('aria-label="关闭导航"')
    expect(accountLayoutSource).not.toContain(
      'text-[1.75rem] font-bold leading-none',
    )
  })

  it('reduces account area metadata to functional labels', () => {
    expect(accountNavSource).toContain('label: string')
    expect(accountNavSource).toContain("label: '账户'")
    expect(accountNavSource).toContain("label: '管理'")
    expect(accountNavSource).not.toContain('eyebrow:')
    expect(accountNavSource).not.toContain('description:')
  })
})
