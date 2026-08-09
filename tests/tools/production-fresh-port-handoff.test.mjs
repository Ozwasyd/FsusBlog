import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createPortLeaseAllocator,
  createPortLeaseControlServerWithOptions,
  defaultRoleCatalog,
  verifyListenerIdentityRef
} from '../../tools/test-matrix/production-fresh-port-lease.mjs'

const modulePath = path.resolve('tools/test-matrix/production-fresh-port-lease.mjs')

function listen(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port, host }, () => resolve(server))
  })
}

function controlRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`control request timed out: ${socketPath}`))
    }, 5000)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        return
      }
      clearTimeout(timer)
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newline)))
    })
    socket.write(`${JSON.stringify(payload)}\n`)
  })
}

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function freePortForPin(role = 'postgres') {
  const probe = createPortLeaseAllocator({ runId: 'probe', namespace: 'probe', roles: defaultRoleCatalog().filter((entry) => entry.role === role) })
  const leases = await probe.allocate()
  const port = leases[0].port
  await probe.releaseAll('probe-release')
  return port
}

test('handoff to a listener bound to the wrong port fails and the lease stays pending', async (t) => {
  const root = tempDir(t, 'fsusblog-port-lease-handoff-')
  const port = await freePortForPin('debug-backend')
  const wrongPort = port === 29999 ? port - 1 : port + 1
  const allocator = createPortLeaseAllocator({
    runId: 'wrong-port',
    namespace: 'wrong-port',
    roles: defaultRoleCatalog().filter((entry) => entry.role === 'debug-backend'),
    pins: { 'debug-backend': port }
  })
  const token = 'a'.repeat(64)
  await allocator.allocate()
  const controlSocketPath = path.join(root, 'control.sock')
  const control = await createPortLeaseControlServerWithOptions({
    controlSocketPath,
    allocator,
    token,
    verifyListenerIdentity: verifyListenerIdentityRef
  })
  t.after(() => control.close())
  try {
    await controlRequest(controlSocketPath, { command: 'release-before-bind', token, role: 'debug-backend' })
    const wrongServer = await listen(wrongPort)
    try {
      const refused = await controlRequest(controlSocketPath, {
        command: 'complete-handoff',
        token,
        role: 'debug-backend',
        listenerIdentityRef: `pid:${process.pid}`
      })
      assert.equal(refused.ok, false)
      assert.match(refused.error, /not bound to leased port/u)
    } finally {
      wrongServer.close()
    }
    assert.equal(allocator.snapshot()[0].handoffState, 'handing-off')
    const realServer = await listen(port)
    try {
      const accepted = await controlRequest(controlSocketPath, {
        command: 'complete-handoff',
        token,
        role: 'debug-backend',
        listenerIdentityRef: `pid:${process.pid}`
      })
      assert.equal(accepted.ok, true)
      assert.equal(accepted.lease.handoffState, 'bound')
      assert.equal(accepted.lease.boundListenerIdentityRef, `pid:${process.pid}`)
      assert.ok(accepted.lease.handedOffAt)
    } finally {
      realServer.close()
    }
  } finally {
    await allocator.releaseAll('test-done')
  }
})

test('control server rejects requests with an invalid reservation token', async (t) => {
  const root = tempDir(t, 'fsusblog-port-lease-token-')
  const port = await freePortForPin('redis')
  const allocator = createPortLeaseAllocator({
    runId: 'token',
    namespace: 'token',
    roles: defaultRoleCatalog().filter((entry) => entry.role === 'redis'),
    pins: { redis: port }
  })
  const token = 'b'.repeat(64)
  await allocator.allocate()
  const controlSocketPath = path.join(root, 'control.sock')
  const control = await createPortLeaseControlServerWithOptions({
    controlSocketPath,
    allocator,
    token,
    verifyListenerIdentity: verifyListenerIdentityRef
  })
  t.after(() => control.close())
  try {
    const response = await controlRequest(controlSocketPath, {
      command: 'release-before-bind',
      token: 'f'.repeat(64),
      role: 'redis'
    })
    assert.equal(response.ok, false)
    assert.match(response.error, /invalid reservation token/u)
    assert.equal(allocator.snapshot()[0].handoffState, 'reserved')
  } finally {
    await allocator.releaseAll('test-done')
  }
})

