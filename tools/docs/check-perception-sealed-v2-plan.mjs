#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`missing ${path}`)
    return ''
  }
}

function parseJson(path, source) {
  try {
    return JSON.parse(source)
  } catch (error) {
    errors.push(`${path} invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function includes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

const planPath = 'docs/planning/perception-sealed-v2-production-plan.md'
const mapPath = 'docs/planning/perception-sealed-v2-issue-map.json'
const plan = read(planPath)
const issueMap = parseJson(mapPath, read(mapPath))

const requiredIssues = Array.from({ length: 21 }, (_, index) => index + 505)
const requiredCoverage = [
  'v2_aeds_contract',
  'aead_sealed_token',
  'non_semantic_render_recipe',
  'stateless_issue_path',
  'o1_verify_path',
  'redis_consume_once_attempt_gate',
  'character_challenge',
  'localization_challenge',
  'micro_interaction_challenge',
  'risk_control_policy_matrix',
  'critical_risk_routing',
  'frontend_worker_renderer',
  'frontend_ui_components',
  'label_oracle_hardening',
  'async_audit_hot_path_isolation',
  'observability_readiness',
  'red_team_benchmark',
  'admin_controls_metrics',
  'full_test_matrix',
  'threat_model_protocol_rollout_docs',
  'orchestrator_binary_api_wiring'
]

if (issueMap.planIssue?.number !== 504) {
  errors.push(`${mapPath} planIssue.number must be 504`)
}

if (issueMap.wireKind !== 'fsu.challenge/perception-sealed@v2') {
  errors.push(`${mapPath} wireKind must be fsu.challenge/perception-sealed@v2`)
}

const units = Array.isArray(issueMap.units) ? issueMap.units : []
const unitIssues = new Set(units.map((unit) => unit.issue))
for (const issue of requiredIssues) {
  if (!unitIssues.has(issue)) {
    errors.push(`${mapPath} missing unit for #${issue}`)
  }
  includes(planPath, plan, `#${issue}`)
}

if (unitIssues.size !== units.length) {
  errors.push(`${mapPath} contains duplicate unit issue numbers`)
}

for (const [index, unit] of units.entries()) {
  if (unit.order !== index + 1) {
    errors.push(`${mapPath} unit #${unit.issue ?? 'unknown'} has non-sequential order`)
  }
  for (const field of ['title', 'surface', 'acceptanceBoundary']) {
    if (typeof unit[field] !== 'string' || unit[field].trim().length === 0) {
      errors.push(`${mapPath} unit #${unit.issue ?? 'unknown'} missing ${field}`)
    }
  }
}

const coverage = Array.isArray(issueMap.coverage) ? issueMap.coverage : []
const coverageById = new Map(coverage.map((item) => [item.id, item.issue]))
for (const id of requiredCoverage) {
  if (!coverageById.has(id)) {
    errors.push(`${mapPath} missing coverage ${id}`)
  }
}

if (coverageById.size !== coverage.length) {
  errors.push(`${mapPath} contains duplicate coverage ids`)
}

const constraintTokens = [
  'server_must_not_generate_png',
  'server_must_not_rasterize',
  'server_must_not_recompute_image',
  'issue_hot_path_must_not_write_postgresql',
  'issue_hot_path_must_not_write_redis',
  'verify_hot_path_only_unseals_binds_compares_consumes_and_mints',
  'postgresql_is_async_audit_and_aggregation_only',
  'low_risk_avoids_challenge',
  'medium_risk_uses_character_challenge',
  'high_risk_uses_localization_plus_pow',
  'critical_risk_early_rejects_limits_queues_or_pospace',
  'no_public_json_fallback',
  'human_read_proof_is_not_write_authorization',
  'passkey_step_up_remains_separate'
]

const constraints = new Set(Array.isArray(issueMap.productionConstraints) ? issueMap.productionConstraints : [])
for (const token of constraintTokens) {
  if (!constraints.has(token)) {
    errors.push(`${mapPath} missing production constraint ${token}`)
  }
}

for (const token of [
  '服务端不生成 PNG',
  'challenge issue 热路径不写 PostgreSQL',
  'challenge issue 热路径不写 Redis',
  'verify 热路径只做 AEAD 解封',
  '低风险尽量不出验证码',
  '中风险使用 Character challenge',
  '高风险使用 Localization challenge + PoW',
  '极高风险早拒绝',
  '不替代 Passkey / Admin Passkey step-up',
  '不把 HumanReadProof 当作写操作授权',
  '不新增公开 JSON fallback',
  'node tools/docs/check-perception-sealed-v2-plan.mjs'
]) {
  includes(planPath, plan, token)
}

for (const [coverageId, issue] of coverageById.entries()) {
  if (!unitIssues.has(issue)) {
    errors.push(`${mapPath} coverage ${coverageId} references missing issue #${issue}`)
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[perception-v2-plan] ${error}`)
  }
  process.exit(1)
}

console.log(`[perception-v2-plan] ok units=${units.length} coverage=${coverage.length}`)
