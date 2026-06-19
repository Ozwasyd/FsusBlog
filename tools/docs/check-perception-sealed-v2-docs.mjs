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
  '### perception-sealed@v2 威胁模型、协议与上线',
  'sealed perception challenge，不是普通图片验证码',
  'issue payload 禁止包含',
  'Redis `INCR` 做 attempt gate',
  'Redis `SETNX` 做 consume-once',
  'Security:PerceptionSealedToken:CurrentKeyVersion',
  'Security:PerceptionSealedToken:Keys:{version}',
  'Security:PerceptionV2:MicroInteraction:Mode',
  'text-task enforce',
  'localization enforce',
  'micro-interaction optional',
  'HumanReadProof',
  'adminPasskeyStepUpV1',
  '性能预算',
  '安全预算'
]) {
  requireToken('docs/security.md', security, token)
}

for (const token of [
  'payload 是 sealed perception challenge 契约',
  'issue payload 禁止出现',
  'verify 路径必须先解封 AEAD',
  'Security:PerceptionV2:SigningKey',
  'Security:PerceptionV2:TextTask:FixedText',
  'Security:PerceptionV2:Localization:FixedX',
  'Security:PerceptionV2:Localization:FixedY',
  'Security:PerceptionV2:MicroInteraction:FixedSteps',
  'RiskControlPolicyUpdateRequest(globalMode?, captchaV1Enabled?, poSpaceV1Enabled?, publicReadChallengeEnabled?, commentRiskControlEnabled?, authRiskControlEnabled?, strictRiskMultiplierPercent?, reason?)',
  'perception-sealed@v2 的验证矩阵',
  'Redis `INCR` attempt gate 失败',
  'PostgreSQL audit / aggregation 写入失败',
  'HumanReadProof proof 用于 `comment.*`、`auth.*`、`admin.*`',
  'adminPasskeyStepUpV1` proof 尝试替代 `X-Fsus-Mfa-Proof`',
  '上线顺序固定为 `observe -> text-task enforce -> localization enforce -> micro-interaction optional -> strict/lockdown`'
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
