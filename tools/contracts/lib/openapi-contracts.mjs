import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
export const committedOpenApiPath = path.join(root, 'src/shared/Contracts/Validation/fsusblog.openapi.json')
export const generatedOpenApiPath = path.join(root, '.tmp/contracts/openapi/fsusblog.openapi.json')
export const matrixPath = path.join(root, 'tests/frontend/fixtures/cross-stack-contract-matrix.json')
export const generatedMatrixPath = path.join(root, 'tests/frontend/fixtures/cross-stack-contract-matrix.generated.json')
export const protocolPath = path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json')
export const frontendRoutesPath = path.join(root, 'src/frontend/src/generated/fsusBinaryRoutes.ts')

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function loadProtocol() {
  return readJson(protocolPath)
}

export function loadMatrix() {
  return readJson(matrixPath)
}

export function loadOpenApi({ preferGenerated = true } = {}) {
  const candidate = preferGenerated && fs.existsSync(generatedOpenApiPath)
    ? generatedOpenApiPath
    : committedOpenApiPath
  return readJson(candidate)
}

export function frameNames(protocol = loadProtocol()) {
  return new Set((protocol.frameTypes ?? []).map((frame) => frame.name))
}

export function normalizeBinaryPath(pathValue) {
  const value = String(pathValue)
  return value.startsWith('/api/binary') ? value : `/api/binary${value.startsWith('/') ? value : `/${value}`}`
}

export function matrixPathFromOpenApiPath(pathValue) {
  return String(pathValue).replace(/^\/api\/binary/, '') || '/'
}

export function operationIdFor(method, pathValue) {
  return `binary_${String(method).toLowerCase()}_${normalizeBinaryPath(pathValue)
    .replace(/^\/api\/binary\/?/, '')
    .replace(/[{}:.?=&/-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')}`
}

export function flattenMatrixRoutes(matrix = loadMatrix()) {
  const routes = []
  for (const family of matrix.endpointFamilies ?? []) {
    for (const route of family.routes ?? []) {
      routes.push({
        ...route,
        method: String(route.method).toUpperCase(),
        path: route.path,
        fullPath: normalizeBinaryPath(route.path),
        source: family.source,
        frontendWrapper: route.frontendWrapper || family.frontendWrapper,
        frontendAdapter: route.frontendAdapter || family.frontendAdapter,
        operationId: route.operationId || operationIdFor(route.method, route.path),
        testSurface: route.surface || family.id || route.path
      })
    }
  }
  for (const route of (matrix.publicArtifactRoutes ?? []).filter((item) => String(item.path).includes('.aeds'))) {
    routes.push({
      ...route,
      method: String(route.method).toUpperCase(),
      path: matrixPathFromOpenApiPath(route.path),
      fullPath: normalizeBinaryPath(route.path),
      auth: route.auth || 'anonymous',
      pow: Boolean(route.pow),
      requestFrame: route.requestFrame || null,
      responseFrame: route.responseFrame,
      errorFrame: route.errorFrame || 'ApiError',
      successStatus: route.successStatus || 200,
      source: route.source || 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs',
      frontendWrapper: route.frontendWrapper || 'src/frontend/src/api/article.ts',
      frontendAdapter: route.frontendAdapter || 'src/frontend/src/services/binaryTransport.ts',
      operationId: route.operationId || operationIdFor(route.method, route.path),
      testSurface: route.surface || 'public-artifact'
    })
  }
  return routes
}

