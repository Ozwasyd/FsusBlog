import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('bundle steps receive resource grants and enforce their machine-resolved deadline on the process group', () => {
  const source = read('tools/test/bundles/run-bundle.mjs')
  for (const token of [
    'FSUSBLOG_STEP_CPU_BUDGET: String(stepCapacity.cpuUnits)',
    'FSUSBLOG_STEP_MEMORY_GIB: String(stepCapacity.memoryGiB)',
    'FSUSBLOG_BUNDLE_CPU_BUDGET: String(stepCapacity.maxParallel)',
    'FSUSBLOG_BUNDLE_MEMORY_GIB: String(stepCapacity.memoryGiB)',
    'FSUSBLOG_STEP_DEADLINE_MS: String(stepDeadlineMs)',
    "detached: process.platform !== 'win32'",
    "process.kill(-child.pid, signal)",
    "signalProcessGroup(child, 'SIGTERM')",
    "signalProcessGroup(child, 'SIGKILL')",
    'activeStepChildren.set(child',
    'installShutdownForwarding()',
    'await terminateProcessGroup(child, terminationGraceMs)',
    'closeChildPipes(child)',
    'code: 124',
    'exceeded machine-resolved deadline'
  ]) assert.ok(source.includes(token), `missing bundle deadline token: ${token}`)

  const liveCapacity = source.slice(
    source.indexOf('function bundleCapacity()'),
    source.indexOf('\nfunction bundleDagCapacity()')
  )
  assert.match(liveCapacity, /availableCpu: os\.availableParallelism\?\.\(\) \?\? os\.cpus\(\)\.length/u)
  assert.match(liveCapacity, /availableMemoryGiB: os\.freemem\(\) \/ \(1024 \*\* 3\)/u)
  assert.doesNotMatch(liveCapacity, /os\.totalmem/u)
  assert.match(source, /baseTimeoutMs: profile\.budgetMs[\s\S]*?actualCapacity: bundleCapacity\(\)/u)
})

