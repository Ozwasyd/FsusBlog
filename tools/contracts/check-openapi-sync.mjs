#!/usr/bin/env node
import { frameNames, loadOpenApi, loadProtocol, operationsFromOpenApi } from './lib/openapi-contracts.mjs'

const protocol = loadProtocol()
const frames = frameNames(protocol)
const operations = operationsFromOpenApi(loadOpenApi())
const errors = []

for (const op of operations) {
  if (op.operation['x-fsus-protocol'] !== 'AEDS') errors.push(`${op.key} missing x-fsus-protocol=AEDS`)
  if (Number(op.operation['x-fsus-aeds-version']) !== Number(protocol.header?.version ?? 2)) errors.push(`${op.key} AEDS version drift`)
  if (!op.responseFrame) errors.push(`${op.key} missing x-fsus-response-frame`)
  for (const [name, frame] of [['request', op.requestFrame], ['response', op.responseFrame], ['error', op.errorFrame]]) {
    if (!frame || frame === 'server-only/no-response-body') continue
    if (!frames.has(frame)) errors.push(`${op.key} ${name} frame ${frame} is not in aeds-protocol.json`)
    if (/^\d+$/.test(String(frame))) errors.push(`${op.key} ${name} frame must use name, not number`)
  }
  if (op.errorFrame !== 'ApiError') errors.push(`${op.key} x-fsus-error-frame must be ApiError`)
  if (!['anonymous', 'optional', 'user', 'admin'].includes(op.auth)) errors.push(`${op.key} invalid auth classification ${op.auth}`)
  if (typeof op.pow !== 'boolean') errors.push(`${op.key} x-fsus-pow must be boolean`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[openapi-sync] ${error}`)
  process.exit(1)
}

console.log(`[openapi-sync] ok operations=${operations.length}`)
