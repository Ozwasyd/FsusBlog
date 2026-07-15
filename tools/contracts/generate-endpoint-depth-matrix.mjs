#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { loadOpenApi, operationsFromOpenApi, root } from './lib/openapi-contracts.mjs'

const outFile = path.join(root, '.tmp/contracts/endpoint-depth-matrix.json')
const check = process.argv.includes('--check')
const operations = operationsFromOpenApi(loadOpenApi())
const expectedUnavailablePublicChecks = new Set([
  'binary_get_anonymous_credential_root',
  'binary_get_anonymous_credential_circuit',
  'binary_get_anonymous_credential_blind_issuer',
  'binary_get_anonymous_credential_revocation_full',
  'binary_get_anonymous_credential_revocation_delta'
])

function expectedSuccessStatuses(op, role) {
  const isAllowedRole = role === op.auth || op.auth === 'anonymous' || (op.auth === 'optional' && role === 'anonymous')
  if (!isAllowedRole) return [401, 403]
  const successStatus = op.operation['x-fsus-success-status'] ?? 200
  return expectedUnavailablePublicChecks.has(op.operationId) ? [successStatus, 503] : [successStatus]
}

const cases = []
for (const op of operations) {
  const roles = op.auth === 'admin' ? ['anonymous', 'user', 'admin', 'banned', 'deleted', 'mfa-partial']
    : op.auth === 'user' ? ['anonymous', 'user', 'banned', 'deleted', 'mfa-partial']
      : ['anonymous']
  for (const role of roles) {
    cases.push({
      id: `${op.operationId}:${role}:success-or-denied`,
      operationId: op.operationId,
      method: op.method,
      path: op.fullPath,
      role,
      protocol: 'correct-aeds',
      http: 'correct',
      security: op.pow ? 'pow-required' : 'none',
      expectedFrame: role === op.auth || op.auth === 'anonymous' || (op.auth === 'optional' && role === 'anonymous') ? op.responseFrame : 'ApiError',
      expectedStatuses: expectedSuccessStatuses(op, role)
    })
  }
  for (const protocolCase of ['malformed-header', 'wrong-frame', 'truncated', 'oversized']) {
    cases.push({
      id: `${op.operationId}:anonymous:${protocolCase}`,
      operationId: op.operationId,
      method: op.method,
      path: op.fullPath,
      role: 'anonymous',
      protocol: protocolCase,
      http: 'correct',
      security: 'none',
      expectedFrame: 'ApiError',
      expectedStatuses: [400, 413, 415]
    })
  }
  if (op.pow) {
    for (const securityCase of ['missing-pow', 'tampered-pow', 'replayed-pow', 'expired-pow']) {
      cases.push({
        id: `${op.operationId}:anonymous:${securityCase}`,
        operationId: op.operationId,
        method: op.method,
        path: op.fullPath,
        role: 'anonymous',
        protocol: 'correct-aeds',
        http: 'correct',
        security: securityCase,
        expectedFrame: 'ApiError',
        expectedStatuses: [400, 401, 403, 429]
      })
    }
  }
}

const matrix = {
  version: 'fsusblog-endpoint-depth-matrix-v1',
  generatedAt: new Date().toISOString(),
  source: 'src/shared/Contracts/Validation/fsusblog.openapi.json',
  operationCount: operations.length,
  caseCount: cases.length,
  cases
}

const text = `${JSON.stringify(matrix, null, 2)}\n`
if (check) {
  if (!fs.existsSync(outFile)) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, text)
  }
  const current = fs.readFileSync(outFile, 'utf8')
  if (current !== text) {
    console.error('[endpoint-depth] generated matrix drifted; rerun without --check')
    process.exit(1)
  }
  console.log(`[endpoint-depth] ok cases=${cases.length}`)
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, text)
  console.log(`[endpoint-depth] wrote ${outFile}`)
}
