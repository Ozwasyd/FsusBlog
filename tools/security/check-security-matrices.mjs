#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const checks = [
  {
    file: 'security/asvs-v5.0.0-matrix.yml',
    listKey: 'requirements',
    idPattern: /^ASVS-\d+\.\d+\.\d+$/,
    label: 'ASVS'
  },
  {
    file: 'security/wstg-v4.2-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^WSTG-v42-[A-Z]+-\d+$/,
    label: 'WSTG'
  },
  {
    file: 'security/webauthn-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^WEBAUTHN-[A-Z-]+$/,
    label: 'WebAuthn'
  },
  {
    file: 'security/risk-control-test-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^RISKCONTROL-[A-Z0-9-]+$/,
    label: 'RiskControl'
  },
  {
    file: 'security/privacy-zk-comment-matrix.yml',
    listKey: 'scenarios',
    idPattern: /^PRIVACY-ZK-[A-Z0-9-]+$/,
    label: 'PrivacyZK'
  }
]

const errors = []

function fail(message) {
  errors.push(`[security-matrix] ${message}`)
}

function repoPathExists(value) {
  if (value.startsWith('.tmp/')) return true
  if (value.startsWith('src/frontend/test-results/')) return true
  return fs.existsSync(path.join(root, value))
}

function parseEntries(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let current = null
  let currentSection = null

  for (const line of lines) {
    const idMatch = line.match(/^\s*-\s+id:\s+(.+?)\s*$/)
    if (idMatch) {
      current = {
        id: idMatch[1].trim(),
        fields: new Set(['id']),
        paths: []
      }
      entries.push(current)
      currentSection = null
      continue
    }

    if (!current) continue

    const fieldMatch = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):/)
    if (fieldMatch) {
      current.fields.add(fieldMatch[1])
      currentSection = fieldMatch[1]
      continue
    }

    const pathMatch = line.match(/^\s{6}-\s+(.+?)\s*$/)
    if (pathMatch && ['code', 'tests', 'evidence'].includes(currentSection)) {
      current.paths.push({
        section: currentSection,
        value: pathMatch[1].trim()
      })
    }
  }

  return entries
}

function verifyRiskControlMatrix(text) {
  const requiredScenarioIds = [
    'RISKCONTROL-DECISION-MODES',
    'RISKCONTROL-PROVIDER-SURFACES',
    'RISKCONTROL-PROOF-BINDING',
    'RISKCONTROL-INTEGRATION-SURFACES',
    'RISKCONTROL-E2E-FAILURE-MODES',
    'RISKCONTROL-PERFORMANCE-BUDGETS',
    'RISKCONTROL-FAULT-MODES'
  ]
  const requiredTokens = [
    'allow',
    'challenge',
    'step-up',
    'queue',
    'throttle',
    'block',
    'sha256PowV1',
    'captchaV1',
    'argon2idPoSpaceV1',
    'humanReadProofV1',
    'passkeyStepUpV1',
    'adminPasskeyStepUpV1',
    'replay',
    'expired',
    'action-mismatch',
    'route-mismatch',
    'device-mismatch',
    'auth',
    'comment',
    'public-read',
    'notification',
    'admin-policy',
    'desktop',
    'mobile',
    'wasm-failure',
    'canvas-fallback',
    'worker-failure',
    'slow-device',
    'redis-unavailable',
    'postgres-slow-write',
    'provider-missing',
    'policy-load-failure'
  ]
  const budgetLimits = {
    decisionP99Ms: 10,
    powVerifyP99Ms: 100,
    captchaVerifyP99Ms: 100,
    proofConsumeP99Ms: 25
  }

  for (const id of requiredScenarioIds) {
    if (!text.includes(`id: ${id}`)) {
      fail(`risk-control matrix missing scenario ${id}`)
    }
  }

  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      fail(`risk-control matrix missing required coverage token ${token}`)
    }
  }

  for (const [budgetName, maxValue] of Object.entries(budgetLimits)) {
    const match = text.match(new RegExp(`\\b${budgetName}:\\s+(\\d+)\\b`))
    if (!match) {
      fail(`risk-control matrix missing performance budget ${budgetName}`)
      continue
    }

    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0 || value > maxValue) {
      fail(`risk-control matrix budget ${budgetName}=${value} exceeds fail-closed max ${maxValue}`)
    }
  }
}

