#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const errors = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch (error) {
    errors.push(`${path} missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function requireToken(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

const security = read('docs/security.md')
const contracts = read('docs/api/contracts.md')

for (const token of [
  'perception-sealed@v2',
  'retained only for `perceptionLocalizationV2` and `perceptionMicroInteractionV2`',
  'Public issue data excludes',
  'Redis attempt/consume-once',
  'Security:PerceptionSealedToken:CurrentKeyVersion',
  'Security:PerceptionSealedToken:Keys:{version}',
  'LocalizationV2',
  'MicroInteractionV2',
  'HumanReadProof',
  'adminPasskeyStepUpV1',
  'No-restart fallback'
]) {
  requireToken('docs/security.md', security, token)
}

for (const token of [
  'perceptionLocalizationV2` and `perceptionMicroInteractionV2` providers',
  'issue payload prohibits',
  'verify path must first decrypt the AEAD token',
  'Security:PerceptionSealedToken:CurrentKeyVersion',
  'Security:PerceptionV2:MicroInteraction:Mode',
  'RiskControlPolicyUpdateRequest',
  'Verification matrix for perception-sealed@v2',
  'Redis `INCR` attempt gate failed',
  'PostgreSQL audit / aggregation write failure',
  'HumanReadProof proof is used for `comment.*`, `auth.*`, `admin.*`',
  'adminPasskeyStepUpV1` proof attempts to replace `X-Fsus-Mfa-Proof`',
  'The rollout order is fixed to `observe -> V3/localization enforce -> micro-interaction optional -> strict/lockdown`'
]) {
  requireToken('docs/api/contracts.md', contracts, token)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[perception-v2-docs] ${error}`)
  }
  process.exit(1)
}

console.log('[perception-v2-docs] ok')
