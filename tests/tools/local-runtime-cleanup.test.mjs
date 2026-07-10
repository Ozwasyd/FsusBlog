import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { cleanupLocalRuntime, cleanupStaleLocalRuntimes } from '../../tools/test-matrix/local-runtime-cleanup.mjs'

test('default container cleanup removes anonymous test volumes with the container', () => {
  const source = fs.readFileSync('tools/test-matrix/local-runtime-cleanup.mjs', 'utf8')
  assert.match(source, /spawnSync\('docker', \['rm', '--force', '--volumes', name\]/u)
  assert.match(source, /process\.kill\(-pid, 'SIGTERM'\)/u)
})

test('cleanupStaleLocalRuntimes discovers tracked namespaces before fresh output deletion', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-stale-runtime-cleanup-'))
  for (const namespace of ['production-old-a', 'production-old-b']) {
    const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
    const envDir = path.join(root, '.tmp/env')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${namespace.endsWith('a') ? 101 : 202}\n`)
    fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
      `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
      `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`
    ].join('\n'))
  }

  const removedContainers = []
  const terminatedPids = []
  const result = cleanupStaleLocalRuntimes({
    root,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: (pid) => { terminatedPids.push(pid); return true }
  })

  assert.deepEqual(result.namespaces, ['production-old-a', 'production-old-b'])
  assert.deepEqual(terminatedPids, [101, 202])
  assert.deepEqual(removedContainers, [
    'fsusblog-test-postgres-production-old-a',
    'fsusblog-test-redis-production-old-a',
    'fsusblog-test-postgres-production-old-b',
    'fsusblog-test-redis-production-old-b'
  ])
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-a')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-b')), false)
})

test('default stale cleanup refuses a reused pid that is not a managed acceptance command', () => {
  if (process.platform === 'win32') return
  const root = process.cwd()
  const namespace = `reused-pid-${process.pid}`
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${process.pid}\n`)

  const result = cleanupLocalRuntime({ root, namespace })

  assert.deepEqual(result.terminatedPids, [])
})

test('cleanupLocalRuntime removes only containers and process state owned by its namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-42'
  const envDir = path.join(root, '.tmp/env')
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  fs.mkdirSync(envDir, { recursive: true })
  for (const directory of [runtimeDir, fixtureDir, dataDir]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture'), 'fixture')
  }
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '999999\n')
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
    `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`,
    'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:40000'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
  assert.deepEqual(result.removedContainers, removedContainers)
  assert.equal(fs.existsSync(path.join(envDir, `${namespace}.env`)), false)
  assert.equal(fs.existsSync(runtimeDir), false)
  assert.equal(fs.existsSync(fixtureDir), false)
  assert.equal(fs.existsSync(dataDir), false)
})

test('cleanupLocalRuntime refuses container names not derived from the current namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-43'
  const envDir = path.join(root, '.tmp/env')
  fs.mkdirSync(envDir, { recursive: true })
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-dev-postgres',
    'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-other-run'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [])
  assert.deepEqual(result.skippedContainers, ['fsusblog-dev-postgres', 'fsusblog-test-redis-other-run'])
})