test('acceptance machine readiness divides the remaining execution deadline instead of fixed polling windows', () => {
  const source = read('tools/bootstrap-acceptance-env.sh')
  for (const token of [
    'FSUSBLOG_STEP_DEADLINE_MS:-${FSUSBLOG_BUNDLE_DEADLINE_MS:-}',
    'os.availableParallelism?.() ?? os.cpus().length',
    'os.freemem() / (1024 ** 3)',
    'allocate_readiness_deadline',
    'READINESS_PHASES_REMAINING=2',
    "allocate_readiness_deadline 'database services'",
    "allocate_readiness_deadline 'runtime applications'",
    "run_bootstrap_parallel 'database services'",
    "run_bootstrap_parallel 'runtime applications'",
    "resolveManifestLiveCapacity({ env: process.env, workload: 'scheduler-admitted' })",
    'resolveManifestChildEnvironment',
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_STEP_MEMORY_GIB',
    'sleep_within_deadline',
    'termination_deadline_at_ms',
    'release_deadline_at_ms',
    'sleep_ms > remaining',
    'failed in %d independent job(s)'
  ]) assert.ok(source.includes(token), `missing bootstrap deadline token: ${token}`)

  assert.doesNotMatch(source, /os\.totalmem/u)
  assert.doesNotMatch(source, /for \(\(i=0; i<(?:60|120|180);/u)
  assert.doesNotMatch(source, /for \(\(i=0; i<(?:20|40);/u)
  assert.doesNotMatch(source, /wait_for_(?:binary_)?url[^\n]+ (?:30|60|120|180)(?:\s|$)/u)
  assert.doesNotMatch(source, /for \(\(i=0; i<30;/u)
  assert.match(source, /curl -fsS --max-time 5/u)
})

test('acceptance bootstrap bounds parallel startup by the inherited grant and aggregates failures', () => {
  const namespace = `bootstrap-parallel-${process.pid}`
  const marker = path.join(root, '.tmp', `${namespace}.markers`)
  const common = [
    'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
    `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    'export FSUSBLOG_STEP_CPU_BUDGET=2',
    `export FSUSBLOG_STEP_MEMORY_GIB=${os.totalmem() / 1024 ** 3}`,
    `source ${path.join(root, 'tools/bootstrap-acceptance-env.sh')}`
  ]
  const parallel = spawnSync('bash', ['-c', [
    ...common,
    `export BOOTSTRAP_MARKER=${marker}`,
    'probe_a(){ printf "a:start\\n" >> "$BOOTSTRAP_MARKER"; sleep 0.1; printf "a:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    'probe_b(){ printf "b:start\\n" >> "$BOOTSTRAP_MARKER"; sleep 0.1; printf "b:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    'probe_c(){ printf "c:start\\n" >> "$BOOTSTRAP_MARKER"; sleep 0.1; printf "c:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    'run_bootstrap_parallel contract "$EXECUTION_DEADLINE_AT_MS" a probe_a b probe_b c probe_c'
  ].join('; ')], { cwd: root, encoding: 'utf8' })
  assert.equal(parallel.status, 0, parallel.stderr)

  const events = fs.readFileSync(marker, 'utf8').trim().split('\n')
  let active = 0
  let peak = 0
  for (const event of events) {
    if (event.endsWith(':start')) active += 1
    else active -= 1
    peak = Math.max(peak, active)
  }
  assert.equal(peak, 2)

  const failures = spawnSync('bash', ['-c', [
    ...common,
    'fail_a(){ return 7; }',
    'fail_b(){ return 9; }',
    'if run_bootstrap_parallel contract-fail "$EXECUTION_DEADLINE_AT_MS" first fail_a second fail_b; then exit 99; fi'
  ].join('; ')], { cwd: root, encoding: 'utf8' })
  assert.equal(failures.status, 0, failures.stderr)
  assert.match(failures.stderr, /first \(exit 7\)/u)
  assert.match(failures.stderr, /second \(exit 9\)/u)

  fs.rmSync(marker, { force: true })
  fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true })
})

test('acceptance bootstrap expands pending services from live grant 1 to 2 without restarting active work', () => {
  const namespace = `bootstrap-elastic-${process.pid}`
  const marker = path.join(root, '.tmp', `${namespace}.markers`)
  const grantFile = path.join(root, '.tmp', `${namespace}.grant.json`)
  const updater = path.join(root, '.tmp', `${namespace}.update.mjs`)
  const runId = `${namespace}-run`
  const grantDocument = (cpuUnits) => ({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId,
    resourceBudget: { cpuUnits: 2, memoryGiB: 8 },
    grants: { bootstrap: { cpuUnits, memoryGiB: cpuUnits * 4 } }
  })
  fs.writeFileSync(grantFile, `${JSON.stringify(grantDocument(1))}\n`)
  fs.writeFileSync(updater, [
    "import fs from 'node:fs'",
    'const [file, document, marker] = process.argv.slice(2)',
    "while (!fs.existsSync(marker) || !fs.readFileSync(marker, 'utf8').includes('a:start')) {",
    '  await new Promise((resolve) => setTimeout(resolve, 10))',
    '}',
    'const temporary = `${file}.next-${process.pid}`',
    'fs.writeFileSync(temporary, `${document}\\n`)',
    'fs.renameSync(temporary, file)'
  ].join('\n'))

  const result = spawnSync('bash', ['-c', [
    'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
    `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    `export FSUSBLOG_TEST_RUN_ID=${runId}`,
    `export FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE=${grantFile}`,
    'export FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID=bootstrap',
    'export FSUSBLOG_STEP_CPU_BUDGET=1',
    'export FSUSBLOG_STEP_MEMORY_GIB=4',
    `source ${path.join(root, 'tools/bootstrap-acceptance-env.sh')}`,
    `export BOOTSTRAP_MARKER=${marker}`,
    'probe_a(){ printf "a:start\\n" >> "$BOOTSTRAP_MARKER"; for _ in $(seq 1 100); do grep -q "b:start" "$BOOTSTRAP_MARKER" && break; sleep 0.05; done; grep -q "b:start" "$BOOTSTRAP_MARKER"; printf "a:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    'probe_b(){ printf "b:start\\n" >> "$BOOTSTRAP_MARKER"; sleep 0.1; printf "b:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    'probe_c(){ printf "c:start\\n" >> "$BOOTSTRAP_MARKER"; sleep 0.1; printf "c:end\\n" >> "$BOOTSTRAP_MARKER"; }',
    `${process.execPath} ${updater} ${grantFile} '${JSON.stringify(grantDocument(2))}' ${marker} & true`,
    'run_bootstrap_parallel elastic "$EXECUTION_DEADLINE_AT_MS" a probe_a b probe_b c probe_c'
  ].join('; ')], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /elastic capacity update workers=1->2 active=1/u)

  const events = fs.readFileSync(marker, 'utf8').trim().split('\n')
  assert.equal(events.filter((event) => event === 'a:start').length, 1)
  assert.equal(events.filter((event) => event === 'b:start').length, 1)
  assert.ok(events.indexOf('b:start') < events.indexOf('a:end'), events.join(','))
  for (const file of [marker, grantFile, updater]) fs.rmSync(file, { force: true })
  fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true })
})

test('acceptance process cleanup clips polling to the remaining inherited deadline', () => {
  const namespace = `bootstrap-cleanup-deadline-${process.pid}`
  const script = [
    'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
    `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
    `source ${path.join(root, 'tools/bootstrap-acceptance-env.sh')}`,
    'spawn_stubborn(){ bash -c \'trap "" TERM; exec sleep 30\' & STUBBORN_PID=$!; sleep 0.05; }',
    'spawn_stubborn',
    'started_at_ms=$(date +%s%3N)',
    'deadline_at_ms=$((started_at_ms + 120))',
    'kill_pid_if_running "$STUBBORN_PID" "$deadline_at_ms"',
    'wait "$STUBBORN_PID" 2>/dev/null || true',
    'kill_elapsed_ms=$(( $(date +%s%3N) - started_at_ms ))',
    'spawn_stubborn',
    'find_port_pid(){ if kill -0 "$STUBBORN_PID" >/dev/null 2>&1; then printf "%s\\n" "$STUBBORN_PID"; fi; }',
    'started_at_ms=$(date +%s%3N)',
    'deadline_at_ms=$((started_at_ms + 120))',
    'wait_for_port_release 29999 "$deadline_at_ms"',
    'wait "$STUBBORN_PID" 2>/dev/null || true',
    'port_elapsed_ms=$(( $(date +%s%3N) - started_at_ms ))',
    'printf "%s %s\\n" "$kill_elapsed_ms" "$port_elapsed_ms"'
  ].join('; ')
  const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', timeout: 3_000 })
  assert.equal(result.status, 0, result.stderr)
  const [killElapsedMs, portElapsedMs] = result.stdout.trim().split(/\s+/u).map(Number)
  assert.ok(killElapsedMs < 1_000, `kill cleanup exceeded remaining deadline: ${killElapsedMs}ms`)
  assert.ok(portElapsedMs < 1_000, `port cleanup exceeded remaining deadline: ${portElapsedMs}ms`)

  fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true })
})

test('frontend build caps every stage by the remaining shared step deadline', () => {
  const source = read('tools/frontend/build.mjs')
  for (const token of [
    'process.env.FSUSBLOG_STEP_DEADLINE_MS',
    'remainingBuildDeadlineMs()',
    'const timeoutMs = stageTimeoutMs()',
    'Math.min(configuredTimeoutMs, remaining)',
    "detached: process.platform !== 'win32'",
    "process.kill(-child.pid, signal)",
    "signalProcessGroup('SIGTERM')",
    "signalProcessGroup('SIGKILL')",
    "child.once('close'",
    'source=${inheritedDeadlineMs === null ? \'host-capacity\' : \'step-grant\'}'
  ]) assert.ok(source.includes(token), `missing frontend deadline token: ${token}`)

  assert.match(source, /os\.availableParallelism\?\.\(\) \?\? os\.cpus\(\)\.length/u)
  assert.match(source, /os\.freemem\(\) \/ \(1024 \*\* 3\)/u)
  assert.match(source, /productionProfile\.budgetMs \* Math\.max/u)
  assert.doesNotMatch(source, /os\.totalmem/u)
  assert.doesNotMatch(source, /directBuildDeadlineMs = Math\.ceil\(\d/u)
})
