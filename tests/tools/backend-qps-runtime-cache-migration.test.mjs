import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backendQpsLane = path.join(root, 'tools/test/lanes/backend-qps.sh')
const runtimeCacheLane = path.join(root, 'tools/test/lanes/runtime-cache-evidence.sh')
const migrationTest = fileURLToPath(import.meta.url)
const retiredPaths = [
  'config/testing/backend-qps-scenario-catalog.json',
  'tools/test/run-backend-qps-scenarios.mjs',
  'tests/tools/backend-qps-driver.test.mjs',
  'tools/test/lanes/backend-qps.sh'
]
const retiredReferences = [
  'backend-qps-scenario-catalog',
  'run-backend-qps-scenarios',
  'backend-qps-driver.test',
  'backend-qps.sh'
]

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (/\.(?:json|mjs|sh)$/u.test(entry.name)) files.push(absolute)
  }
  return files
}

test('legacy backend QPS owners are deleted and closed over their migration-owned directories', () => {
  for (const relativePath of retiredPaths) {
    assert.equal(existsSync(path.join(root, relativePath)), false, `${relativePath} must stay retired`)
  }

  const roots = ['config/testing', 'tools/test', 'tools/testing', 'tests/tools'].map((directory) => path.join(root, directory))
  for (const file of roots.flatMap(sourceFiles)) {
    if (file === migrationTest) continue
    const source = readFileSync(file, 'utf8')
    for (const retiredReference of retiredReferences) {
      assert.equal(source.includes(retiredReference), false, `${path.relative(root, file)} retains ${retiredReference}`)
    }
  }

  for (const relativePath of ['config/configuration-ownership.json', 'config/governance/custom-rule-registry.json']) {
    const source = readFileSync(path.join(root, relativePath), 'utf8')
    for (const retiredReference of retiredReferences) {
      assert.equal(source.includes(retiredReference), false, `${relativePath} retains ${retiredReference}`)
    }
  }
})

test('retired backend-qps lane is absent and canonical lane rejects legacy arguments before bootstrap', () => {
  assert.equal(existsSync(backendQpsLane), false)
  for (const legacyArgument of ['cache-hit', 'aggregate']) {
    const result = spawnSync(runtimeCacheLane, [legacyArgument], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH }
    })
    assert.equal(result.status, 64)
    assert.match(result.stderr, /accepts no arguments/u)
  }
})

test('runtime cache lane owns the current producer and independent checker without legacy forwarding', () => {
  const runtimeCacheSource = readFileSync(runtimeCacheLane, 'utf8')

  assert.match(runtimeCacheSource, /run-runtime-cache-evidence\.mjs/u)
  assert.match(runtimeCacheSource, /check-runtime-cache-evidence\.mjs/u)
  assert.doesNotMatch(runtimeCacheSource, /backend-qps|run-backend-qps/u)
  assert.match(runtimeCacheSource, /--all/u)
  assert.match(runtimeCacheSource, /producer_status=\$\?[\s\S]*check-runtime-cache-evidence/u)
})

