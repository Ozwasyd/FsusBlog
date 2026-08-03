import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditSerializedElementTree,
  evaluateSecurityObservation,
  productionXssKillControls
} from '../../support/security/productionXssObserver.mjs'

for (const control of productionXssKillControls) {
  test(`production XSS observer rejects ${control.id}`, () => {
    assert.notDeepEqual(evaluateSecurityObservation(control.observation), [])
  })
}

test('production XSS DOM audit rejects event handlers, dangerous URLs and namespaces', () => {
  const failures = auditSerializedElementTree([{
    namespace: 'http://www.w3.org/2000/svg',
    attributes: { onload: 'attack()', href: 'javascript:attack()' }
  }], { allowedNamespaces: ['http://www.w3.org/1999/xhtml'], forbidExternalUrls: true })
  assert.deepEqual(failures.sort(), [
    'dangerous-url:href',
    'event-attribute:onload',
    'namespace:http://www.w3.org/2000/svg'
  ])
})

test('production XSS observer accepts a clean observation', () => {
  assert.deepEqual(evaluateSecurityObservation({ executionSentinel: 0 }), [])
})
