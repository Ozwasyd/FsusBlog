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
  'perception-sealed@v2 的服务端真相',
  '只承载 `perceptionLocalizationV2` 与 `perceptionMicroInteractionV2`',
  '公开 issue payload 不得包含',
  'Redis attempt/consume-once',
  'Security:PerceptionSealedToken:CurrentKeyVersion',
  'Security:PerceptionSealedToken:Keys:{version}',
  'LocalizationV2',
  'MicroInteractionV2',
  'HumanReadProof',
  'adminPasskeyStepUpV1',
  '无需重启的回退'
]) {
  requireToken('docs/security.md', security, token)
}

for (const token of [
  'perceptionLocalizationV2` 与 `perceptionMicroInteractionV2` provider',
  'issue payload 禁止出现',
  'verify 路径必须先解封 AEAD',
  'Security:PerceptionSealedToken:CurrentKeyVersion',
  'Security:PerceptionV2:MicroInteraction:Mode',
  'RiskControlPolicyUpdateRequest',
  'perception-sealed@v2 的验证矩阵',
  'Redis `INCR` attempt gate 失败',
  'PostgreSQL audit / aggregation 写入失败',
  'HumanReadProof proof 用于 `comment.*`、`auth.*`、`admin.*`',
  'adminPasskeyStepUpV1` proof 尝试替代 `X-Fsus-Mfa-Proof`',
  '上线顺序固定为 `observe -> V3/localization enforce -> micro-interaction optional -> strict/lockdown`'
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
