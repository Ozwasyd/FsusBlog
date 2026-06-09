#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const openapiFile = path.join(root, 'src/shared/Contracts/Validation/fsusblog.openapi.json')
const protocolFile = path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json')
const overviewFile = path.join(root, 'docs/api.md')
const quickReferenceFile = path.join(root, 'docs/api/quick-reference.md')
const outFile = path.join(root, '.tmp/docs/generated-api-docs.json')

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const openapi = readJson(openapiFile)
const protocol = readJson(protocolFile)
const operations = Object.entries(openapi.paths ?? {}).flatMap(([route, methods]) =>
  Object.keys(methods ?? {}).map((method) => ({ method: method.toUpperCase(), route }))
)
const binaryOperations = operations.filter((operation) => operation.route.startsWith('/api/binary/'))
const notificationOperations = operations.filter((operation) => operation.route.startsWith('/api/notifications/'))

const summary = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  sources: {
    openapi: relative(openapiFile),
    protocol: relative(protocolFile)
  },
  operationCount: operations.length,
  binaryOperationCount: binaryOperations.length,
  notificationOperationCount: notificationOperations.length,
  aedsHeader: protocol.header,
  outputs: {
    overview: relative(overviewFile),
    quickReference: relative(quickReferenceFile)
  },
  errors: []
}

const docs = `${fs.readFileSync(overviewFile, 'utf8')}\n${fs.readFileSync(quickReferenceFile, 'utf8')}`
if (!docs.includes('Current Binary API')) summary.errors.push('docs/api.md must expose Current Binary API')
if (!docs.includes(protocol.header.magic)) summary.errors.push(`API docs must include AEDS magic ${protocol.header.magic}`)
if (!docs.includes('HttpOnly Cookie session / AEDS auth frame')) summary.errors.push('API docs must describe current auth credential semantics')
if (!docs.includes('WebSocket binary notification stream')) summary.errors.push('API docs must describe WebSocket binary notification stream')
if (binaryOperations.length === 0) summary.errors.push('OpenAPI snapshot must contain /api/binary operations')

summary.status = summary.errors.length === 0 ? 'ok' : 'failed'
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)

if (process.argv.includes('--check') && summary.status !== 'ok') {
  for (const error of summary.errors) console.error(`[api-docs] ${error}`)
  process.exit(1)
}

console.log(`[api-docs] ${summary.status} operations=${operations.length} binary=${binaryOperations.length}`)
