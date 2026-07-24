import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendBuild = path.join(root, 'tools/frontend/build.mjs')
const directTarget = process.argv[1] ? path.resolve(process.argv[1]) : null
const shouldIntercept = directTarget === frontendBuild
  && Boolean(String(process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim())
  && String(process.env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim() === 'build-static'
  && process.env.FSUSBLOG_BUILD_CACHE_INNER !== '1'

if (shouldIntercept) {
  const cacheScript = path.join(root, 'tools/test-matrix/content-addressed-build-cache.mjs')
  const result = spawnSync(process.execPath, [
    cacheScript,
    'run',
    '--domain',
    'frontend-release',
    '--',
    process.execPath,
    frontendBuild,
    ...process.argv.slice(2)
  ], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_BUILD_CACHE_INNER: '1' },
    stdio: 'inherit'
  })
  if (result.signal) {
    try { process.kill(process.pid, result.signal) }
    catch { process.exit(1) }
  }
  process.exit(result.status ?? 1)
}