export function buildOpenApiFromMatrix(matrix = loadMatrix(), protocol = loadProtocol()) {
  const frames = frameNames(protocol)
  const paths = {}
  const invalidFrames = []
  for (const route of flattenMatrixRoutes(matrix)) {
    for (const frame of [route.requestFrame, route.responseFrame, route.errorFrame || 'ApiError'].filter(Boolean)) {
      if (!frames.has(frame)) invalidFrames.push(`${route.method} ${route.fullPath}: ${frame}`)
    }
    const pathItem = paths[route.fullPath] ?? {}
    const successStatus = String(route.successStatus || 200)
    const successResponse = {
      description: `${route.responseFrame || 'NoBody'} AEDS frame`,
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' }
        }
      }
    }
    if (route.successHeaders && Object.keys(route.successHeaders).length > 0) {
      successResponse.headers = route.successHeaders
    }
    const responses = {
      [successStatus]: successResponse,
      ...Object.fromEntries(Object.entries(route.errorResponses ?? {}).map(([status, description]) => [
        String(status),
        {
          description,
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' }
            }
          }
        }
      ])),
      default: {
        description: 'ApiError AEDS frame',
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' }
          }
        }
      }
    }
    const operation = {
      operationId: route.operationId,
      tags: ['Binary'],
      summary: route.summary || route.testSurface,
      responses,
      'x-fsus-protocol': 'AEDS',
      'x-fsus-aeds-version': protocol.header?.version ?? 2,
      'x-fsus-request-frame': route.requestFrame || null,
      'x-fsus-response-frame': route.responseFrame || 'server-only/no-response-body',
      'x-fsus-error-frame': route.errorFrame || 'ApiError',
      'x-fsus-auth': route.auth || 'anonymous',
      'x-fsus-pow': Boolean(route.pow),
      'x-fsus-content-type': 'application/octet-stream',
      'x-fsus-success-status': Number(successStatus),
      'x-fsus-cache': route.cache || (route.auth === 'anonymous' ? 'public-read' : 'no-store'),
      'x-fsus-rate-limit': route.rateLimit || (route.auth === 'anonymous' ? 'public_read' : 'authenticated'),
      'x-fsus-test-surface': route.testSurface,
      'x-fsus-source': route.source,
      'x-fsus-frontend-wrapper': route.frontendWrapper,
      'x-fsus-frontend-adapter': route.frontendAdapter
    }
    if (route.parameters && route.parameters.length > 0) {
      operation.parameters = route.parameters
    }
    pathItem[String(route.method).toLowerCase()] = operation
    paths[route.fullPath] = pathItem
  }
  if (invalidFrames.length > 0) {
    throw new Error(`OpenAPI matrix references unknown AEDS frames:\n${invalidFrames.join('\n')}`)
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'FsusBlog Binary API',
      version: '2.0.0',
      description: 'Generated HTTP shell contract for /api/binary AEDS v2 endpoints.'
    },
    paths,
    components: {
      schemas: {
        AedsFrame: { type: 'string', format: 'binary' }
      }
    },
    'x-fsus-contract-source': {
      matrix: 'tests/frontend/fixtures/cross-stack-contract-matrix.json',
      protocol: 'src/shared/Contracts/Validation/aeds-protocol.json'
    }
  }
}

export function operationsFromOpenApi(openapi = loadOpenApi()) {
  const operations = []
  for (const [pathValue, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
      operations.push({
        method: method.toUpperCase(),
        path: matrixPathFromOpenApiPath(pathValue),
        fullPath: pathValue,
        key: `${method.toUpperCase()} ${matrixPathFromOpenApiPath(pathValue)}`,
        operationId: operation.operationId || operationIdFor(method, pathValue),
        requestFrame: operation['x-fsus-request-frame'] || null,
        responseFrame: operation['x-fsus-response-frame'] || null,
        errorFrame: operation['x-fsus-error-frame'] || null,
        auth: operation['x-fsus-auth'] || null,
        pow: operation['x-fsus-pow'],
        cache: operation['x-fsus-cache'] || null,
        rateLimit: operation['x-fsus-rate-limit'] || null,
        source: operation['x-fsus-source'] || null,
        frontendWrapper: operation['x-fsus-frontend-wrapper'] || null,
        frontendAdapter: operation['x-fsus-frontend-adapter'] || null,
        testSurface: operation['x-fsus-test-surface'] || null,
        operation
      })
    }
  }
  return operations.sort((a, b) => a.key.localeCompare(b.key))
}

export function generatedMatrixFromOpenApi(openapi = loadOpenApi(), currentMatrix = loadMatrix()) {
  const operationKeys = new Set(operationsFromOpenApi(openapi).map((op) => op.key))
  const matrixKeys = new Set(flattenMatrixRoutes(currentMatrix).map((route) => `${route.method} ${route.path}`))
  const missing = [...operationKeys].filter((key) => !matrixKeys.has(key)).sort()
  const extra = [...matrixKeys].filter((key) => !operationKeys.has(key)).sort()
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`OpenAPI/generated matrix route drift\nmissing=${missing.join(', ')}\nextra=${extra.join(', ')}`)
  }
  return {
    ...currentMatrix,
    generatedFrom: {
      openapi: 'src/shared/Contracts/Validation/fsusblog.openapi.json',
      protocol: 'src/shared/Contracts/Validation/aeds-protocol.json'
    },
    openapiOperationCount: operationKeys.size
  }
}

