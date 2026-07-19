import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..', '..')
const frontend = readFileSync(resolve(repoRoot, 'src/frontend/src/services/localFixtureSession.ts'), 'utf8')
const backend = readFileSync(resolve(repoRoot, 'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs'), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(`[local-fixture-url-hygiene] ${message}`)
}

for (const token of ['isLocalFixtureHost(environment.hostname)', 'environment.dev', '!environment.prod', "environment.mode === 'development'"]) {
  assert(frontend.includes(token), `local fixture gate must include ${token}`)
}
assert(frontend.includes('history.replaceState('), 'activation must clean its query with replaceState')
assert(frontend.includes("url.searchParams.delete(LOCAL_FIXTURE_LOGIN_QUERY)"), 'login fixture query must be removed')
assert(frontend.includes("url.searchParams.delete(LOCAL_FIXTURE_ADMIN_QUERY)"), 'admin fixture query must be removed')
assert(frontend.includes("endpoint.searchParams.set('redirect', sanitizeLocalFixturePath("), 'redirects must use sanitized paths')
assert(!backend.includes('forceLocalFixtureRefresh'), 'backend must not re-add fixture activation flags')
assert(!backend.includes('fsusLocalFixtureLogin=1'), 'backend redirect must not emit a fixture activation flag')
assert(backend.includes('fsusLocalFixtureLogin" or "fsusLocalFixtureAdmin'), 'backend must remove both fixture query flags')

console.log('[local-fixture-url-hygiene] activation, redirect and build gates OK')
