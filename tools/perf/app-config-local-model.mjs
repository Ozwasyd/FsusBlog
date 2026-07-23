import {
  digestJson,
  rollbackConfig,
  validateConfig
} from './app-config-catalog.mjs'

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function solve(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]])
  for (let column = 0; column < augmented.length; column += 1) {
    let pivot = column
    for (let row = column + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    for (let index = column; index <= augmented.length; index += 1) augmented[column][index] /= divisor
    for (let row = 0; row < augmented.length; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let index = column; index <= augmented.length; index += 1) augmented[row][index] -= factor * augmented[column][index]
    }
  }
  return augmented.map((row) => row.at(-1))
}

function fitLeastSquares(rows, values) {
  const width = rows[0].length
  const xtx = Array.from({ length: width }, () => Array(width).fill(0))
  const xty = Array(width).fill(0)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let left = 0; left < width; left += 1) {
      xty[left] += rows[rowIndex][left] * values[rowIndex]
      for (let right = 0; right < width; right += 1) xtx[left][right] += rows[rowIndex][left] * rows[rowIndex][right]
    }
  }
  for (let index = 0; index < width; index += 1) xtx[index][index] += 1e-10
  return solve(xtx, xty)
}

function clampAligned(knob, value) {
  const stepped = knob.range.minimum + Math.round((value - knob.range.minimum) / knob.range.step) * knob.range.step
  return Math.min(knob.range.maximum, Math.max(knob.range.minimum, stepped))
}

export function analyzeLocalExperiment({ catalog, design, runs, targetMetrics, maximumResidualRatio = 0.15, maximumRepeatCv = 0.1 }) {
  if (design.catalogDigest !== digestJson(catalog)) throw new Error('design catalog digest does not match catalog')
  if (!Array.isArray(targetMetrics) || targetMetrics.length === 0) throw new Error('targetMetrics must be non-empty')
  const expected = new Set(design.order.map((entry) => `${entry.pointId}:${entry.repeat}`))
  const seen = new Set()
  const failures = []
  const suppliedRuns = runs ?? []
  for (const run of suppliedRuns) {
    const key = `${run.pointId}:${run.repeat}`
    if (!expected.has(key)) failures.push({ ...run, reason: 'unexpected-run' })
    else if (seen.has(key)) failures.push({ ...run, reason: 'duplicate-run' })
    else seen.add(key)
    if (run.outcome !== 'success' || run.correctness !== true || run.security !== true) failures.push(run)
  }
  const missing = [...expected].filter((key) => !seen.has(key))
  const successful = suppliedRuns.filter((run) =>
    run.outcome === 'success' && run.correctness === true && run.security === true &&
    targetMetrics.every((metric) => Number.isFinite(run.measurements?.[metric]))
  )
  const byPoint = new Map()
  for (const run of successful) {
    const list = byPoint.get(run.pointId) ?? []
    list.push(run)
    byPoint.set(run.pointId, list)
  }
  const group = catalog.interactionGroups.find((candidate) => candidate.id === design.groupId)
  const knobs = group.knobIds
  const terms = ['intercept', ...knobs, ...knobs.map((id) => `${id}^2`)]
  for (let left = 0; left < knobs.length; left += 1) {
    for (let right = left + 1; right < knobs.length; right += 1) terms.push(`${knobs[left]}*${knobs[right]}`)
  }
  const pointRows = design.points.filter((point) => byPoint.has(point.id)).map((point) => {
    const x = knobs.map((id) => point.normalizedDelta[id])
    const row = [1, ...x, ...x.map((value) => value ** 2)]
    for (let left = 0; left < x.length; left += 1) {
      for (let right = left + 1; right < x.length; right += 1) row.push(x[left] * x[right])
    }
    return { point, x, row, runs: byPoint.get(point.id) }
  })
  const metrics = {}
  let insufficient = missing.length > 0
  for (const metric of targetMetrics) {
    const values = pointRows.map((entry) => mean(entry.runs.map((run) => run.measurements[metric])))
    const coefficients = pointRows.length >= terms.length ? fitLeastSquares(pointRows.map((entry) => entry.row), values) : null
    const repeatCvs = pointRows.map((entry) => {
      const samples = entry.runs.map((run) => run.measurements[metric])
      const average = mean(samples)
      const variance = mean(samples.map((value) => (value - average) ** 2))
      return average === 0 ? 0 : Math.sqrt(variance) / Math.abs(average)
    })
    if (!coefficients) {
      insufficient = true
      metrics[metric] = { status: 'insufficient-evidence', reason: 'singular-or-under-sampled-design' }
      continue
    }
    const predicted = pointRows.map((entry) => entry.row.reduce((sum, value, index) => sum + value * coefficients[index], 0))
    const residualRms = Math.sqrt(mean(values.map((value, index) => (value - predicted[index]) ** 2)))
    const scale = Math.max(1e-9, Math.max(...values) - Math.min(...values), Math.abs(mean(values)))
    const residualRatio = residualRms / scale
    const repeatCv = Math.max(...repeatCvs)
    const coefficientMap = Object.fromEntries(terms.map((term, index) => [term, coefficients[index]]))
    const curvature = Math.max(...knobs.map((id) => Math.abs(coefficientMap[`${id}^2`] ?? 0))) / scale
    const nonZeroCoefficients = coefficients.map(Math.abs).filter((value) => value > 1e-9)
    const conditionIndicator = nonZeroCoefficients.length === 0
      ? 1
      : Math.max(...nonZeroCoefficients) / Math.min(...nonZeroCoefficients)
    const interaction = Object.fromEntries(terms.filter((term) => term.includes('*')).map((term) => [term, coefficientMap[term]]))
    const metricInsufficient = residualRatio > maximumResidualRatio || repeatCv > maximumRepeatCv
    insufficient ||= metricInsufficient
    metrics[metric] = {
      status: metricInsufficient ? 'insufficient-evidence' : 'ok',
      jacobian: Object.fromEntries(knobs.map((id) => [id, coefficientMap[id]])),
      pairwiseInteraction: interaction,
      quadratic: Object.fromEntries(knobs.map((id) => [id, coefficientMap[`${id}^2`]])),
      residualRms,
      residualRatio,
      maximumRepeatCv: repeatCv,
      confidenceRegion: {
        normalizedRadius: design.radius,
        maximumResidualRatio,
        maximumRepeatCv,
        extrapolationAllowed: false
      },
      conditionIndicator,
      highConditionNumber: conditionIndicator > 10_000,
      highCurvature: curvature > 0.2,
      capacityCliff: curvature > 0.5 || failures.length > 0,
      directionConflict: knobs.some((id) => {
        const linear = coefficientMap[id]
        const quadratic = coefficientMap[`${id}^2`]
        return Math.abs(quadratic) > Math.abs(linear) * 2
      })
    }
  }
  return {
    schema: 'fsusblog.app-config-local-model.v1',
    status: insufficient ? 'insufficient-evidence' : 'ok',
    groupId: design.groupId,
    model: 'local-quadratic-with-pairwise-interactions',
    metrics,
    failedRuns: failures,
    missingRuns: missing,
    successfulRunCount: successful.length,
    physicalSampleCount: design.physicalSampleCount,
    fullThreeLevelGridSampleCount: design.fullThreeLevelGridSampleCount
  }
}

