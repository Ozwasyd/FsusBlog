#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assert,
  assertPathExists,
  flattenMatrixRoutes,
  loadMatrix,
  root,
  walk
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const routes = flattenMatrixRoutes(matrix)

for (const route of routes) {
  assertPathExists(route.frontendWrapper)
  assertPathExists(route.frontendAdapter)
  const wrapper = readFileSync(resolve(root, route.frontendWrapper), 'utf8')
  const adapter = readFileSync(resolve(root, route.frontendAdapter), 'utf8')
  const familyHint = route.path.split('/').filter(Boolean)[0]
  assert(wrapper.includes('/api/binary') || wrapper.includes('binaryApiClient') || wrapper.includes('requestBinary'), `${route.key} wrapper does not use binary API client`)
  assert(adapter.includes('decode') || adapter.includes('read'), `${route.key} adapter does not look like a binary adapter`)
  assert(familyHint, `${route.key} lacks family hint`)
}

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
}

console.log(`[frontend-backend-api-parity] ok routes=${routes.length}`)