function verifyPrivacyZkCommentMatrix(text) {
  const requiredScenarioIds = [
    'PRIVACY-ZK-TRANSPORT',
    'PRIVACY-ZK-FAIL-CLOSED',
    'PRIVACY-ZK-TICKET-NULLIFIER',
    'PRIVACY-ZK-MODERATION-LOGGING',
    'PRIVACY-ZK-FRONTEND-RUNTIME',
    'PRIVACY-ZK-CONCURRENCY'
  ]
  const requiredPrivacyCases = [
    'no-cookie',
    'no-authorization',
    'cookie-rejected',
    'authorization-rejected',
    'comment.user_id:null',
    'zk-failure-no-anonymous-downgrade',
    'zk-failure-no-public-publish',
    'verifier-unavailable-fail-closed',
    'root-expired-fail-closed',
    'proof-invalid-fail-closed',
    'ticket-consume-once',
    'ticket-expired-rejected',
    'same-article-scope-stable-nullifier',
    'different-article-scope-different-nullifier',
    'blocked-nullifier-rejected',
    'scope-limit-exceeded-rejected',
    'provider-no-userId-username-proof-raw-nullifier',
    'log-redaction-proof-witness-credential-secret-raw-nullifier-cookie-authorization',
    'admin-no-account-reversal',
    'public-signature-explicit-opt-in'
  ]
  const requiredConcurrencyCases = [
    'concurrent-same-nullifier-scope-policy-limit',
    'concurrent-ticket-consume-once',
    'root-snapshot-cached-high-frequency',
    'verifier-bounded-concurrency',
    'anonymous-ticket-cheap-reject',
    'comment-submit-invalidation-nonblocking'
  ]
  const requiredCommands = [
    'check:privacy-zk-contract',
    'check:privacy-zk-frontend',
    'check:privacy-zk-backend',
    'check:privacy-zk-concurrency'
  ]

  for (const id of requiredScenarioIds) {
    if (!text.includes(`id: ${id}`)) {
      fail(`privacy-zk matrix missing scenario ${id}`)
    }
  }

  for (const token of requiredPrivacyCases) {
    if (!text.includes(token)) {
      fail(`privacy-zk matrix missing required case ${token}`)
    }
  }

  for (const token of requiredConcurrencyCases) {
    if (!text.includes(token)) {
      fail(`privacy-zk matrix missing concurrency case ${token}`)
    }
  }

  for (const command of requiredCommands) {
    if (!text.includes(command)) {
      fail(`privacy-zk matrix missing local command ${command}`)
    }
  }
}

for (const check of checks) {
  const absolute = path.join(root, check.file)
  if (!fs.existsSync(absolute)) {
    fail(`missing ${check.file}`)
    continue
  }

  const text = fs.readFileSync(absolute, 'utf8')
  if (!text.includes(`${check.listKey}:`)) {
    fail(`${check.file} is missing ${check.listKey}`)
  }

  const entries = parseEntries(text)
  if (entries.length === 0) {
    fail(`${check.file} has no entries`)
    continue
  }

  for (const entry of entries) {
    if (!check.idPattern.test(entry.id)) {
      fail(`${check.file} has invalid ${check.label} id: ${entry.id}`)
    }

    for (const field of ['owner', 'status', 'code', 'tests', 'evidence']) {
      if (!entry.fields.has(field)) {
        fail(`${check.file} ${entry.id} is missing ${field}`)
      }
    }

    for (const section of ['code', 'tests', 'evidence']) {
      if (!entry.paths.some((item) => item.section === section)) {
        fail(`${check.file} ${entry.id} has empty ${section}`)
      }
    }

    for (const item of entry.paths) {
      if (!repoPathExists(item.value)) {
        fail(`${check.file} ${entry.id} references missing ${item.section} path: ${item.value}`)
      }
    }
  }

  if (check.label === 'RiskControl') {
    verifyRiskControlMatrix(text)
  }
  if (check.label === 'PrivacyZK') {
    verifyPrivacyZkCommentMatrix(text)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exit(1)
}

console.log('[security-matrix] ok')
