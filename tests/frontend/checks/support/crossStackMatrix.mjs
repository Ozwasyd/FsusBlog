import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const matrixPath = resolve(root, 'tests/frontend/fixtures/cross-stack-contract-matrix.json')
export const openApiPath = resolve(root, 'src/shared/Contracts/Validation/fsusblog.openapi.json')

export function loadMatrix() {
  return JSON.parse(readFileSync(matrixPath, 'utf8'))
}

export function loadProtocol() {
  return JSON.parse(readFileSync(resolve(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'))
}

export function loadBackendGoldenCatalog() {
  return JSON.parse(readFileSync(resolve(root, 'tests/backend/Fixtures/aeds-golden-catalog.json'), 'utf8'))
}

export function loadOpenApi() {
  return JSON.parse(readFileSync(openApiPath, 'utf8'))
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

export function normalizeRouteTemplate(path) {
  // Minimal API templates may include type constraints (`{page:int}`); OpenAPI
  // and matrix routes use bare parameter names (`{page}`). Normalize for keys.
  return String(path).replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}/gu, '{$1}')
}

export function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${normalizeRouteTemplate(path)}`
}

export function extractBackendBinaryRoutes() {
  return extractBackendBinaryRoutesFromOpenApi()
}

export function extractBackendBinaryRoutesFromOpenApi(openapi = loadOpenApi()) {
  const routes = []
  for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
      if (operation['x-fsus-protocol'] !== 'AEDS') continue
      routes.push({
        key: routeKey(method.toUpperCase(), path.replace(/^\/api\/binary/, '') || '/'),
        method: method.toUpperCase(),
        path: path.replace(/^\/api\/binary/, '') || '/',
        source: operation['x-fsus-source'] || openApiPath,
        operationId: operation.operationId,
        requestFrame: operation['x-fsus-request-frame'] || null,
        responseFrame: operation['x-fsus-response-frame'] || null,
        errorFrame: operation['x-fsus-error-frame'] || null,
        auth: operation['x-fsus-auth'] || null,
        pow: operation['x-fsus-pow'],
        cache: operation['x-fsus-cache'] || null,
        rateLimit: operation['x-fsus-rate-limit'] || null
      })
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key))
}

export function extractBackendBinaryRoutesFromSource() {
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
