import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeStateObservers } from '../../tools/test-fixtures/observers/index.mjs'
import { loadRuntimeStateAuthority } from '../../tools/test-runtime/catalog.mjs'
import { validateRuntimeStateObserverRegistry } from '../../tools/test-runtime/state-snapshot.mjs'

test('every catalog domain has exact-one registered observer and no second authority', () => {
  const authority = loadRuntimeStateAuthority()
  const observers = createRuntimeStateObservers()
  assert.equal(validateRuntimeStateObserverRegistry(authority, observers), true)
  const observerIds = new Set(observers.map((observer) => observer.observerId))
  assert.deepEqual(observerIds, new Set(Object.values(authority.observerBindings).map((binding) => binding.observerId)))
  assert.throws(() => validateRuntimeStateObserverRegistry(authority, observers.slice(1)), /observer is unavailable/)
  assert.throws(() => validateRuntimeStateObserverRegistry(authority, [...observers, { observerId: 'second-snapshot', version: 'v1', observe() {} }]), /unknown.*registration/)
})
