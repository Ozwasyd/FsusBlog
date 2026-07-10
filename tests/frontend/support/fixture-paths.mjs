import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function sanitizeSegment(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized
}

function resolveConfiguredRoot(configured, repoRoot) {
  if (!configured) return null
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured)
}

export function resolveFixtureNamespace(env = process.env) {
  return sanitizeSegment(env.FSUSBLOG_TEST_NAMESPACE, 'local')
}

export function resolveFixtureRoot({ env = process.env, repoRoot = defaultRepoRoot } = {}) {
  return resolveConfiguredRoot(env.FSUSBLOG_FIXTURE_ROOT, repoRoot)
    ?? path.join(repoRoot, '.tmp', 'fixtures', resolveFixtureNamespace(env))
}

export function resolvePublicFixtureFile(options = {}) {
  const env = options.env ?? process.env
  return env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
    ? path.resolve(env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE)
    : path.join(resolveFixtureRoot({ ...options, env }), 'public.aeds')
}

export function resolveFixtureAssetDirectory(options = {}) {
  return path.join(resolveFixtureRoot(options), 'assets')
}

export function resolveAuthFixtureDirectory(options = {}) {
  return path.join(resolveFixtureRoot(options), 'auth')
}

export function resolveAuthFixtureManifest(options = {}) {
  return path.join(resolveAuthFixtureDirectory(options), 'auth-fixtures.json')
}

export function resolveSessionFixtureDirectory(options = {}) {
  return path.join(resolveFixtureRoot(options), 'sessions')
}

export function resolveSessionFixtureFile(session, options = {}) {
  return path.join(
    resolveSessionFixtureDirectory(options),
    `${sanitizeSegment(session, 'pw-0')}.aeds`
  )
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  process.stdout.write(`${resolveFixtureRoot()}\n`)
}
