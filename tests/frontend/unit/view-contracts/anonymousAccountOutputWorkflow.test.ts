import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('anonymous account output workflow contract', () => {
  const authApi = readRepoFile('src/frontend/src/api/auth.ts')
  const authAdapter = readRepoFile('src/frontend/src/adapters/binary/authAdapter.ts')
  const adapterIndex = readRepoFile('src/frontend/src/adapters/binary/index.ts')
  const userStore = readRepoFile('src/frontend/src/store/user.ts')
  const adminStore = readRepoFile('src/frontend/src/store/admin.ts')
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const app = readRepoFile('src/frontend/src/App.vue')
  const identityCenter = readRepoFile('src/frontend/src/views/user/IdentityCenter.vue')
  const publicShellRuntime = readRepoFile('src/frontend/src/public-renderers/publicShellRuntimeState.ts')

  it('models getMe as an anonymous account snapshot instead of username and role identity', () => {
    expect(authApi).toContain('export interface CurrentUserSnapshot')
    expect(authApi).toContain('accountId: number')
    expect(authApi).toContain('identityKind: string')
    expect(authApi).toContain('publicHandle: string | null')
    expect(authApi).toContain('passkeyEnabled: boolean')
    expect(authApi).toContain('recoveryEnabled: boolean')
    expect(authApi).toContain('anonymousCredentialStatus: string | null')
    expect(authApi).toContain('anonymousCredentialLevel: string | null')
    expect(authApi).not.toContain('interface AuthIdentitySnapshot {\n  id: number\n  username: string\n  role: string\n}')
    expect(authApi).not.toMatch(/export interface CurrentUserSnapshot[\s\S]*username: string/u)
    expect(authApi).not.toMatch(/export interface CurrentUserSnapshot[\s\S]*role: string/u)
    expect(authApi).toContain('frameType: FrameType.IdentityAccountSnapshot')
    expect(authApi).not.toContain("binaryUrl: '/api/binary/auth/me',\n    frameType: FrameType.CurrentUserSnapshot")

    expect(authAdapter).toContain('mapIdentityAccountSnapshotFromPayload')
    expect(adapterIndex).toContain('[FrameType.IdentityAccountSnapshot]: mapIdentityAccountSnapshotFromPayload')
  })

  it('keeps user-side auth state and route guards independent from legacy user roles', () => {
    expect(userStore).not.toContain('userInfo.value.role')
    expect(adminStore).not.toContain("user?.role === 'admin'")
    expect(adminStore).not.toContain('source: \'legacy\'')
    expect(router).not.toContain('const userRole =')
    expect(router).not.toContain('allowedRoles.includes(userRole)')
    expect(app).not.toContain('userStore.userInfo?.role')
    expect(publicShellRuntime).not.toContain('role?: string | null')
    expect(publicShellRuntime).not.toContain("user?.role === 'admin'")
  })

  it('does not use sys_user username as public identity fallback', () => {
    expect(identityCenter).not.toContain('user?.username')
    expect(identityCenter).toContain('user?.publicHandle')
    expect(identityCenter).not.toMatch(/publicHandle:[^\n]*username/u)
  })
})
