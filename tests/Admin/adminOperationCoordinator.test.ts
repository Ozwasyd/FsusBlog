import { strict as assert } from 'node:assert'
import test from 'node:test'
import { AdminOperationChannel, AdminSessionScope } from '../../src/Web/src/admin/adminOperationCoordinator.ts'
import { createDelayedBusyGate } from '../../src/Web/src/admin/delayedBusyGate.ts'
import { bindTestSession } from './controllerSession.ts'

function setupCoordinator(options?: ConstructorParameters<typeof AdminSessionScope>[0]) {
  const scope = new AdminSessionScope(options)
  const pendingStates: boolean[] = []
  const errors: unknown[] = []
  const channel = new AdminOperationChannel(scope, pending => pendingStates.push(pending))
  const onError = (err: unknown) => { errors.push(err) }
  const session = bindTestSession(scope)
  return { scope, channel, session, pendingStates, errors, onError }
}

test('single channel blocks overlapping runs while separate channels run independently', async () => {
  const { scope, channel: main, pendingStates } = setupCoordinator()
  const secondary = new AdminOperationChannel(scope)
  const gate1 = Promise.withResolvers<void>()
  const gate2 = Promise.withResolvers<void>()
  let [mainStarts, secondaryStarts] = [0, 0]
  const failError = { onError: () => assert.fail('unexpected error') }

  const first = main.run(async () => { mainStarts++; await gate1.promise }, failError)
  const overlapped = await main.run(async () => { mainStarts++ }, failError)
  assert.deepEqual([overlapped, mainStarts, main.pending], [false, 1, true])

  const second = secondary.run(async () => { secondaryStarts++; await gate2.promise }, failError)
  assert.deepEqual([secondaryStarts, secondary.pending], [1, true])

  gate1.resolve()
  gate2.resolve()
  assert.deepEqual([await first, await second], [true, true])
  assert.deepEqual([main.pending, secondary.pending], [false, false])
  assert.deepEqual(pendingStates, [true, false])
})

test('cancelling operations isolates late completions and errors without clearing a newer run pending state', async () => {
  const { scope, channel, errors, onError } = setupCoordinator()
  const staleSuccess = Promise.withResolvers<void>()
  const staleError = Promise.withResolvers<void>()
  const freshRun = Promise.withResolvers<void>()
  let staleSignal!: AbortSignal
  let staleCurrentAfterResolve: boolean | undefined

  const p1 = channel.run(async ctx => {
    staleSignal = ctx.signal
    await staleSuccess.promise
    staleCurrentAfterResolve = ctx.isCurrent()
  }, { onError })
  assert.equal(staleSignal.aborted, false)
  scope.cancelOperations()
  assert.deepEqual([staleSignal.aborted, channel.pending], [true, false])

  const p2 = channel.run(async () => { await staleError.promise }, { onError })
  channel.cancel()
  assert.equal(channel.pending, false)

  const p3 = channel.run(async ctx => { await freshRun.promise; assert.equal(ctx.isCurrent(), true) }, { onError })
  assert.equal(channel.pending, true)

  staleSuccess.resolve()
  staleError.reject(new Error('late stale failure'))
  assert.deepEqual([await p1, await p2, staleCurrentAfterResolve], [false, false, false])
  assert.deepEqual(errors, [])
  assert.equal(channel.pending, true)

  freshRun.resolve()
  assert.deepEqual([await p3, channel.pending], [true, false])
})

test('switching sessions detaches previous session abort listeners and isolates cross-session failures', async () => {
  let [resetCount, abortedCount] = [0, 0]
  const { scope, channel, session: sessionA, errors, onError } = setupCoordinator({
    onReset: () => { resetCount++ },
    onSessionAborted: () => { abortedCount++ },
  })
  assert.equal(resetCount, 1)

  const staleTask = Promise.withResolvers<void>()
  let signalA!: AbortSignal
  const runA = channel.run(async ctx => { signalA = ctx.signal; await staleTask.promise }, { onError })

  const sessionB = bindTestSession(scope)
  assert.deepEqual([resetCount, signalA.aborted, scope.active], [2, true, true])

  sessionA.abort()
  assert.deepEqual([resetCount, abortedCount, scope.active], [2, 0, true])

  const freshTask = Promise.withResolvers<void>()
  const runB = channel.run(async ctx => { await freshTask.promise; assert.equal(ctx.isCurrent(), true) }, { onError })

  staleTask.reject(new Error('cross-session 401'))
  assert.deepEqual([await runA, errors, channel.pending], [false, [], true])

  freshTask.resolve()
  assert.deepEqual([await runB, channel.pending], [true, false])

  sessionB.abort()
  assert.deepEqual([resetCount, abortedCount, scope.active], [3, 1, false])
})

test('dispose is idempotent and prevents any subsequent session binding or operations', async () => {
  let resetCount = 0
  const { scope, channel, session } = setupCoordinator({ onReset: () => { resetCount++ } })
  assert.equal(resetCount, 1)

  const gate = Promise.withResolvers<void>()
  let capturedSignal!: AbortSignal
  const running = channel.run(async ctx => { capturedSignal = ctx.signal; await gate.promise },
    { onError: () => assert.fail('disposed run must not invoke onError') })

  scope.dispose()
  scope.dispose()
  scope.dispose()
  assert.deepEqual([scope.disposed, resetCount], [true, 2])
  assert.deepEqual([capturedSignal.aborted, channel.pending], [true, false])

  session.abort()
  assert.equal(resetCount, 2)

  gate.reject(new Error('after dispose'))
  assert.equal(await running, false)

  const nextSession = new AbortController()
  assert.equal(scope.bindSession(nextSession.signal).active, false)
  assert.equal(await channel.run(async () => { assert.fail('must not run') }, { onError: () => {} }), false)
  assert.equal(resetCount, 2)
})

test('createDelayedBusyGate suppresses short flashes, surfaces after delay, restarts across toggles, and cleans up on dispose', async () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const makeGate = (delayMs: number) => {
    const transitions: boolean[] = []
    return { transitions, gate: createDelayedBusyGate(visible => transitions.push(visible), delayMs) }
  }

  const fast = makeGate(60)
  fast.gate.update(true)
  await sleep(20)
  fast.gate.update(false)
  await sleep(70)
  assert.deepEqual(fast.transitions, [])
  fast.gate.dispose()

  const slow = makeGate(40)
  slow.gate.update(true)
  assert.deepEqual(slow.transitions, [])
  await sleep(60)
  assert.deepEqual(slow.transitions, [true])
  slow.gate.update(false)
  assert.deepEqual(slow.transitions, [true, false])
  slow.gate.dispose()

  const rapid = makeGate(60)
  rapid.gate.update(true)
  await sleep(35)
  rapid.gate.update(false)
  rapid.gate.update(true)
  await sleep(35)
  assert.deepEqual(rapid.transitions, [])
  await sleep(40)
  assert.deepEqual(rapid.transitions, [true])
  rapid.gate.update(false)
  assert.deepEqual(rapid.transitions, [true, false])
  rapid.gate.update(true)
  rapid.gate.dispose()
  await sleep(80)
  assert.deepEqual(rapid.transitions, [true, false])
})
