#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assert,
  assertPathExists,
  extractBackendBinaryRoutes,
  openApiPath,
  root,
  walk
} from '../support/crossStackMatrix.mjs'

const routes = extractBackendBinaryRoutes()
const routeConstantsPath = resolve(root, 'src/frontend/src/generated/fsusBinaryRoutes.ts')
assertPathExists('src/frontend/src/generated/fsusBinaryRoutes.ts')
const routeConstants = readFileSync(routeConstantsPath, 'utf8')

for (const route of routes) {
  assert(route.operationId, `${route.key} lacks OpenAPI operationId`)
  assert(routeConstants.includes(JSON.stringify(route.operationId)), `${route.key} missing generated route constant`)
  assert(routeConstants.includes(JSON.stringify(`/api/binary${route.path}`)), `${route.key} missing generated path constant`)
  const descriptorLine = findRouteDescriptorLine(route.operationId)
  assert(descriptorLine.includes('credentialPolicy:'), `${route.key} missing generated credential policy`)
  if (isAnonymousPublicRead(route)) {
    assert(descriptorLine.includes('credentialPolicy: "omit"'), `${route.key} anonymous public read must omit credentials`)
  } else {
    assert(descriptorLine.includes('credentialPolicy: "include"'), `${route.key} non-public-read route must include credentials by default`)
  }
  if (route.source && route.source !== openApiPath) assertPathExists(route.source)
}

const knownPaths = new Set(routes.map(route => `/api/binary${route.path}`))
const descriptorOnlyWrappers = new Set([
  'src/frontend/src/api/article.ts',
  'src/frontend/src/api/auth.ts',
  'src/frontend/src/api/comment.ts',
  'src/frontend/src/api/message.ts',
  'src/frontend/src/api/system.ts'
])

const legacyPatterns = [
  /['"`]\/api\/Article\b/g,
  /['"`]\/api\/Category\b/g,
  /['"`]\/api\/Tag\b/g,
  /['"`]\/api\/Comment\b/g,
  /['"`]\/api\/Upload\b/g,
  /['"`]\/api\/Message\b/g
]

for (const file of walk(resolve(root, 'src/frontend/src/api'), path => /\.(ts|js)$/.test(path))) {
  const source = readFileSync(file, 'utf8')
  const relativePath = file.slice(root.length + 1)
  if (descriptorOnlyWrappers.has(relativePath)) {
    assert(
      !/['"`]\/api\/binary\//.test(source),
      `${relativePath} must use generated binaryRoute descriptors instead of manual /api/binary paths`
    )
  }
  for (const pattern of legacyPatterns) {
    assert(!pattern.test(source), `${file} contains legacy JSON API path ${pattern}`)
    pattern.lastIndex = 0
  }
  for (const match of source.matchAll(/['"`](\/api\/binary\/[^'"`?${}]*)/g)) {
    assert(matchesKnownPath(match[1]), `${file} contains stale manual binary path ${match[1]}`)
  }
}

console.log(`[frontend-backend-api-parity] ok openapiRoutes=${routes.length}`)

function matchesKnownPath(value) {
  if (knownPaths.has(value)) return true
  for (const known of knownPaths) {
    const prefix = known.split('{')[0]
    if (prefix && (value === prefix.replace(/\/$/, '') || value.startsWith(prefix))) return true
  }
  return false
}

function isAnonymousPublicRead(route) {
  return route.auth === 'anonymous'
    && route.method === 'GET'
    && route.rateLimit === 'public_read'
    && route.cache === 'public-read'
}

function findRouteDescriptorLine(operationId) {
  const needle = `${JSON.stringify(operationId)}: { operationId: ${JSON.stringify(operationId)}`
  const line = routeConstants.split('\n').find(item => item.includes(needle))
  assert(line, `${operationId} missing generated route descriptor`)
  return line
}
