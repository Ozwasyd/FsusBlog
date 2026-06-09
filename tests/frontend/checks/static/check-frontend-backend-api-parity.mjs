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
  if (route.source && route.source !== openApiPath) assertPathExists(route.source)
}

const knownPaths = new Set(routes.map(route => `/api/binary${route.path}`))

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