export function proposeLocalCandidate({
  catalog,
  design,
  analysis,
  targetMetric,
  objective = 'minimize',
  guardrailPredictions = {},
  guardrailLimits = {}
}) {
  const rollback = rollbackConfig(catalog)
  const rejected = (reason, radiusReason = 'guardrail-or-model-rejection') => ({
    status: 'rejected',
    reason,
    nextRadius: Math.max(0.05, design.radius / 2),
    radiusReason,
    rollbackProfile: { name: `${design.groupId}-rollback`, config: rollback, configDigest: digestJson(rollback) }
  })
  if (analysis.status !== 'ok' || analysis.metrics[targetMetric]?.status !== 'ok') {
    return { ...rejected('insufficient-evidence', 'model-residual-or-variance'), status: 'insufficient-evidence' }
  }
  const violated = Object.entries(guardrailLimits).filter(([name, limit]) =>
    !Number.isFinite(guardrailPredictions[name]) || guardrailPredictions[name] > limit
  )
  if (violated.length > 0) return rejected(`predicted-guardrail-failure:${violated.map(([name]) => name).join(',')}`)

  const group = catalog.interactionGroups.find((candidate) => candidate.id === design.groupId)
  const byId = new Map(catalog.knobs.map((knob) => [knob.id, knob]))
  const baseline = structuredClone(design.points.find((point) => point.normalizedDelta &&
    Object.values(point.normalizedDelta).every((value) => value === 0))?.config)
  if (!baseline) return rejected('missing-baseline-point')
  const candidate = structuredClone(baseline)
  const sign = objective === 'maximize' ? 1 : -1
  const jacobian = analysis.metrics[targetMetric].jacobian
  for (const knobId of group.knobIds) {
    const knob = byId.get(knobId)
    const gradient = jacobian[knobId]
    if (Math.abs(gradient) < 1e-12) continue
    const direction = Math.sign(gradient) * sign
    const step = Math.min(knob.maxNormalizedStep, group.maxNormalizedStep) * design.radius *
      (knob.range.maximum - knob.range.minimum)
    candidate[knob.configKey] = clampAligned(knob, candidate[knob.configKey] + direction * step)
  }
  const validation = validateConfig(catalog, candidate, { groupId: design.groupId, evidenceKind: design.evidenceKind })
  if (!validation.valid) return rejected(`infeasible-candidate:${validation.errors.join('|')}`)
  if (digestJson(candidate) === digestJson(baseline)) return rejected('no-feasible-local-step')
  return {
    status: 'proposed',
    reason: 'bounded-local-model-direction',
    radius: design.radius,
    profile: { name: `${design.groupId}-candidate`, config: candidate, configDigest: digestJson(candidate) },
    rollbackProfile: { name: `${design.groupId}-rollback`, config: rollback, configDigest: digestJson(rollback) },
    productionMutation: false
  }
}

export function assessMeasuredCandidate({ proposal, predictedDelta, actualDelta, guardrailsPassed, correctnessPassed, securityPassed }) {
  const rollback = proposal.rollbackProfile
  if (proposal.status !== 'proposed') return proposal
  const directionMatches = Number.isFinite(predictedDelta) && Number.isFinite(actualDelta) &&
    predictedDelta !== 0 && Math.sign(predictedDelta) === Math.sign(actualDelta)
  if (!guardrailsPassed || !correctnessPassed || !securityPassed || !directionMatches) {
    return {
      status: 'rejected',
      reason: !correctnessPassed || !securityPassed ? 'correctness-or-security-failure'
        : !guardrailsPassed ? 'measured-guardrail-failure' : 'prediction-direction-mismatch',
      nextRadius: Math.max(0.05, proposal.radius / 2),
      radiusReason: 'measured-result-invalidated-local-model',
      rollbackProfile: rollback
    }
  }
  return {
    status: 'accepted',
    reason: 'repeatable-directional-benefit-with-guardrails',
    nextRadius: Math.min(1, proposal.radius * 1.25),
    radiusReason: 'prediction-confirmed',
    profile: proposal.profile,
    rollbackProfile: rollback,
    productionMutation: false
  }
}
