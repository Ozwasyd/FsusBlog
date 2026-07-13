#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-test-fixture-secret-governance.mjs')

const requiredMarkerFixture = {
  'tests/frontend/support/session-fixtures.mjs': `
export function assertSafeFixtureContainer() {}
export const secretName = 'FSUSBLOG_TEST_SESSION_SECRET'
`,
  'tests/frontend/support/auth-helpers.mjs': `
export function loginWithFixtureSessionBypass() {}
`,
  'tests/frontend/e2e/acceptance/admin-console.spec.ts': `
export function assertLocalAcceptanceBackend() {}
`
}

const unsafeSqlFixture = `
INSERT INTO sys_user(username, password, role, refreshtoken, lastloginip)
VALUES ('legacy-user', 'hash', 'guest', 'plaintext-refresh-token', '127.0.0.1');
`

const safeSqlFixture = `
INSERT INTO sys_user(username, password, role, refreshtoken, lastloginip)
VALUES ('anon-fixture-user-0007', 'redacted-password-hash', 'fixture_role', NULL, 'anonymized-ip-v4-0007');
`

const unsafeTestHostFixture = `
var config = new Dictionary<string, string?> { ["AllowedHosts"] = "fsus.blog" };
request.Headers.Host = "fsus.blog";
`

const safeTestHostFixture = `
var config = new Dictionary<string, string?> { ["AllowedHosts"] = "session-boundary.test" };
request.Headers.Host = "session-boundary.test";
`

function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content.trimStart())
  }
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_TEST_FIXTURE_GOVERNANCE_ROOT: root
    }
  })
}

function fail(message, result) {
  console.error(`[test-fixture-secret-governance-fixture] ${message}`)
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim()
  if (output) console.error(output)
  process.exit(1)
}

function createFixtureRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-secret-${name}-`))
  writeFiles(root, requiredMarkerFixture)
  return root
}

const unsafeRoot = createFixtureRoot('unsafe')
writeFiles(unsafeRoot, {
  'tests/backend/Fixtures/legacy-20260517-minimal.sql': unsafeSqlFixture,
  'tests/backend/Unit/UserSessionMappedBoundaryTests.cs': unsafeTestHostFixture
})
const unsafeResult = runChecker(unsafeRoot)
const unsafeOutput = `${unsafeResult.stdout ?? ''}\n${unsafeResult.stderr ?? ''}`
if (unsafeResult.status === 0) fail('expected unsafe SQL fixture to fail', unsafeResult)
for (const rule of [
  'legacy SQL username sample',
  'legacy SQL plaintext refresh token',
  'legacy SQL loopback IPv4 sample',
  'legacy SQL placeholder hash',
  'legacy SQL guest role'
]) {
  if (!new RegExp(`tests/backend/Fixtures/legacy-20260517-minimal[.]sql:[0-9]+:${rule}`, 'u').test(unsafeOutput)) {
    fail(`expected path, line and rule for ${rule}`, unsafeResult)
  }
}
if (!/tests\/backend\/Unit\/UserSessionMappedBoundaryTests[.]cs:[0-9]+:real production domain in test config/u.test(unsafeOutput)) {
  fail('expected real production domain test config to fail with path, line and rule', unsafeResult)
}

const safeRoot = createFixtureRoot('safe')
writeFiles(safeRoot, {
  'tests/backend/Fixtures/legacy-20260517-minimal.sql': safeSqlFixture,
  'tests/backend/Unit/UserSessionMappedBoundaryTests.cs': safeTestHostFixture
})
const safeResult = runChecker(safeRoot)
if (safeResult.status !== 0) fail('expected anonymized SQL fixture to pass', safeResult)

console.log('[test-fixture-secret-governance-fixture] ok unsafe=6 safe=2')