function createCanonicalShellFixture(context, producerExit, checkerExit) {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'fsus-runtime-cache-lane-')))
    const fixture = { directory, completed: false }
    context.after(() => {
        if (fixture.completed) {
            rmSync(directory, { recursive: true, force: true })
        } else {
            context.diagnostic(`first failing shell fixture retained at ${directory}`)
        }
    })
    for (const relative of [
        'tools/test/lanes/runtime-cache-evidence.sh',
        'tools/test/lanes/_lane-collect-support.sh',
        'tools/test/lanes/_suite-support.sh',
        'tools/test/lanes/_backend-test-runtime-support.sh',
        'tests/frontend/support/runtime-browser-timeout.mjs'
    ]) {
        const destination = path.join(directory, relative)
        mkdirSync(path.dirname(destination), { recursive: true })
        copyFileSync(path.join(root, relative), destination)
        assert.deepEqual(readFileSync(destination), readFileSync(path.join(root, relative)))
    }

    const namespace = 'hermetic-shell-orchestration'
    const output = path.join(directory, '.tmp/perf/runtime-cache')
    const summary = path.join(directory, '.tmp/release-evidence/runtime-cache-summary.json')
    const capture = path.join(directory, 'processes.jsonl')
    const probeCapture = path.join(directory, 'probe.json')
    const bin = path.join(directory, 'bin')
    mkdirSync(bin)
    mkdirSync(path.join(directory, '.tmp/env'), { recursive: true })
    writeFileSync(path.join(directory, `.tmp/env/${namespace}.env`), [
        `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:9',
        'FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET=hermetic-orchestration-only',
        ''
    ].join('\n'))

    // Only command orchestration is under test: these children do not qualify runtime receipts.
    const stubNode = path.join(bin, 'stub-node')
    writeFileSync(stubNode, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (path.basename(args[0] || '') === 'runtime-browser-timeout.mjs') {
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exit(child.status === null ? 91 : child.status);
}
if (args[0] === '-e' && args[1] === 'process.stdout.write(String(Date.now()))') {
    process.stdout.write(String(Date.now()));
    process.exit(0);
}
const name = path.basename(args[0] || '');
const role = name === 'run-runtime-cache-evidence.mjs' ? 'producer'
    : name === 'check-runtime-cache-evidence.mjs' ? 'checker' : null;
if (!role) throw new Error('unexpected shell child: ' + JSON.stringify(args));
const exitCode = Number(process.env[role === 'producer' ? 'FSUSBLOG_STUB_PRODUCER_EXIT' : 'FSUSBLOG_STUB_CHECKER_EXIT']);
const output = process.env.FSUSBLOG_RUNTIME_CACHE_EVIDENCE_DIR;
const artifact = path.join(output, 'failures', role + '-first-failure.json');
if (exitCode !== 0) {
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    try {
        fs.writeFileSync(artifact, JSON.stringify({
            schema: 'fsusblog.runtime-cache-shell-orchestration-fixture.v1',
            qualification: false,
            role,
            exitCode,
            attempt: process.env.FSUSBLOG_STUB_ATTEMPT
        }) + '\\n', { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    process.stderr.write('[hermetic-shell] ' + role + ' failed exit=' + exitCode + ' artifact=' + artifact + '\\n');
}
fs.appendFileSync(process.env.FSUSBLOG_STUB_CAPTURE, JSON.stringify({
    role, pid: process.pid, parentPid: process.ppid, exitCode, args
}) + '\\n');
process.exit(exitCode);
`)
    chmodSync(stubNode, 0o755)
    const stubCurl = path.join(bin, 'curl')
    writeFileSync(stubCurl, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-1) !== 'http://127.0.0.1:9/api/binary/system/seo') {
    throw new Error('hermetic probe refuses another URL');
}
fs.writeFileSync(process.env.FSUSBLOG_STUB_PROBE_CAPTURE, JSON.stringify(args));
process.stdout.write('200');
`)
    chmodSync(stubCurl, 0o755)
    const env = {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        FSUSBLOG_NODE: stubNode,
        FSUSBLOG_TEST_NAMESPACE: namespace,
        FSUSBLOG_RUNTIME_CACHE_EVIDENCE_DIR: output,
        FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SUMMARY: summary,
        FSUSBLOG_STUB_CAPTURE: capture,
        FSUSBLOG_STUB_PROBE_CAPTURE: probeCapture,
        FSUSBLOG_STUB_PRODUCER_EXIT: String(producerExit),
        FSUSBLOG_STUB_CHECKER_EXIT: String(checkerExit),
        FSUSBLOG_STUB_ATTEMPT: 'first'
    }
    return {
        ...fixture,
        output,
        capture,
        probeCapture,
        env,
        markCompleted: () => { fixture.completed = true },
        run: (attempt = 'first') => {
            const result = spawnSync('/bin/bash', [
                path.join(directory, 'tools/test/lanes/runtime-cache-evidence.sh')
            ], {
                cwd: directory,
                encoding: 'utf8',
                timeout: 10000,
                env: { ...env, FSUSBLOG_STUB_ATTEMPT: attempt }
            })
            writeFileSync(path.join(directory, `${attempt}-shell-result.json`), JSON.stringify({
                status: result.status,
                signal: result.signal,
                error: result.error?.message,
                stdout: result.stdout,
                stderr: result.stderr
            }, null, 4) + '\n')
            return result
        }
    }
}

function assertCanonicalShellFailure(context, producerExit, checkerExit) {
    const fixture = createCanonicalShellFixture(context, producerExit, checkerExit)
    const result = fixture.run()
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.signal, null, result.stderr)
    assert.notEqual(result.status, 0, result.stderr)
    assert.ok(existsSync(fixture.capture), result.stderr)
    const calls = readFileSync(fixture.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(calls.map((call) => call.role), ['producer', 'checker'], result.stderr)
    assert.notEqual(calls[0].pid, calls[1].pid)
    assert.equal(calls[0].parentPid, calls[1].parentPid)
    assert.deepEqual(calls.map((call) => call.exitCode), [producerExit, checkerExit])
    assert.deepEqual(calls[0].args, [
        path.join(fixture.directory, 'tools/test/run-runtime-cache-evidence.mjs'),
        '--all', '--out-dir', fixture.output, '--base-url', 'http://127.0.0.1:9'
    ])
    assert.deepEqual(calls[1].args, [
        path.join(fixture.directory, 'tools/test/check-runtime-cache-evidence.mjs'),
        '--receipt-dir', path.join(fixture.output, 'receipts'),
        '--summary', fixture.env.FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SUMMARY
    ])
    const probe = JSON.parse(readFileSync(fixture.probeCapture, 'utf8'))
    assert.ok(probe.includes('Accept: application/octet-stream'))
    assert.equal(result.stdout.includes('[runtime-cache-evidence] passed'), false, result.stdout)
    const artifacts = []
    for (const [role, exitCode] of [['producer', producerExit], ['checker', checkerExit]]) {
        if (exitCode === 0) continue
        const file = path.join(fixture.output, 'failures', `${role}-first-failure.json`)
        const bytes = readFileSync(file)
        const failure = JSON.parse(bytes)
        assert.equal(failure.qualification, false)
        assert.equal(failure.role, role)
        assert.equal(failure.exitCode, exitCode)
        assert.equal(failure.attempt, 'first')
        assert.ok(result.stderr.includes(`[hermetic-shell] ${role} failed exit=${exitCode} artifact=${file}`), result.stderr)
        artifacts.push({ file, bytes })
    }
    const repeated = fixture.run('second')
    assert.equal(repeated.error, undefined, repeated.stderr)
    assert.notEqual(repeated.status, 0)
    const allCalls = readFileSync(fixture.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(allCalls.map((call) => call.role), ['producer', 'checker', 'producer', 'checker'], repeated.stderr)
    assert.equal(new Set(allCalls.map((call) => call.pid)).size, 4)
    for (const artifact of artifacts) {
        assert.deepEqual(readFileSync(artifact.file), artifact.bytes, 'a repeat must not overwrite the first failure')
    }
    fixture.markCompleted()
}

test('canonical shell reaches checker after producer failure and retains first-failure artifacts', (context) => {
    assertCanonicalShellFailure(context, 17, 0)
})

test('canonical shell rejects checker failure and retains first-failure artifacts', (context) => {
    assertCanonicalShellFailure(context, 0, 23)
})

test('canonical shell retains independent producer and checker failures and first-failure artifacts', (context) => {
    assertCanonicalShellFailure(context, 17, 23)
})

test('mixed executor retains canonical shell stderr and reports a real nonzero child error', (context) => {
    const fixture = createCanonicalShellFixture(context, 0, 23)
    const source = readFileSync(path.join(root, 'tools/test/run-mixed-performance-window.mjs'), 'utf8')
    const start = source.indexOf('function command(command, options = {}) {')
    const end = source.indexOf('\nfunction measuredLoadDuration(', start)
    assert.ok(start >= 0 && end > start, 'the existing command executor must remain extractable')
    const commandSource = source.slice(start, end)
    const commandText = `PATH=${JSON.stringify(fixture.env.PATH)} tools/test/lanes/runtime-cache-evidence.sh`
    const harness = path.join(fixture.directory, 'executor-observation.mjs')
    // Execute the existing private body without exporting a new production runner interface.
    writeFileSync(harness, `import { spawn } from 'node:child_process';
