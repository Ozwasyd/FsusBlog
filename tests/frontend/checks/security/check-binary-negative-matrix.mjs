#!/usr/bin/env node
import {
  assert,
  assertPathExists,
  flattenMatrixRoutes,
  loadMatrix
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const requiredNegativeCases = new Set(matrix.negativeCases)
const routes = flattenMatrixRoutes(matrix)
const mutationRoutes = routes.filter(route => route.method !== 'GET')

assert(requiredNegativeCases.size >= 18, 'negative matrix must cover issue #41 cases')
assert(mutationRoutes.length > 0, 'negative matrix found no mutation routes')

for (const route of mutationRoutes) {
  assert(route.responseFrame, `${route.key} lacks response frame`)
  assert(route.auth, `${route.key} lacks auth classification`)
  assert(route.requestFrame || ['DELETE', 'PUT', 'POST'].includes(route.method), `${route.key} lacks request frame or mutation method`)
  if (route.auth === 'admin') {
    assert(requiredNegativeCases.has('wrong-role'), `${route.key} needs wrong-role negative case`)
  }
  if (route.pow) {
    assert(requiredNegativeCases.has('missing-pow'), `${route.key} needs missing-pow negative case`)
    assert(requiredNegativeCases.has('replayed-pow'), `${route.key} needs replayed-pow negative case`)
  }
  assert(requiredNegativeCases.has('malformed-aeds-header'), `${route.key} needs malformed-aeds-header negative case`)
  assert(requiredNegativeCases.has('wrong-request-frame-type'), `${route.key} needs wrong-request-frame-type negative case`)
}

for (const profile of matrix.profiles.filter(profile => profile.id === 'contract-negative-matrix')) {
  for (const path of profile.evidencePaths) {
    assertPathExists(path)
  }
}

console.log(`[binary-negative-matrix] ok mutationRoutes=${mutationRoutes.length} cases=${requiredNegativeCases.size}`)
