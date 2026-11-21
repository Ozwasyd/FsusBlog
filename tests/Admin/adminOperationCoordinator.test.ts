import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  AdminOperationChannel,
  AdminSessionScope,
} from '../../src/Web/src/admin/adminOperationCoordinator.ts'

function deferred<T = void>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

test('single channel blocks overlapping runs while separate channels run independently', async () => {
  const scope = new AdminSessionScope()
  const session = new AbortController()
  scope.bindSession(session.signal)

  const pendingStates: boolean[] = []
  const main = new AdminOperationChannel(scope, pending => pendingStates.push(pending))
  const secondary = new AdminOperationChannel(scope)

  const gate1 = deferred()
  const gate2 = deferred()
  let mainStarts = 0
  let secondaryStarts = 0

  const first = main.run(async () => {
    mainStarts++
    await gate1.promise
  }, { onError: () => assert.fail('unexpected error') })

  const overlapped = await main.run(async () => {
    mainStarts++
  }, { onError: () => assert.fail('unexpected error') })
  assert.equal(overlapped, false)
  assert.equal(mainStarts, 1)
  assert.equal(main.pending, true)

  const second = secondary.run(async () => {
    secondaryStarts++
    await gate2.promise
  }, { onError: () => assert.fail('unexpected error') })
  assert.equal(secondaryStarts, 1)
  assert.equal(secondary.pending, true)

  gate1.resolve()
  gate2.resolve()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(main.pending, false)
  assert.equal(secondary.pending, false)
  assert.deepEqual(pendingStates, [true, false])
})

test('cancelling operations isolates late completions and errors without clearing a newer run pending state', async () => {
  const scope = new AdminSessionScope()
  const session = new AbortController()
  scope.bindSession(session.signal)
  const channel = new AdminOperationChannel(scope)

  const staleSuccess = deferred()
  const staleError = deferred()
  const freshRun = deferred()
  const errors: unknown[] = []
  let staleSignal!: AbortSignal
  let staleCurrentAfterResolve: boolean | undefined

  const p1 = channel.run(async ctx => {
    staleSignal = ctx.signal
    await staleSuccess.promise
    staleCurrentAfterResolve = ctx.isCurrent()
  }, { onError: err => errors.push(err) })

  assert.equal(staleSignal.aborted, false)
  scope.cancelOperations()
  assert.equal(staleSignal.aborted, true)
  assert.equal(channel.pending, false)

  const p2 = channel.run(async () => {
    await staleError.promise
  }, { onError: err => errors.push(err) })

  channel.cancel()
  assert.equal(channel.pending, false)

  const p3 = channel.run(async ctx => {
    await freshRun.promise
    assert.equal(ctx.isCurrent(), true)
  }, { onError: err => errors.push(err) })
  assert.equal(channel.pending, true)

  // Both late completions arrive while p3 is still pending.
  staleSuccess.resolve()
  staleError.reject(new Error('late stale failure'))
  assert.equal(await p1, false)
  assert.equal(await p2, false)
  assert.equal(staleCurrentAfterResolve, false)
  assert.deepEqual(errors, [])
  assert.equal(channel.pending, true)

  freshRun.resolve()
  assert.equal(await p3, true)
  assert.equal(channel.pending, false)
})

test('switching sessions detaches previous session abort listeners and isolates cross-session failures', async () => {
  let resetCount = 0
  let abortedCount = 0
  const scope = new AdminSessionScope({
    onReset: () => { resetCount++ },
    onSessionAborted: () => { abortedCount++ },
  })
  const channel = new AdminOperationChannel(scope)

  const sessionA = new AbortController()
  const sessionB = new AbortController()
  scope.bindSession(sessionA.signal)
  assert.equal(resetCount, 1)

  const staleTask = deferred()
  const errors: unknown[] = []
  let signalA!: AbortSignal
  const runA = channel.run(async ctx => {
    signalA = ctx.signal
    await staleTask.promise
  }, { onError: err => errors.push(err) })

  // Switch to session B before session A completes or aborts.
  scope.bindSession(sessionB.signal)
  assert.equal(resetCount, 2)
  assert.equal(signalA.aborted, true)
  assert.equal(scope.active, true)

  // Aborting old session A must NOT reset or abort active session B.
  sessionA.abort()
  assert.equal(resetCount, 2)
  assert.equal(abortedCount, 0)
  assert.equal(scope.active, true)

  const freshTask = deferred()
  const runB = channel.run(async ctx => {
    await freshTask.promise
    assert.equal(ctx.isCurrent(), true)
  }, { onError: err => errors.push(err) })

  staleTask.reject(new Error('cross-session 401'))
  assert.equal(await runA, false)
  assert.deepEqual(errors, [])
  assert.equal(channel.pending, true)

  freshTask.resolve()
  assert.equal(await runB, true)
  assert.equal(channel.pending, false)

  // Aborting active session B triggers cleanup once.
  sessionB.abort()
  assert.equal(resetCount, 3)
  assert.equal(abortedCount, 1)
  assert.equal(scope.active, false)
})

test('dispose is idempotent and prevents any subsequent session binding or operations', async () => {
  let resetCount = 0
  const scope = new AdminSessionScope({
    onReset: () => { resetCount++ },
  })
  const channel = new AdminOperationChannel(scope)
  const session = new AbortController()
  scope.bindSession(session.signal)
  assert.equal(resetCount, 1)

  const gate = deferred()
  let capturedSignal!: AbortSignal
  const running = channel.run(async ctx => {
    capturedSignal = ctx.signal
    await gate.promise
  }, { onError: () => assert.fail('disposed run must not invoke onError') })

  scope.dispose()
  scope.dispose()
  scope.dispose()
  assert.equal(scope.disposed, true)
  assert.equal(resetCount, 2)
  assert.equal(capturedSignal.aborted, true)
  assert.equal(channel.pending, false)

  // Aborting old session after dispose does nothing.
  session.abort()
  assert.equal(resetCount, 2)

  // Late failure after dispose is ignored.
  gate.reject(new Error('after dispose'))
  assert.equal(await running, false)

  // Re-binding or starting new operations after dispose is a safe no-op.
  const nextSession = new AbortController()
  assert.equal(scope.bindSession(nextSession.signal).active, false)
  assert.equal(await channel.run(async () => { assert.fail('must not run') }, { onError: () => {} }), false)
  assert.equal(resetCount, 2)
})
