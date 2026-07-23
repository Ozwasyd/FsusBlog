import { createHash } from 'node:crypto'
import fs from 'node:fs'

export const APP_CONFIG_CATALOG_SCHEMA = 'fsusblog.app-config-knob-catalog.v1'
export const APP_CONFIG_EVIDENCE_SCHEMA = 'fsusblog.app-config-local-experiment.v1'

const LIFECYCLES = new Set(['startup-only', 'restart-required', 'reloadable', 'synthetic-only'])

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

export function digestJson(value) {
  return digest(stable(value))
}

function keyMap(catalog) {
  return new Map((catalog.knobs ?? []).map((knob) => [knob.configKey, knob]))
}

function isAligned(value, range) {
  const quotient = (value - range.minimum) / range.step
  return Math.abs(quotient - Math.round(quotient)) < 1e-9
}

function validateKnobValue(knob, value) {
  if (!Number.isFinite(value)) return `${knob.configKey} must be finite`
  if (knob.type === 'integer' && !Number.isInteger(value)) return `${knob.configKey} must be an integer`
  if (value < knob.range.minimum || value > knob.range.maximum) {
    return `${knob.configKey} must be within [${knob.range.minimum}, ${knob.range.maximum}]`
  }
  if (!isAligned(value, knob.range)) return `${knob.configKey} must align to step ${knob.range.step}`
  return null
}

function evaluateConstraint(constraint, config) {
  const left = config[constraint.left]
  const right = config[constraint.right]
  if (constraint.kind === 'lte') return left <= right
  if (constraint.kind === 'scaled-lte') return left <= right * constraint.scale
  if (constraint.kind === 'scaled-gte') return left >= right * constraint.scale
  if (constraint.kind === 'sum-lte') return constraint.keys.reduce((sum, key) => sum + config[key], 0) <= constraint.value
  return false
}

