#!/usr/bin/env node
import {
  assert,
  assertPathExists,
  extractBackendBinaryRoutes,
  flattenMatrixRoutes,
  loadMatrix,
  loadProtocol
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const protocolFrames = new Set(loadProtocol().frameTypes.map(frame => frame.name))
const actualRoutes = extractBackendBinaryRoutes()
const matrixRoutes = flattenMatrixRoutes(matrix)
const actualKeys = new Set(actualRoutes.map(route => route.key))
const matrixKeys = new Set(matrixRoutes.map(route => route.key))

assert(matrix.version === 'fsusblog-cross-stack-contract-matrix-v1', 'cross-stack contract matrix version drifted')
const missing = [...actualKeys].filter(key => !matrixKeys.has(key)).sort()
const extra = [...matrixKeys].filter(key => !actualKeys.has(key)).sort()
assert(missing.length === 0 && extra.length === 0, `binary endpoint matrix drifted\nmissing=${missing.join(', ')}\nextra=${extra.join(', ')}`)

const duplicateKeys = new Set()
for (const route of matrixRoutes) {
  assert(!duplicateKeys.has(route.key), `duplicate route matrix key ${route.key}`)
  duplicateKeys.add(route.key)
  assertPathExists(route.source)
  assertPathExists(route.frontendWrapper)
  assertPathExists(route.frontendAdapter)
  assert(route.auth, `${route.key} lacks auth classification`)
  assert(route.responseFrame === 'ApiError' || protocolFrames.has(route.responseFrame), `${route.key} responseFrame ${route.responseFrame} not in protocol`)
  if (route.requestFrame) {
    assert(protocolFrames.has(route.requestFrame), `${route.key} requestFrame ${route.requestFrame} not in protocol`)
  }
  assert(typeof route.pow === 'boolean' || route.pow === undefined, `${route.key} pow must be boolean when present`)
}

for (const required of [
  '/api/binary/article/list/home/{page}/{size}.aeds',
  '/api/binary/article/{id}.aeds',
  '/api/binary/article/hot/{size}.aeds',
  '/api/binary/category.aeds',
  '/api/binary/tag.aeds'
]) {
  assert(JSON.stringify(matrix).includes(required), `missing public artifact route ${required}`)
}

console.log(`[binary-contract-matrix] ok routes=${matrixRoutes.length}`)
