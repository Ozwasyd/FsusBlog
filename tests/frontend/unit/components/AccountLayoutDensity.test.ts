import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const accountNavSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/accountNav.ts'),
  'utf8',
)
const accountShellCss = readFileSync(
  resolve(process.cwd(), 'src/assets/account-shell.css'),
  'utf8',
)

describe('AccountLayout navigation density', () => {
  it('keeps high-frequency account navigation as labels first', () => {
    expect(accountNavSource).toContain(
      "{ label: '设置', to: ACCOUNT_ROUTE_PATHS.profile, area: 'self', groupKey: 'self' }",
    )
    expect(accountNavSource).toContain(
      "{ label: '我的消息', to: '/user/messagebox', area: 'self', groupKey: 'self' }",
    )
    expect(accountNavSource).not.toContain('资料与安全')
    expect(accountNavSource).not.toContain('站内会话')
    expect(accountNavSource).not.toContain('登录与公开身份')
  })

  it('keeps only terse helpers for complex governance entries', () => {
    expect(accountNavSource).toContain("helper: 'Verifier'")
    expect(accountNavSource).toContain("helper: '风险桶'")
    expect(accountNavSource).toContain("helper: 'PoW'")
    expect(accountNavSource).not.toContain('评论、词库与策略')
    expect(accountNavSource).not.toContain(
      '系统设置、安全系统、备份迁移、审计日志',
    )
  })

  it('reduces account page header spacing and title scale', () => {
    expect(accountShellCss).toContain(
      '.account-page-header {\n  margin-bottom: 2rem;',
    )
    expect(accountShellCss).toContain(
      '.account-page-header--compact {\n  margin-bottom: 1.25rem;',
    )
    expect(accountShellCss).toContain(
      'font-size: clamp(1.5rem, 2.4vw, 2.25rem);',
    )
    expect(accountShellCss).toContain('font-size: clamp(1.35rem, 8vw, 2rem);')
    expect(accountShellCss).not.toContain(
      'font-size: clamp(2.1rem, 4vw, 3.8rem);',
    )
  })
})