export function validateCatalog(catalog) {
  const errors = []
  if (catalog?.schema !== APP_CONFIG_CATALOG_SCHEMA) errors.push(`schema must equal ${APP_CONFIG_CATALOG_SCHEMA}`)
  if (!Number.isInteger(catalog?.version) || catalog.version < 1) errors.push('version must be a positive integer')
  if (catalog?.productionMutation !== false) errors.push('productionMutation must be false')
  if (!Array.isArray(catalog?.knobs) || catalog.knobs.length === 0) errors.push('knobs must be non-empty')
  if (!Array.isArray(catalog?.interactionGroups) || catalog.interactionGroups.length === 0) errors.push('interactionGroups must be non-empty')
  if (!Array.isArray(catalog?.requiredObservableFamilies) || catalog.requiredObservableFamilies.length === 0) {
    errors.push('requiredObservableFamilies must be non-empty')
  }
  if (!Array.isArray(catalog?.hardConstraints) || catalog.hardConstraints.length === 0) errors.push('hardConstraints must be non-empty')

  const ids = new Set()
  const keys = new Set()
  for (const knob of catalog?.knobs ?? []) {
    if (!knob.id || ids.has(knob.id)) errors.push(`knob id missing or duplicate: ${knob.id ?? '<missing>'}`)
    if (!knob.configKey || keys.has(knob.configKey)) errors.push(`configKey missing or duplicate: ${knob.configKey ?? '<missing>'}`)
    ids.add(knob.id)
    keys.add(knob.configKey)
    if (!knob.owner || !knob.correctnessOwner || !knob.securityOwner) errors.push(`${knob.id} is missing an owner`)
    if (!LIFECYCLES.has(knob.lifecycle)) errors.push(`${knob.id} has invalid lifecycle`)
    if (!Array.isArray(knob.observables) || knob.observables.length === 0) errors.push(`${knob.id} is missing observables`)
    if (!Array.isArray(knob.guardrails) || knob.guardrails.length === 0) errors.push(`${knob.id} is missing guardrails`)
    if (!Number.isFinite(knob.range?.minimum) || !Number.isFinite(knob.range?.maximum) ||
        !Number.isFinite(knob.range?.step) || knob.range.minimum >= knob.range.maximum || knob.range.step <= 0) {
      errors.push(`${knob.id} has invalid range`)
      continue
    }
    for (const field of ['baseline', 'rollbackValue']) {
      const valueError = validateKnobValue(knob, knob[field])
      if (valueError) errors.push(`${field}: ${valueError}`)
    }
    if (!(knob.maxNormalizedStep > 0 && knob.maxNormalizedStep <= 1)) errors.push(`${knob.id} has invalid maxNormalizedStep`)
    if (!Array.isArray(knob.interactionGroups) || knob.interactionGroups.length === 0) errors.push(`${knob.id} has no interaction group`)
    if (knob.lifecycle === 'synthetic-only' && knob.source !== 'synthetic-fixture') errors.push(`${knob.id} synthetic-only knob must use synthetic-fixture source`)
  }

  const groupIds = new Set()
  for (const group of catalog?.interactionGroups ?? []) {
    if (!group.id || groupIds.has(group.id)) errors.push(`interaction group missing or duplicate: ${group.id ?? '<missing>'}`)
    groupIds.add(group.id)
    if (!Array.isArray(group.knobIds) || group.knobIds.length === 0) errors.push(`${group.id} has no knobs`)
    for (const knobId of group.knobIds ?? []) {
      if (!ids.has(knobId)) errors.push(`${group.id} references unknown knob ${knobId}`)
    }
    if (!Array.isArray(group.requiredGuardrails) || group.requiredGuardrails.length === 0) errors.push(`${group.id} has no guardrails`)
    if (!(group.maxNormalizedStep > 0 && group.maxNormalizedStep <= 1)) errors.push(`${group.id} has invalid maxNormalizedStep`)
    if (group.candidateMode === 'synthetic-only-until-1451' && group.dependency !== 'issue-1451-delivery-policy') {
      errors.push(`${group.id} must declare issue-1451 delivery policy dependency`)
    }
  }
  for (const knob of catalog?.knobs ?? []) {
    for (const groupId of knob.interactionGroups ?? []) {
      const group = (catalog.interactionGroups ?? []).find((candidate) => candidate.id === groupId)
      if (!group || !group.knobIds.includes(knob.id)) errors.push(`${knob.id} has inconsistent interaction group ${groupId}`)
    }
  }

  const allowedConstraints = new Set(['lte', 'scaled-lte', 'scaled-gte', 'sum-lte'])
  for (const constraint of catalog?.hardConstraints ?? []) {
    if (!constraint.id || !allowedConstraints.has(constraint.kind)) errors.push(`invalid hard constraint ${constraint.id ?? '<missing>'}`)
    const referenced = constraint.keys ?? [constraint.left, constraint.right]
    for (const key of referenced) if (!keys.has(key)) errors.push(`${constraint.id} references unknown config ${key}`)
  }
  if (errors.length === 0) {
    const baseline = Object.fromEntries(catalog.knobs.map((knob) => [knob.configKey, knob.baseline]))
    for (const constraint of catalog.hardConstraints ?? []) {
      if (!evaluateConstraint(constraint, baseline)) errors.push(`baseline violates hard constraint ${constraint.id}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export function baselineConfig(catalog) {
  const validation = validateCatalog(catalog)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  return Object.fromEntries(catalog.knobs.map((knob) => [knob.configKey, knob.baseline]))
}

export function rollbackConfig(catalog) {
  const validation = validateCatalog(catalog)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  return Object.fromEntries(catalog.knobs.map((knob) => [knob.configKey, knob.rollbackValue]))
}

export function validateConfig(catalog, config, { groupId, evidenceKind = 'synthetic' } = {}) {
  const errors = [...validateCatalog(catalog).errors]
  const byKey = keyMap(catalog)
  const group = groupId ? catalog.interactionGroups?.find((candidate) => candidate.id === groupId) : null
  if (groupId && !group) errors.push(`unknown interaction group ${groupId}`)
  if (group?.candidateMode === 'synthetic-only-until-1451' && evidenceKind !== 'synthetic') {
    errors.push(`${groupId} is synthetic-only until issue #1451 delivery policy is complete`)
  }
  for (const key of Object.keys(config ?? {})) if (!byKey.has(key)) errors.push(`unknown configuration key ${key}`)
  for (const knob of catalog.knobs ?? []) {
    if (!(knob.configKey in (config ?? {}))) errors.push(`missing configuration key ${knob.configKey}`)
    else {
      const valueError = validateKnobValue(knob, config[knob.configKey])
      if (valueError) errors.push(valueError)
    }
  }
  if (errors.length === 0) {
    for (const constraint of catalog.hardConstraints ?? []) {
      if (!evaluateConstraint(constraint, config)) errors.push(`hard constraint failed: ${constraint.id}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export function readCatalog(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
