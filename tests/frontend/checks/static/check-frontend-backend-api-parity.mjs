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
  if (relativePath === 'src/frontend/src/api/authoring.ts') {
    for (const token of ['/api/author', 'JsonApiResponse', 'response.json', 'application/json', 'JSON.stringify']) {
      assert(!source.includes(token), `${relativePath} contains retired JSON authoring compatibility: ${token}`)
    }
  }
}

const commentPolicyContract = readFileSync(resolve(root, 'src/frontend/src/contracts/commentPolicy.ts'), 'utf8')
const commentPolicyPod = readFileSync(resolve(root, 'src/shared/Contracts/Models/CommentPods.cs'), 'utf8')
const zkProdOptions = readFileSync(resolve(root, 'src/backend/Services/Security/ZkProdOptions.cs'), 'utf8')
const articleDetail = readFileSync(resolve(root, 'src/frontend/src/composables/useArticleDetailView.ts'), 'utf8')
const frontendWireFieldsBody = commentPolicyContract.match(
  /export const commentPolicyWireFields = \[(?<body>[\s\S]*?)\] as const/u
)?.groups?.body ?? ''
const frontendWireFields = [...frontendWireFieldsBody.matchAll(/'(?<name>[A-Za-z0-9_]+)'/gu)]
  .map((match) => match.groups?.name ?? '')
const podBody = commentPolicyPod.match(
  /public readonly struct CommentPolicySnapshotPod\s*\{(?<body>[\s\S]*?)\n\}/u
)?.groups?.body ?? ''
assert(podBody, 'CommentPolicySnapshotPod body is missing')
const backendWireFields = [...podBody.matchAll(/public readonly \w+ (?<name>\w+);/gu)]
  .map((match) => match.groups?.name ?? '')
  .map((name) => `${name[0].toLowerCase()}${name.slice(1)}`)
assert(
  JSON.stringify(frontendWireFields) === JSON.stringify(backendWireFields),
  `comment policy wire fields drifted: frontend=${frontendWireFields.join(',')} backend=${backendWireFields.join(',')}`
)

const frontendReasonsBody = commentPolicyContract.match(
  /export const zkProdServerUnavailableReasons = \[(?<body>[\s\S]*?)\] as const/u
)?.groups?.body ?? ''
const frontendReasons = [...frontendReasonsBody.matchAll(/'(?<reason>[a-z0-9_]*)'/gu)]
  .map((match) => match.groups?.reason ?? '')
const backendReasonMethod = zkProdOptions.slice(zkProdOptions.indexOf('private static string ResolveUnavailableReason'))
const backendReasons = ['', ...backendReasonMethod.matchAll(/return "(?<reason>[a-z0-9_]+)";/gu)]
  .map((entry) => typeof entry === 'string' ? entry : (entry.groups?.reason ?? ''))
assert(
  JSON.stringify(frontendReasons) === JSON.stringify(backendReasons),
  `comment policy unavailable reasons drifted: frontend=${frontendReasons.join(',')} backend=${backendReasons.join(',')}`
)
for (const pattern of [/ZkProdCommentPolicySnapshot/u, /zkProd\w+\s*===\s*undefined/u, /as\s+ZkProd/u]) {
  assert(!pattern.test(articleDetail), `useArticleDetailView.ts contains a fail-open comment policy escape: ${pattern}`)
}

const frontendMessagePolicy = readFileSync(resolve(root, 'src/frontend/src/contracts/messageContentPolicy.ts'), 'utf8')
const backendMessagePolicy = readFileSync(resolve(root, 'src/shared/Contracts/Validation/MessageContentPolicy.cs'), 'utf8')
const messageLimits = [
  ['subjectMaxScalars', 'SubjectMaxScalars'],
  ['subjectMaxGraphemes', 'SubjectMaxGraphemes'],
  ['subjectMaxUtf8Bytes', 'SubjectMaxUtf8Bytes'],
  ['bodyMaxScalars', 'BodyMaxScalars'],
  ['bodyMaxGraphemes', 'BodyMaxGraphemes'],
  ['bodyMaxUtf8Bytes', 'BodyMaxUtf8Bytes'],
  ['previewMaxGraphemes', 'PreviewMaxGraphemes']
]
for (const [frontendName, backendName] of messageLimits) {
  const frontendValue = frontendMessagePolicy.match(new RegExp(`${frontendName}:\\s*(?<value>\\d+)`, 'u'))?.groups?.value
  assert(frontendValue, `frontend message policy is missing ${frontendName}`)
  assert(
    backendMessagePolicy.includes(`const int ${backendName} = ${frontendValue};`),
    `message policy ${frontendName}/${backendName} is not numerically aligned`
  )
}
assert(frontendMessagePolicy.includes('maxRequestFrameBytes: 20 * 1024'), 'frontend message frame limit must remain 20 KiB')
assert(backendMessagePolicy.includes('MaxRequestFrameBytes = 20 * 1024'), 'backend message frame limit must remain 20 KiB')

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
