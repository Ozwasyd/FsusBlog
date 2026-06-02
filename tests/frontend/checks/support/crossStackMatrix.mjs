import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const matrixPath = resolve(root, 'tests/frontend/fixtures/cross-stack-contract-matrix.json')

export function loadMatrix() {
  return JSON.parse(readFileSync(matrixPath, 'utf8'))
}

export function loadProtocol() {
  return JSON.parse(readFileSync(resolve(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'))
}

export function loadBackendGoldenCatalog() {
  return JSON.parse(readFileSync(resolve(root, 'tests/backend/Fixtures/aeds-golden-catalog.json'), 'utf8'))
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function assertPathExists(path) {
  const fullPath = resolve(root, path)
  assert(existsSync(fullPath), `missing path ${path}`)
}

export function flattenMatrixRoutes(matrix = loadMatrix()) {
  const routes = []
  for (const family of matrix.endpointFamilies || []) {
    for (const route of family.routes || []) {
      routes.push({
        ...route,
        key: routeKey(route.method, route.path),
        source: family.source,
        frontendWrapper: route.frontendWrapper || family.frontendWrapper,
        frontendAdapter: route.frontendAdapter || family.frontendAdapter
      })
    }
  }
  return routes
}

export function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${path}`
}

export function extractBackendBinaryRoutes() {
  const dir = resolve(root, 'src/backend/Modules/Endpoints/Binary')
  const routes = []
  for (const file of walk(dir, path => path.endsWith('.cs') && !path.endsWith('Adapters.cs'))) {
    const source = readFileSync(file, 'utf8')
    const regex = /\b([A-Za-z0-9_]+)\.Map(Get|Post|Put|Delete)\("([^"]+)"/g
    let match
    while ((match = regex.exec(source)) !== null) {
      const receiver = match[1]
      const method = match[2].toUpperCase()
      const rawPath = match[3]
      const prefix = receiver === 'uploadGroup' ? '/upload' : ''
      routes.push({
        key: routeKey(method, `${prefix}${rawPath}`),
        method,
        path: `${prefix}${rawPath}`,
        source: relative(root, file).replace(/\\/g, '/')
      })
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key))
}

export function walk(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      walk(fullPath, predicate, results)
    } else if (predicate(fullPath)) {
      results.push(fullPath)
    }
  }
  return results
}

export function validateCoherenceProfile(profileId) {
  const matrix = loadMatrix()
  const requirementIds = new Set((matrix.requirements || []).map(requirement => requirement.id))
  const profile = (matrix.coherenceProfiles || []).find(item => item.id === profileId)
  assert(profile, `missing coherence profile ${profileId}`)
  assert(Array.isArray(profile.surfaces) && profile.surfaces.length >= 5, `${profileId} lacks surfaces`)
  for (const requirement of profile.requirements || []) {
    assert(requirementIds.has(requirement), `${profileId} references unknown requirement ${requirement}`)
  }
  for (const path of profile.evidencePaths || []) {
    assertPathExists(path)
  }
  return profile
}
