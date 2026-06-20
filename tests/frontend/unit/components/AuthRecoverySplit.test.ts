import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const loginSource = readFileSync(
  resolve(process.cwd(), 'src/views/auth/Login.vue'),
  'utf8',
)
const recoverSource = readFileSync(
  resolve(process.cwd(), 'src/views/auth/Recover.vue'),
  'utf8',
)
const routerSource = readFileSync(
  resolve(process.cwd(), 'src/router/index.ts'),
  'utf8',
)
const authLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/layouts/PublicAuthLayout.vue'),
  'utf8',
)

describe('auth recovery page split', () => {
  it('routes recovery through the public auth layout', () => {
    expect(routerSource).toContain("path: 'recover'")
    expect(routerSource).toContain("name: 'Recover'")
    expect(routerSource).toContain(
      "component: () => import('@/views/auth/Recover.vue')",
    )
    expect(authLayoutSource).toContain("route.name === 'Recover'")
  })

  it('keeps Recovery Key verification out of Login.vue', () => {
    expect(loginSource).toContain('to="/recover"')
    expect(loginSource).toContain('使用 Recovery Key 恢复访问')
    expect(loginSource).not.toContain('verifyRecoveryKey')
    expect(loginSource).not.toContain('recoveryKeyInput')
    expect(loginSource).not.toContain('PasskeyRegisterModal')
  })

  it('keeps the recovery page responsible for verification and new passkey binding', () => {
    expect(recoverSource).toContain('verifyRecoveryKey')
    expect(recoverSource).toContain('recoverySessionToken')
    expect(recoverSource).toContain('PasskeyRegisterModal')
    expect(recoverSource).toContain('绑定新的通行密钥')
    expect(recoverSource).not.toContain('recovery-user-id')
    expect(recoverSource).not.toContain('recoveryUserId')
    expect(recoverSource).not.toContain('账户编号')
    expect(recoverSource).not.toContain('userId:')
  })
})