export function generateFrontendRoutes(openapi = loadOpenApi()) {
  const operations = operationsFromOpenApi(openapi)
  const lines = [
    '// Generated by tools/contracts/generate-frontend-routes.mjs; do not edit by hand.',
    'export const fsusBinaryRoutes = {'
  ]
  for (const op of operations) {
    lines.push(`  ${JSON.stringify(op.operationId)}: ${JSON.stringify(op.fullPath)},`)
  }
  lines.push('} as const')
  lines.push('')
  lines.push('export const fsusBinaryRouteDescriptors = {')
  for (const op of operations) {
    lines.push(`  ${JSON.stringify(op.operationId)}: { operationId: ${JSON.stringify(op.operationId)}, method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.fullPath)}, requestFrame: ${JSON.stringify(op.requestFrame ?? null)}, responseFrame: ${JSON.stringify(op.responseFrame ?? null)}, auth: ${JSON.stringify(op.auth)}, requiresPow: ${Boolean(op.pow)}, rateLimitPolicy: ${JSON.stringify(op.rateLimit ?? null)}, cachePolicy: ${JSON.stringify(op.cache ?? null)}, credentialPolicy: ${JSON.stringify(resolveCredentialPolicy(op))} },`)
  }
  lines.push('} as const')
  lines.push('')
  lines.push('export const fsusBinaryRouteSecurity = {')
  for (const op of operations) {
    lines.push(`  ${JSON.stringify(op.operationId)}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.fullPath)}, auth: ${JSON.stringify(op.auth)}, requiresPow: ${Boolean(op.pow)}, rateLimitPolicy: ${JSON.stringify(op.rateLimit ?? null)} },`)
  }
  lines.push('} as const')
  lines.push('')
  lines.push('export type FsusBinaryOperationId = keyof typeof fsusBinaryRoutes')
  lines.push('export type FsusBinaryRouteDescriptor = typeof fsusBinaryRouteDescriptors[FsusBinaryOperationId]')
  lines.push('export type FsusBinaryRouteSecurity = typeof fsusBinaryRouteSecurity[FsusBinaryOperationId]')
  lines.push('')
  lines.push('export function buildFsusBinaryRoute(')
  lines.push('  operationId: FsusBinaryOperationId,')
  lines.push('  params: Record<string, string | number | bigint> = {},')
  lines.push('  query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>')
  lines.push('): string {')
  lines.push('  const descriptor = fsusBinaryRouteDescriptors[operationId]')
  lines.push('  let path = descriptor.path.replace(/\\{([^}:]+)(?::[^}]+)?\\}/g, (_token, key: string) => {')
  lines.push('    const value = params[key]')
  lines.push('    if (value === undefined || value === null) {')
  lines.push('      throw new Error(`fsus_binary_route_param_missing:${String(operationId)}:${key}`)')
  lines.push('    }')
  lines.push('    return encodeURIComponent(String(value))')
  lines.push('  })')
  lines.push('  const queryString = stringifyFsusBinaryRouteQuery(query)')
  lines.push('  return queryString ? `${path}?${queryString}` : path')
  lines.push('}')
  lines.push('')
  lines.push('function stringifyFsusBinaryRouteQuery(query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>): string {')
  lines.push('  if (!query) return ""')
  lines.push('  if (query instanceof URLSearchParams) return query.toString()')
  lines.push('  const search = new URLSearchParams()')
  lines.push('  for (const [key, value] of Object.entries(query)) {')
  lines.push('    if (value !== undefined && value !== null) search.set(key, String(value))')
  lines.push('  }')
  lines.push('  return search.toString()')
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function resolveCredentialPolicy(op) {
  return op.auth === 'anonymous'
    && op.method === 'GET'
    && op.rateLimit === 'public_read'
    && op.cache === 'public-read'
    ? 'omit'
    : 'include'
}
