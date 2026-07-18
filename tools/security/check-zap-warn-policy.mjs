#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const configFile = process.env.FSUSBLOG_ZAP_CONFIG || path.join(root, 'tools/security/zap-baseline.conf')
const policyFile = process.env.FSUSBLOG_ZAP_WARN_POLICY || path.join(root, 'security/policies/zap-warn-policy.yml')
const errors = []

function fail(message) {
  errors.push(`[zap-policy] ${message}`)
}

function parseWarnPolicy(text) {
  const entries = new Map()
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const idMatch = line.match(/^\s*-\s+id:\s+"?([^"\s]+)"?\s*$/)
    if (idMatch) {
      current = { id: idMatch[1], fields: new Map() }
      entries.set(current.id, current)
      continue
    }
    if (!current) continue
    const fieldMatch = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch) {
      current.fields.set(fieldMatch[1], fieldMatch[2].replace(/^"|"$/g, ''))
    }
  }
  return entries
}

function parseMetadata(text) {
  const metadata = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (match) metadata.set(match[1], match[2].replace(/^"|"$/g, ''))
  }
  return metadata
}

if (!fs.existsSync(configFile)) fail(`missing ZAP config: ${configFile}`)
if (!fs.existsSync(policyFile)) fail(`missing ZAP WARN policy: ${policyFile}`)

const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
const policyText = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : ''
const policies = parseWarnPolicy(policyText)
const metadata = parseMetadata(policyText)
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
