import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveAdaptiveManifestWorkers } from '../../tools/test/run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const legacy = fs.readFileSync(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/security-runtime.sh'), 'utf8')
const a11yDiagnostics = fs.readFileSync(path.join(root, 'tools/test/lanes/browser-a11y-diagnostics.sh'), 'utf8')
const parallelHelper = legacy.slice(
  legacy.indexOf('run_parallel()'),
  legacy.indexOf('\nprobe_url()')
)
const securityStatic = legacy.slice(
  legacy.indexOf('run_security_static_only()'),
  legacy.indexOf('\nrun_security_runtime_core_only()')
)
const securityCore = legacy.slice(
  legacy.indexOf('run_security_runtime_core_only()'),
  legacy.indexOf('\nrun_security_only()')
)
const security = legacy.slice(
  legacy.indexOf('run_security_only()'),
  legacy.indexOf('\nrun_security()')
)

test('security static phase is bootstrap-free and retains every static gate exactly once', () => {
  assert.doesNotMatch(securityStatic, /require_debug_stack|prepare_runtime_fixtures_once|reset_security_runtime_state/u)
  assert.match(securityStatic, /local -x FSUSBLOG_ADAPTIVE_PARALLEL=1/u)
  for (const token of [
    'security-matrices::',
    'zap-warn-policy::',
    'sbom::',
    'supply-chain::',
    'network-baseline::'
  ]) assert.equal(securityStatic.split(token).length - 1, 1, `static phase must retain ${token} exactly once`)
  assert.match(securityStatic, /local -x FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted/u)
  assert.ok(
    securityStatic.indexOf('network-baseline::') < securityStatic.indexOf('supply-chain::'),
    'measured 74s network gate must lead the 41s supply-chain gate'
  )
})

test('adaptive security pools re-read fail-closed live grants without abandoning active jobs', () => {
  assert.match(parallelHelper, /FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE/u)
  assert.match(parallelHelper, /stat -c '%y:%s'/u)
  assert.match(parallelHelper, /current_grant_signature[\s\S]*resolve_parallel_workers "\$total"/u)
  assert.match(parallelHelper, /if \(\( refresh_capacity == 1 \)\) \|\| \[\[ "\$current_grant_signature" != "\$grant_signature" \]\]/u)
  assert.match(parallelHelper, /active < worker_cap/u)
  assert.match(parallelHelper, /refresh_capacity=1/u)
  assert.match(legacy, /resolve_parallel_child_environment\(\)[\s\S]*readManifestSchedulerResourceGrant/u)
  assert.doesNotMatch(parallelHelper, /kill "\$pid"/u)
})

test('scheduler-admitted static pool trusts a current live 1 to 2 CPU expansion despite stale host pressure', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'security-static-live',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/security-static-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '1',
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: '5'
  }
  const document = JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'security-static-live',
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
    grants: { runtime: { cpuUnits: 2, memoryGiB: 2 } }
  })
  assert.equal(resolveAdaptiveManifestWorkers({
    env,
    cpuCount: 8,
    freeMemoryBytes: 128 * 1024 ** 2,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 8,
    readGrantFile: () => document,
    workload: 'scheduler-admitted'
  }), 2)
})

test('ordinary adaptive pool trusts an admitted live grant despite stale host load and memory readings', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'security-runtime-live',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/security-runtime-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '1'
  }
  const document = JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'security-runtime-live',
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
    grants: { runtime: { cpuUnits: 3, memoryGiB: 3 } }
  })
  assert.equal(resolveAdaptiveManifestWorkers({
    env,
    cpuCount: 8,
    freeMemoryBytes: 128 * 1024 ** 2,
    totalMemoryBytes: 64 * 1024 ** 3,
    load1: 8,
    readGrantFile: () => document
  }), 3)
})

