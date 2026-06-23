#!/usr/bin/env node
import {
  assert,
  assertPathExists,
  extractBackendBinaryRoutes,
  extractBackendBinaryRoutesFromSource,
  flattenMatrixRoutes,
  loadMatrix,
  loadOpenApi,
  loadProtocol
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const protocolFrames = new Set(loadProtocol().frameTypes.map(frame => frame.name))
const openapi = loadOpenApi()
const actualRoutes = extractBackendBinaryRoutes()
const matrixRoutes = flattenMatrixRoutes(matrix)
const actualKeys = new Set(actualRoutes.map(route => route.key))
const matrixKeys = new Set(matrixRoutes.map(route => route.key))

assert(matrix.version === 'fsusblog-cross-stack-contract-matrix-v1', 'cross-stack contract matrix version drifted')
const publicArtifactKeys = new Set((matrix.publicArtifactRoutes || []).map(route => `${route.method.toUpperCase()} ${route.path.replace(/^\/api\/binary/, '')}`))
const missing = [...actualKeys].filter(key => !matrixKeys.has(key) && !publicArtifactKeys.has(key)).sort()
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

for (const route of actualRoutes) {
  assert(route.responseFrame === 'server-only/no-response-body' || protocolFrames.has(route.responseFrame), `${route.key} OpenAPI responseFrame ${route.responseFrame} not in protocol`)
  assert(route.errorFrame === 'ApiError', `${route.key} OpenAPI error frame must be ApiError`)
  assert(['anonymous', 'optional', 'user', 'admin'].includes(route.auth), `${route.key} invalid OpenAPI auth ${route.auth}`)
  assert(typeof route.pow === 'boolean', `${route.key} OpenAPI pow must be boolean`)
}

const openApiBinaryPathCount = Object.entries(openapi.paths || {})
  .flatMap(([path, item]) => Object.entries(item || {}).map(([method, operation]) => ({ path, method, operation })))
  .filter(item => item.operation['x-fsus-protocol'] === 'AEDS').length
assert(openApiBinaryPathCount === actualRoutes.length, 'OpenAPI operation count drifted from extracted route count')

const sourceRoutes = extractBackendBinaryRoutesFromSource()
const openapiSourceKeys = new Set(actualRoutes.map(route => route.key))
const sourceMissing = sourceRoutes.filter(route => !openapiSourceKeys.has(route.key)).map(route => route.key)
assert(sourceMissing.length === 0, `binary endpoint source routes missing from OpenAPI metadata: ${sourceMissing.join(', ')}`)

for (const required of [
  '/api/binary/article/list/home/{page}/{size}.aeds',
  '/api/binary/article/list/archive/{page}/{size}.aeds',
  '/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds',
  '/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds',
  '/api/binary/article/{id}.aeds',
  '/api/binary/article/hot/{size}.aeds',
  '/api/binary/category.aeds',
  '/api/binary/tag.aeds'
]) {
  assert(JSON.stringify(matrix).includes(required), `missing public artifact route ${required}`)
}

const refreshTokenRoute = matrixRoutes.find(route => route.method === 'POST' && route.path === '/auth/refresh-token')
assert(refreshTokenRoute?.responseFrame === 'EmptySuccess', 'refresh-token responseFrame must remain EmptySuccess')

console.log(`[binary-contract-matrix] ok openapiRoutes=${actualRoutes.length} matrixRoutes=${matrixRoutes.length}`)