import vm from 'node:vm';
const execute = vm.runInNewContext(${JSON.stringify(commandSource + '\ncommand')}, {
    spawn,
    root: ${JSON.stringify(fixture.directory)},
    process: { env: {} }
});
try {
    await execute(${JSON.stringify(commandText)}, { env: process.env });
    process.exitCode = 90;
} catch (error) {
    process.stdout.write(JSON.stringify({ name: error.name, message: error.message, independentErrors: error.errors ?? null }) + '\\n');
    process.exitCode = 1;
}
`)
    const result = spawnSync(process.execPath, [harness], {
        cwd: fixture.directory,
        encoding: 'utf8',
        timeout: 10000,
        env: fixture.env
    })
    writeFileSync(path.join(fixture.directory, 'executor-result.json'), JSON.stringify({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr
    }, null, 4) + '\n')
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 1, result.stderr)
    const error = JSON.parse(result.stdout.trim())
    assert.equal(error.name, 'Error')
    assert.ok(error.message.startsWith(`${commandText} failed (exit `), error.message)
    assert.match(error.message, /failed \(exit [1-9][0-9]*\)$/u)
    assert.equal(error.independentErrors, null, 'the real executor does not manufacture AggregateError causes')
    const calls = readFileSync(fixture.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(calls.map((call) => call.role), ['producer', 'checker'], result.stderr)
    assert.notEqual(calls[0].pid, calls[1].pid)
    const failure = path.join(fixture.output, 'failures/checker-first-failure.json')
    assert.ok(result.stderr.includes(`[hermetic-shell] checker failed exit=23 artifact=${failure}`), result.stderr)
    assert.equal(JSON.parse(readFileSync(failure, 'utf8')).attempt, 'first')
    fixture.markCompleted()
})