test('security runtime core keeps isolated runtime checks after one preparation reset', () => {
  const prepare = securityCore.indexOf('prepare_runtime_fixtures_once')
  const reset = securityCore.indexOf('reset-pre-parallel')
  const pool = securityCore.indexOf('run_parallel "security-runtime-core"')
  const preAttack = securityCore.indexOf('reset-pre-attack')
  const attack = securityCore.indexOf('check:security:attack-matrix')
  const postAttack = securityCore.indexOf('reset-post-attack')

  assert.ok(prepare >= 0 && prepare < reset)
  assert.ok(reset < pool)
  assert.ok(pool < preAttack && preAttack < attack && attack < postAttack)
  assert.equal(securityCore.match(/prepare_runtime_fixtures_once/gu)?.length, 1)
  for (const token of [
    'local-runtime-exposure::',
    'api-contracts::',
    'auth-session::',
    'auth-mfa::',
    'auth-passkey::',
    'headers-cors::',
    'notification-stream-binary::'
  ]) assert.ok(securityCore.includes(token), `missing security job ${token}`)

  const jobsStart = securityCore.indexOf('local -a security_runtime_jobs=(')
  const jobs = securityCore.slice(jobsStart, securityCore.indexOf('\n  )', jobsStart))
  assert.doesNotMatch(jobs, /permissions::|a11y::/u)
  assert.doesNotMatch(jobs, /attack-matrix|check:security:dast/u)
  assert.doesNotMatch(jobs, /supply-chain|network-baseline|security-matrices|zap-warn-policy|generate-sbom/u)
  assert.match(securityCore, /local -x FSUSBLOG_ADAPTIVE_PARALLEL=1/u)
  assert.match(securityCore, /local -x FSUSBLOG_PARALLEL_WORKLOAD=cpu/u)
  assert.match(securityCore, /run_security_stage "security-runtime-parallel" run_security_runtime_pool/u)
  assert.match(securityCore, /run_security_stage "security-runtime-permissions"[\s\S]*run_security_isolated_client_check permissions/u)
  assert.doesNotMatch(securityCore, /check:a11y:smoke|security-runtime-a11y/u)
  assert.match(a11yDiagnostics, /run_in_client npm run check:a11y:smoke/u)
  assert.match(a11yDiagnostics, /FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1/u)
})

test('correctness session-mutating security checks receive stable unique user, admin and device suffixes', () => {
  for (const suffix of ['auth-session', 'auth-mfa', 'auth-passkey', 'permissions']) {
    assert.ok(
      securityCore.includes(`run_security_isolated_client_check ${suffix} `),
      `missing isolated identity suffix for ${suffix}`
    )
  }
  assert.match(securityCore, /FSUSBLOG_USER_USERNAME="\$\{FSUSBLOG_USER_USERNAME:-binaryuser\}-\$suffix"/u)
  assert.match(securityCore, /FSUSBLOG_ADMIN_USERNAME="\$\{FSUSBLOG_ADMIN_USERNAME:-binaryadmin\}-\$suffix"/u)
  assert.match(securityCore, /FSUSBLOG_DEVICE_FP="\$\{FSUSBLOG_DEVICE_FP:-binary-smoke-node\}-\$suffix"/u)
})

test('attack resets stay exclusive while local exposure is mandatory and external closeout remains explicit', () => {
  assert.match(securityCore, /run_security_stage "reset-pre-attack"[\s\S]*?run_security_stage "attack-matrix"[\s\S]*?run_security_stage "reset-post-attack"/u)
  assert.match(
    securityCore,
    /run_security_stage "reset-post-gate" reset_security_runtime_state "post security gate"/u,
    'the final runtime reset must remain a complete run_security_stage command'
  )
  assert.doesNotMatch(securityCore, /^hen\b/mu)
  assert.match(securityCore, /if \[\[ "\$\{FSUSBLOG_SKIP_ZAP:-0\}" != "1" \]\]; then[\s\S]*?run_security_stage "dast"/u)
  assert.match(securityCore, /local-runtime-exposure::run[\s\S]*?check-local-runtime-exposure\.mjs/u)
  assert.match(securityCore, /FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE[\s\S]*?external-production-exposure::check_external_production_exposure/u)
  assert.doesNotMatch(securityCore, /skip production live exposure/u)
  assert.match(lane, /run_tier "security" run_security_only/u)
})

test('combined direct security lane launches both phases independently and aggregates their failures', () => {
  assert.match(security, /run_parallel "security-phases"[\s\S]*?security-static::run_security_static_only[\s\S]*?security-runtime-core::run_security_runtime_core_only/u)
})
