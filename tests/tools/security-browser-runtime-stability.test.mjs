import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const a11yFile = path.join(root, 'tests/frontend/checks/runtime/check-a11y-smoke.mjs')
const permissionFile = path.join(root, 'tests/frontend/checks/security/check-permission-matrix.mjs')
const a11y = fs.readFileSync(a11yFile, 'utf8')
const permission = fs.readFileSync(permissionFile, 'utf8')

test('a11y audit derives navigation and audit deadlines while retrying only transient context replacement', () => {
  assert.match(a11y, /resolveRuntimeBrowserTimeoutPlan/u)
  assert.match(a11y, /timeout: runtimeTimeout\(timeoutPlan\.navigationTimeoutMs\)/u)
  assert.match(a11y, /const deadlineAt = Date\.now\(\) \+ runtimeTimeout\(timeoutPlan\.pageAuditTimeoutMs\)/u)
  assert.match(a11y, /execution context was destroyed\|cannot find context with specified id\|most likely because of a navigation/u)
  assert.match(a11y, /if \(!navigationRace \|\| Date\.now\(\) >= deadlineAt\)/u)
  assert.doesNotMatch(a11y, /retry|attempts?\s*=\s*\d+/iu)
})

test('a11y audit derives identity fanout from live resources while reusing one context and one navigation per route', () => {
  assert.match(a11y, /const \[userSession, adminSession\] = await Promise\.all/u)
  assert.match(a11y, /resolveAuditWorkers\(auditTasks\.length\)/u)
  assert.match(a11y, /options\.effectiveCpuGrant \?\? timeoutPlan\.effectiveCpuGrant/u)
  assert.match(a11y, /FSUSBLOG_STEP_MEMORY_GIB/u)
  assert.match(a11y, /await Promise\.all\(Array\.from\(\{ length: workers \}, runWorker\)\)/u)
  assert.match(a11y, /withAuditPage\(browser, null[\s\S]*withAuditPage\(browser, userSession[\s\S]*withAuditPage\(browser, adminSession/u)
  assert.match(a11y, /'\/user\/manage\/users',[\s\S]*'\/user\/manage\/category'[\s\S]*audit \/user\/manage\/category dialog/u)
  assert.doesNotMatch(a11y, /await gotoRuntime\(adminPage, '\/user\/manage\/category'\)/u)
  assert.match(a11y, /async function auditRoute\(page, path,[\s\S]*await gotoRuntime\(page, path\)/u)
})

test('a11y browser diagnostics fixes the inner context topology at one without changing ordinary admission', () => {
  const evaluation = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const { resolveAuditWorkers } = await import(${JSON.stringify(pathToFileURL(a11yFile).href)});
    const values = [
      resolveAuditWorkers(3, {
        env: { FSUSBLOG_BROWSER_DIAGNOSTICS: '1', FSUSBLOG_STEP_MEMORY_GIB: '256' },
        effectiveCpuGrant: 64
      }),
      resolveAuditWorkers(3, {
        env: { FSUSBLOG_STEP_MEMORY_GIB: '3' },
        effectiveCpuGrant: 3
      }),
      resolveAuditWorkers(3, {
        env: { FSUSBLOG_STEP_MEMORY_GIB: '0.75' },
        effectiveCpuGrant: 3
      })
    ];
    process.stdout.write(JSON.stringify(values));
  `], {
    cwd: path.join(root, 'src/frontend'),
    encoding: 'utf8'
  })
  assert.equal(evaluation.status, 0, evaluation.stderr)
  assert.deepEqual(JSON.parse(evaluation.stdout), [1, 3, 1])

  const resolver = a11y.slice(
    a11y.indexOf('export function resolveAuditWorkers'),
    a11y.indexOf('\nasync function runAuditTasks')
  )
  assert.ok(resolver.indexOf('FSUSBLOG_BROWSER_DIAGNOSTICS') < resolver.indexOf('effectiveCpuGrant'))
  assert.match(resolver, /FSUSBLOG_BROWSER_DIAGNOSTICS === '1'\) return 1/u)
  assert.doesNotMatch(resolver, /loadavg|freemem|availableParallelism/u)
})

test('permission phases use a resource-derived pool and settle every independent phase', () => {
  assert.match(permission, /resolvePermissionPhaseWorkers/u)
  assert.match(permission, /FSUSBLOG_STEP_CPU_BUDGET/u)
  assert.match(permission, /FSUSBLOG_STEP_MEMORY_GIB/u)
  assert.match(permission, /resolveRuntimeBrowserTimeoutPlan/u)
  assert.match(permission, /remainingRuntimeTimeout/u)
  assert.match(permission, /await Promise\.all\(Array\.from\(\{ length: workers \}, runWorker\)\)/u)
  assert.match(permission, /static-authorization-boundaries[\s\S]*api-permission-matrix/u)
  assert.match(permission, /failures\.join\('; '\)/u)
  assert.match(permission, /adminPage\.waitForURL/u)
  assert.doesNotMatch(permission, /fail-fast|max[-_]?errors?/iu)
})

test('security browser runtime scripts remain valid modules', () => {
  for (const file of [a11yFile, permissionFile]) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})
