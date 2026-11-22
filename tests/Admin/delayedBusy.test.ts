import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelayedBusyGate } from '../../src/Web/src/admin/delayedBusyGate.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('createDelayedBusyGate suppresses sub-threshold fast loading flashes', async () => {
  const transitions: boolean[] = []
  const gate = createDelayedBusyGate(visible => transitions.push(visible), 60)

  gate.update(true)
  await sleep(20)
  gate.update(false)
  await sleep(70)

  assert.deepEqual(transitions, [])
  gate.dispose()
})

test('createDelayedBusyGate surfaces loading after delay and clears immediately on finish', async () => {
  const transitions: boolean[] = []
  const gate = createDelayedBusyGate(visible => transitions.push(visible), 40)

  gate.update(true)
  assert.deepEqual(transitions, [])
  await sleep(60)
  assert.deepEqual(transitions, [true])

  gate.update(false)
  assert.deepEqual(transitions, [true, false])
  gate.dispose()
})

test('createDelayedBusyGate restarts the grace window across rapid toggles and cleans up on dispose', async () => {
  const transitions: boolean[] = []
  const gate = createDelayedBusyGate(visible => transitions.push(visible), 60)

  gate.update(true)
  await sleep(35)
  gate.update(false)
  gate.update(true)
  await sleep(35)
  assert.deepEqual(transitions, [])
  await sleep(40)
  assert.deepEqual(transitions, [true])

  gate.update(false)
  assert.deepEqual(transitions, [true, false])

  gate.update(true)
  gate.dispose()
  await sleep(80)
  assert.deepEqual(transitions, [true, false])
})
