#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseYamlDocument } from '../yaml/parse-document.mjs'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const configFile = process.env.FSUSBLOG_ZAP_CONFIG || path.join(root, 'tools/security/zap-baseline.conf')
const policyFile = process.env.FSUSBLOG_ZAP_WARN_POLICY || path.join(root, 'security/policies/zap-warn-policy.yml')
const errors = []

function fail(message) {
  errors.push(`[zap-policy] ${message}`)
}

if (!fs.existsSync(configFile)) fail(`missing ZAP config: ${configFile}`)
if (!fs.existsSync(policyFile)) fail(`missing ZAP WARN policy: ${policyFile}`)

const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
const policyText = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : ''
let policyDocument = {}
try {
  policyDocument = parseYamlDocument(policyText, { source: 'security/policies/zap-warn-policy.yml' })
} catch (error) {
  fail(`invalid WARN policy YAML: ${error.message}`)
}
const policies = new Map(
  (Array.isArray(policyDocument.rules) ? policyDocument.rules : []).map((rule) => [
    String(rule?.id ?? ''),
    { id: String(rule?.id ?? ''), fields: new Map(Object.entries(rule ?? {}).map(([key, value]) => [key, String(value)])) }
  ])
)
const metadata = new Map(
  Object.entries(policyDocument)
    .filter(([, value]) => value == null || typeof value !== 'object')
    .map(([key, value]) => [key, String(value)])
)
const warnIds = []
const failIds = new Set()

for (const [field, expected] of [
  ['schema', 'fsusblog.zap-warn-policy.v2'],
  ['policyId', 'zap-warn-exceptions'],
  ['version', '2.0.0'],
  ['owner', 'ServerContractAgent'],
  ['checker', 'tools/security/check-zap-warn-policy.mjs'],
  ['documentation', 'docs/security.md'],
  ['failClosed', 'true']
]) {
  if (metadata.get(field) !== expected) fail(`policy metadata ${field} must be ${expected}`)
}

for (const line of configText.split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith('#')) continue
  const parts = line.split(/\t+/)
  if (parts.length < 2) continue
  const id = parts[0].trim()
  const action = parts[1].trim()
  if (action === 'WARN') warnIds.push(id)
  if (action === 'FAIL') failIds.add(id)
}

for (const id of warnIds) {
  const policy = policies.get(id)
  if (!policy) {
    fail(`WARN rule ${id} is missing owner/risk policy`)
    continue
  }
  for (const field of ['kind', 'severity', 'rationale', 'pathScope', 'owner', 'status', 'riskAcceptance', 'fixBy', 'failWhen']) {
    if (!policy.fields.get(field)) {
      fail(`WARN rule ${id} policy is missing ${field}`)
    }
  }
  if (policy.fields.get('action') !== 'WARN') {
    fail(`WARN rule ${id} policy action must be WARN`)
  }
  if (policy.fields.get('kind') !== 'passive-warning-exception'
    || policy.fields.get('severity') !== 'warning'
    || !policy.fields.get('pathScope')?.includes('local-runtime-zap-baseline')) {
    fail(`WARN rule ${id} must declare its warning kind, severity and local-runtime path scope`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy.fields.get('fixBy') ?? '')) {
    fail(`WARN rule ${id} policy fixBy must be YYYY-MM-DD`)
  }
}

for (const id of policies.keys()) {
  if (!warnIds.includes(id)) {
    fail(`policy contains ${id}, but tools/security/zap-baseline.conf does not keep it at WARN`)
  }
}

for (const criticalId of ['10003', '10017', '10028', '10032', '10036', '10105']) {
  if (!failIds.has(criticalId)) {
    fail(`critical ZAP rule ${criticalId} must remain FAIL`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}

console.log(`[zap-policy] ok (${warnIds.length} WARN policies checked)`)