test('reservation owner crash before handoff: recover releases by owner identity and a new owner is unaffected', async (t) => {
  const root = tempDir(t, 'fsusblog-port-lease-recover-')
  const port = await freePortForPin('postgres')
  const manifestPath = path.join(root, 'port-leases.json')
  const controlSocketPath = path.join(root, 'control.sock')
  const tokenFilePath = path.join(root, 'token')
  const pidFilePath = path.join(root, 'pid')
  const terminalReceiptPath = path.join(root, 'terminal.json')
  const args = [
    modulePath,
    'serve',
    '--run-id',
    'crash-owner',
    '--namespace',
    'crash-owner',
    '--roles',
    'postgres',
    '--pin',
    `postgres:${port}`,
    '--manifest',
    manifestPath,
    '--control-socket',
    controlSocketPath,
    '--token-file',
    tokenFilePath,
    '--pid-file',
    pidFilePath,
    '--terminal-receipt',
    terminalReceiptPath
  ]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFilePath) && fs.existsSync(controlSocketPath) && fs.existsSync(manifestPath)) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(pidFilePath), 'daemon did not write pid file')
  const daemonPid = Number.parseInt(fs.readFileSync(pidFilePath, 'utf8').trim(), 10)
  assert.ok(Number.isInteger(daemonPid) && daemonPid > 0)
  assert.throws(
    () => execFileSync(process.execPath, [modulePath, 'recover', '--manifest', manifestPath], { encoding: 'utf8' }),
    /still alive/u
  )
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  execFileSync(process.execPath, [modulePath, 'recover', '--manifest', manifestPath], { encoding: 'utf8' })
  const receipt = JSON.parse(fs.readFileSync(terminalReceiptPath, 'utf8'))
  assert.equal(receipt.terminalState, 'released')
  assert.equal(receipt.reason, 'owner-crashed')
  const retry = createPortLeaseAllocator({
    runId: 'crash-owner-retry',
    namespace: 'crash-owner',
    roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres'),
    pins: { postgres: port }
  })
  const leases = await retry.allocate()
  assert.equal(leases[0].port, port)
  await retry.releaseAll('test-done')
})

test('target bind failure fails the run closed without re-picking another port', async () => {
  const firstPort = await freePortForPin('postgres')
  const secondPort = await freePortForPin('redis')
  const allocator = createPortLeaseAllocator({
    runId: 'publish-failure',
    namespace: 'publish-failure',
    roles: defaultRoleCatalog().filter((entry) => ['postgres', 'redis'].includes(entry.role)),
    pins: { postgres: firstPort, redis: secondPort }
  })
  await allocator.allocate()
  const before = allocator.snapshot()
  try {
    await allocator.beginHandoff('postgres')
    await allocator.failHandoff('postgres', 'docker publish failed: host port conflict')
    const after = allocator.snapshot()
    const postgres = after.find((lease) => lease.role === 'postgres')
    const redis = after.find((lease) => lease.role === 'redis')
    assert.equal(postgres.handoffState, 'failed')
    assert.match(postgres.failedReason, /docker publish failed/u)
    assert.equal(postgres.port, firstPort, 'failed role must not silently move to another port')
    assert.equal(redis.handoffState, 'reserved')
    assert.equal(redis.port, secondPort, 'other role must keep its sealed port')
    assert.deepEqual(
      after.map((lease) => lease.port).sort(),
      before.map((lease) => lease.port).sort(),
      'no port may be re-picked after a publish failure'
    )
  } finally {
    await allocator.releaseAll('test-done')
  }
})

test('container identity verification fails closed for a container without the leased host port', async () => {
  const port = await freePortForPin('redis')
  const allocator = createPortLeaseAllocator({
    runId: 'container-ref',
    namespace: 'container-ref',
    roles: defaultRoleCatalog().filter((entry) => entry.role === 'redis'),
    pins: { redis: port }
  })
  await allocator.allocate()
  try {
    await allocator.beginHandoff('redis')
    assert.equal(
      await verifyListenerIdentityRef({ role: 'redis', port, listenerIdentityRef: 'container:does-not-exist-0000' }),
      false
    )
  } finally {
    await allocator.releaseAll('test-done')
  }
})

test('verifyListenerIdentityRef rejects malformed or non-listener pid refs', async () => {
  const port = await freePortForPin('debug-frontend')
  const allocator = createPortLeaseAllocator({
    runId: 'pid-ref',
    namespace: 'pid-ref',
    roles: defaultRoleCatalog().filter((entry) => entry.role === 'debug-frontend'),
    pins: { 'debug-frontend': port }
  })
  await allocator.allocate()
  try {
    await allocator.beginHandoff('debug-frontend')
    assert.equal(await verifyListenerIdentityRef({ role: 'debug-frontend', port, listenerIdentityRef: 'pid:not-a-number' }), false)
    assert.equal(await verifyListenerIdentityRef({ role: 'debug-frontend', port, listenerIdentityRef: 'pid:1' }), false)
    assert.equal(await verifyListenerIdentityRef({ role: 'debug-frontend', port, listenerIdentityRef: '' }), false)
  } finally {
    await allocator.releaseAll('test-done')
  }
})
