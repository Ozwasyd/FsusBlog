import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../..')

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

describe('dev auth fixture persistence contract', () => {
  it('keeps local fixture sessions reusable instead of password-flow only', () => {
    const sessionFixtures = readRepoFile('tests/frontend/support/session-fixtures.mjs')
    const authUsers = readRepoFile('tests/frontend/fixtures/prepare-auth-smoke-users.mjs')
    const devStart = readRepoFile('tools/dev/start.sh')

    expect(sessionFixtures).toContain('stableFixtureSessionId')
    expect(sessionFixtures).toContain('persistAuthFixtureManifest')
    expect(sessionFixtures).toContain('FSUSBLOG_PERSIST_AUTH_FIXTURES')
    expect(sessionFixtures).toContain('ON CONFLICT (sessionid) DO UPDATE')
    expect(sessionFixtures).toContain("const isHostPrefixed = name.startsWith('__Host-')")
    expect(sessionFixtures).toContain('secure: isHostPrefixed')
    expect(sessionFixtures).toContain("sameSite: isHostPrefixed ? 'Strict' : 'Lax'")
    expect(sessionFixtures).not.toContain('void rememberMe;')
    expect(authUsers).toContain('persistAuthFixtureManifest')
    expect(authUsers).not.toContain('FSUSBLOG_USER_PASSWORD')
    expect(authUsers).not.toContain('FSUSBLOG_ADMIN_PASSWORD')
    expect(devStart).toContain('AuthCookies__AllowLegacyPlainCookieRead="true"')
    expect(devStart).toContain('Jwt__SecretKey=')
    expect(devStart).toContain('Jwt__AccessTokenExpiresMinutes=')
    expect(devStart).toContain('FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES="$Jwt__AccessTokenExpiresMinutes"')
    expect(devStart).toContain('prepare:binary-smoke:auth-users')
  })
})
