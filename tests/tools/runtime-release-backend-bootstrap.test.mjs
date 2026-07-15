import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')

test('fresh no-build runtime reuses the production Release backend instead of a deleted Debug output', () => {
  assert.match(bootstrap, /FSUSBLOG_RUNTIME_NO_BUILD[\s\S]*?runtime_configuration="Release"/u)
  assert.match(bootstrap, /runtime_args="-c \$runtime_configuration --no-build --no-restore"/u)
  assert.match(bootstrap, /Debug\|Release/u)
  assert.doesNotMatch(bootstrap, /runtime_args="-c Debug --no-build --no-restore"/u)
})

test('managed backend uses the same JWT key version as acceptance fixture tokens', () => {
  assert.match(bootstrap, /Jwt__KeyVersion=\$\(printf '%q' "\$JWT_KEY_VERSION"\).*Jwt__SecretKey=/u)
})

test('managed backend readiness fails immediately when the no-build process exits', t => {
  const namespace = `runtime-release-backend-fail-${process.pid}`
  t.after(() => {
    fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true })
    fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true })
  })
  const startedAt = performance.now()
  const result = childProcess.spawnSync('bash', ['-lc', [
    'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
    `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    'export FSUSBLOG_RUNTIME_NO_BUILD=1',
    'export FSUSBLOG_RUNTIME_CONFIGURATION=Debug',
    'export FSUSBLOG_STEP_DEADLINE_MS=10000',
    'source ./tools/bootstrap-acceptance-env.sh',
    'ROOT_DIR=/tmp/fsusblog-intentionally-missing-runtime-root',
    'deadline=$(( $(date +%s%3N) + 15000 ))',
    'ensure_backend "$deadline"'
  ].join('; ')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8_000
  })
  const elapsedMs = performance.now() - startedAt

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /debug backend process exited before becoming ready/u)
  assert.match(`${result.stdout}\n${result.stderr}`, /The specified launch profile.*could not be applied|No such file or directory|not found/u)
  assert.ok(elapsedMs < 5_000, `dead managed backend consumed ${elapsedMs.toFixed(0)}ms of a 15000ms readiness deadline`)
})
