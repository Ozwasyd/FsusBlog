import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const rawSchema = 'fsusblog.aeds-frame-cost.raw.v2'
const finalSchema = 'fsusblog.aeds-frame-cost.v2'
const commitPattern = /^[0-9a-f]{40}$/u
const artifactDigestPattern = /^sha256:[0-9a-f]{64}$/u
const artifactSetSchema = 'fsusblog.aeds-frame-cost-artifact-set.v1'
const artifactIdPattern = /^[a-z][a-z0-9-]*$/u
const requiredArtifactIds = new Set(['benchmark', 'core'])
const pathGroups = new Set([
  'static-preencoded',
  'tiny-dynamic',
  'representative-dynamic',
  'supplemental-dynamic'
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sectionLines(text, name, indent) {
  const lines = text.split(/\r?\n/u)
  const prefix = ' '.repeat(indent)
  const header = `${prefix}${name}:`
  const start = lines.findIndex((line) => line === header)
  invariant(start >= 0, `perf-policy missing ${name}`)
  const result = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) {
      result.push(line)
      continue
    }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent <= indent) break
    result.push(line)
  }
  return result
}

function scalar(lines, name, indent) {
  const prefix = ' '.repeat(indent)
  const match = lines.find((line) => line.startsWith(`${prefix}${name}:`))
  invariant(match, `perf-policy missing ${name}`)
  return match.slice(match.indexOf(':') + 1).trim()
}

function numberScalar(lines, name, indent) {
  const value = Number(scalar(lines, name, indent))
  invariant(Number.isFinite(value) && value >= 0, `perf-policy ${name} must be a non-negative number`)
  return value
}

function arrayScalar(lines, name, indent) {
  const value = scalar(lines, name, indent)
  invariant(value.startsWith('[') && value.endsWith(']'), `perf-policy ${name} must be an inline array`)
  const entries = value.slice(1, -1).split(',').map((entry) => entry.trim()).filter(Boolean)
  invariant(entries.length > 0 && new Set(entries).size === entries.length, `perf-policy ${name} must be non-empty and unique`)
  return entries
}

function thresholdPolicy(lines, name) {
  const nested = sectionLines(lines.join('\n'), name, 2)
  return {
    maxP95RegressionPercent: numberScalar(nested, 'maxP95RegressionPercent', 4),
    maxP95RegressionMs: numberScalar(nested, 'maxP95RegressionMs', 4),
    maxMeanRegressionPercent: numberScalar(nested, 'maxMeanRegressionPercent', 4),
    maxMeanRegressionMs: numberScalar(nested, 'maxMeanRegressionMs', 4),
    maxAllocationRegressionPercent: numberScalar(nested, 'maxAllocationRegressionPercent', 4),
    maxAllocationIncreaseBytes: numberScalar(nested, 'maxAllocationIncreaseBytes', 4)
  }
}

export function readAedsFrameCostPolicy(policyFile, label = 'tests/performance/perf-policy.yml') {
  const text = fs.readFileSync(policyFile, 'utf8')
  const rootVersion = scalar(text.split(/\r?\n/u), 'version', 0)
  const lines = sectionLines(text, 'aedsFrameCost', 0)
  const policy = {
    file: label,
    fileSha256: `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`,
    version: rootVersion,
    schema: scalar(lines, 'schema', 2),
    minimumRounds: numberScalar(lines, 'minimumRounds', 2),
    minimumWarmupIterations: numberScalar(lines, 'minimumWarmupIterations', 2),
    minimumIterationsPerRound: numberScalar(lines, 'minimumIterationsPerRound', 2),
    authoritativeMeanAggregation: scalar(lines, 'authoritativeMeanAggregation', 2),
    authoritativeP95Aggregation: scalar(lines, 'authoritativeP95Aggregation', 2),
    requiredRepresentativeScenarios: arrayScalar(lines, 'requiredRepresentativeScenarios', 2),
    staticPreencodedScenarios: arrayScalar(lines, 'staticPreencodedScenarios', 2),
    tinyDynamicScenarios: arrayScalar(lines, 'tinyDynamicScenarios', 2),
    representative: thresholdPolicy(lines, 'representative'),
    tiny: thresholdPolicy(lines, 'tiny')
  }
  invariant(policy.schema === 'fsusblog.aeds-frame-cost-policy.v1', 'perf-policy aedsFrameCost.schema is unsupported')
  invariant(policy.authoritativeMeanAggregation === 'median-of-round-means', 'perf-policy authoritativeMeanAggregation is unsupported')
  invariant(policy.authoritativeP95Aggregation === 'median-of-round-p95', 'perf-policy authoritativeP95Aggregation is unsupported')
  for (const [key, value] of Object.entries({
    minimumRounds: policy.minimumRounds,
    minimumWarmupIterations: policy.minimumWarmupIterations,
    minimumIterationsPerRound: policy.minimumIterationsPerRound
  })) {
    invariant(Number.isInteger(value) && value > 0, `perf-policy aedsFrameCost.${key} must be a positive integer`)
  }
  const classified = [
    ...policy.requiredRepresentativeScenarios,
    ...policy.staticPreencodedScenarios,
    ...policy.tinyDynamicScenarios
  ]
  invariant(new Set(classified).size === classified.length, 'perf-policy AEDS frame groups must not overlap')
  return policy
}

function nonEmptyString(value, label) {
  invariant(typeof value === 'string' && value.trim().length > 0, `${label} must be non-empty`)
}

function finiteNumber(value, label, { positive = false, integer = false } = {}) {
  invariant(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`)
  invariant(value >= (positive ? Number.EPSILON : 0), `${label} must be ${positive ? '> 0' : '>= 0'}`)
  if (integer) invariant(Number.isInteger(value), `${label} must be an integer`)
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function safeArtifactPath(relativePath, label) {
  nonEmptyString(relativePath, label)
  invariant(!path.isAbsolute(relativePath), `${label} must be repo-relative`)
  const normalized = relativePath.replaceAll('\\', '/')
  invariant(normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../'), `${label} escapes artifact root`)
  return normalized
}

function artifactSetDigest(artifacts) {
  const canonical = [...artifacts]
    .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0))
    .map(({ id, path: artifactPath, bytes, sha256 }) => ({ id, path: artifactPath, bytes, sha256 }))
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

function defaultArtifactResolver(artifactRoot) {
  const root = path.resolve(artifactRoot)
  return (relativePath) => {
    const resolved = path.resolve(root, relativePath)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null
    return fs.existsSync(resolved) ? resolved : null
  }
}

function verifyArtifactSet(source, {
  artifactRoot,
  resolveArtifactPath = defaultArtifactResolver(artifactRoot),
  requireReleaseArtifacts = true
}) {
  const set = source?.artifactSet
  invariant(set?.schema === artifactSetSchema, `aeds-frame-cost.source.artifactSet.schema must be ${artifactSetSchema}`)
  invariant(artifactDigestPattern.test(set.digest ?? ''), 'aeds-frame-cost.source.artifactSet.digest is invalid')
  invariant(Array.isArray(set.artifacts) && set.artifacts.length >= requiredArtifactIds.size, 'aeds-frame-cost.source.artifactSet.artifacts is incomplete')
  const ids = new Set()
  for (const artifact of set.artifacts) {
    nonEmptyString(artifact?.id, 'aeds-frame-cost artifact id')
    invariant(artifactIdPattern.test(artifact.id), `aeds-frame-cost artifact id ${artifact.id} is invalid`)
    invariant(!ids.has(artifact.id), `aeds-frame-cost artifact id ${artifact.id} is duplicated`)
    ids.add(artifact.id)
    artifact.path = safeArtifactPath(artifact.path, `aeds-frame-cost artifact ${artifact.id}.path`)
    if (artifact.evidencePath !== undefined) {
      artifact.evidencePath = safeArtifactPath(artifact.evidencePath, `aeds-frame-cost artifact ${artifact.id}.evidencePath`)
    }
    finiteNumber(artifact.bytes, `aeds-frame-cost artifact ${artifact.id}.bytes`, { positive: true, integer: true })
    invariant(artifactDigestPattern.test(artifact.sha256 ?? ''), `aeds-frame-cost artifact ${artifact.id}.sha256 is invalid`)
    const releaseFile = resolveArtifactPath(artifact.path)
    const evidenceFile = artifact.evidencePath ? resolveArtifactPath(artifact.evidencePath) : null
    if (requireReleaseArtifacts) {
      invariant(releaseFile, `aeds-frame-cost release artifact missing: ${artifact.path}`)
    }
    invariant(releaseFile || evidenceFile, `aeds-frame-cost artifact bytes unavailable: ${artifact.path}`)
    for (const [kind, file] of [['release', releaseFile], ['evidence', evidenceFile]]) {
      if (!file) continue
      const stat = fs.statSync(file)
      invariant(stat.isFile(), `aeds-frame-cost ${kind} artifact is not a file: ${artifact.id}`)
      invariant(stat.size === artifact.bytes, `aeds-frame-cost ${kind} artifact ${artifact.id} byte length mismatch`)
      invariant(sha256File(file) === artifact.sha256, `aeds-frame-cost ${kind} artifact ${artifact.id} SHA-256 mismatch`)
    }
  }
  for (const id of requiredArtifactIds) {
    invariant(ids.has(id), `aeds-frame-cost artifact set missing ${id}`)
  }
  invariant(artifactSetDigest(set.artifacts) === set.digest, 'aeds-frame-cost artifact set digest mismatch')
  return set
}

export function stageAedsFrameCostArtifacts(raw, artifactRoot, evidenceDirectory = '.tmp/perf/aeds-frame-cost/artifacts') {
  const root = path.resolve(artifactRoot)
  const safeEvidenceDirectory = safeArtifactPath(evidenceDirectory, 'aeds-frame-cost evidence directory').replace(/\/$/u, '')
  const set = verifyArtifactSet(raw.source, { artifactRoot: root, requireReleaseArtifacts: true })
  const staged = structuredClone(raw)
  for (const artifact of staged.source.artifactSet.artifacts) {
    const sourceFile = path.resolve(root, artifact.path)
    const evidencePath = safeArtifactPath(`${safeEvidenceDirectory}/${artifact.id}/${path.basename(artifact.path)}`, `aeds-frame-cost artifact ${artifact.id}.evidencePath`)
    const outputFile = path.resolve(root, evidencePath)
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
    fs.copyFileSync(sourceFile, outputFile)
    artifact.evidencePath = evidencePath
  }
  verifyArtifactSet(staged.source, { artifactRoot: root, requireReleaseArtifacts: true })
  invariant(set.digest === staged.source.artifactSet.digest, 'staging changed AEDS artifact identity')
  return staged
}

function indexUnique(items, label) {
  invariant(Array.isArray(items) && items.length > 0, `${label} must be non-empty`)
  const index = new Map()
  for (const item of items) {
    nonEmptyString(item?.scenario, `${label}.scenario`)
    invariant(!index.has(item.scenario), `${label} contains duplicate scenario ${item.scenario}`)
    index.set(item.scenario, item)
  }
  return index
}

function validateMeasurement(measurement, label, method) {
  invariant(measurement && typeof measurement === 'object', `${label} missing`)
  for (const metric of ['meanMs', 'p50Ms', 'p95Ms']) {
    finiteNumber(measurement[metric], `${label}.${metric}`, { positive: true })
  }
  finiteNumber(measurement.arithmeticMeanMs, `${label}.arithmeticMeanMs`, { positive: true })
  finiteNumber(measurement.pooledP95Ms, `${label}.pooledP95Ms`, { positive: true })
  invariant(measurement.meanAggregation === method.authoritativeMeanAggregation, `${label}.meanAggregation is invalid`)
  invariant(measurement.p95Aggregation === method.authoritativeP95Aggregation, `${label}.p95Aggregation is invalid`)
  finiteNumber(measurement.standardDeviationMs, `${label}.standardDeviationMs`)
  finiteNumber(measurement.allocationBytesPerRequest, `${label}.allocationBytesPerRequest`, { integer: true })
  finiteNumber(measurement.sampleCount, `${label}.sampleCount`, { positive: true, integer: true })
  invariant(measurement.p50Ms <= measurement.p95Ms, `${label}.p50Ms must be <= p95Ms`)
  invariant(measurement.sampleCount === method.roundCount * method.iterationsPerRound, `${label}.sampleCount must match method`)
  invariant(Array.isArray(measurement.rounds) && measurement.rounds.length === method.roundCount, `${label}.rounds must match method.roundCount`)
  const derivedRounds = []
  for (const [index, round] of measurement.rounds.entries()) {
    invariant(round.round === index + 1, `${label}.rounds must be contiguous`)
    for (const metric of ['meanMs', 'p50Ms', 'p95Ms']) {
      finiteNumber(round[metric], `${label}.rounds[${index}].${metric}`, { positive: true })
    }
    finiteNumber(round.standardDeviationMs, `${label}.rounds[${index}].standardDeviationMs`)
    finiteNumber(round.sampleCount, `${label}.rounds[${index}].sampleCount`, { positive: true, integer: true })
    invariant(Array.isArray(round.samplesMs), `${label}.rounds[${index}].samplesMs missing`)
    invariant(round.samplesMs.length === method.iterationsPerRound, `${label}.rounds[${index}].samplesMs must match iterationsPerRound`)
    for (const [sampleIndex, sample] of round.samplesMs.entries()) {
      finiteNumber(sample, `${label}.rounds[${index}].samplesMs[${sampleIndex}]`, { positive: true })
    }
    invariant(round.sampleCount === round.samplesMs.length, `${label}.rounds[${index}].sampleCount must match samplesMs`)
    finiteNumber(round.allocatedBytesTotal, `${label}.rounds[${index}].allocatedBytesTotal`, { integer: true })
    finiteNumber(round.allocationBytesPerRequest, `${label}.rounds[${index}].allocationBytesPerRequest`, { integer: true })
    const derived = deriveSamples(round.samplesMs)
    invariant(round.meanMs === derived.meanMs, `${label}.rounds[${index}].meanMs does not match samplesMs`)
    invariant(round.p50Ms === derived.p50Ms, `${label}.rounds[${index}].p50Ms does not match samplesMs`)
    invariant(round.p95Ms === derived.p95Ms, `${label}.rounds[${index}].p95Ms does not match samplesMs`)
    invariant(round.standardDeviationMs === derived.standardDeviationMs, `${label}.rounds[${index}].standardDeviationMs does not match samplesMs`)
    invariant(round.allocationBytesPerRequest === Math.floor(round.allocatedBytesTotal / method.iterationsPerRound), `${label}.rounds[${index}].allocationBytesPerRequest does not match allocatedBytesTotal`)
    derivedRounds.push({ ...derived, allocationBytesPerRequest: round.allocationBytesPerRequest })
  }
  const pooled = deriveSamples(measurement.rounds.flatMap((item) => item.samplesMs))
  const expected = {
    meanMs: median(derivedRounds.map((item) => item.meanMs)),
    arithmeticMeanMs: pooled.meanMs,
    p50Ms: pooled.p50Ms,
    p95Ms: median(derivedRounds.map((item) => item.p95Ms)),
    pooledP95Ms: pooled.p95Ms,
    standardDeviationMs: pooled.standardDeviationMs,
    allocationBytesPerRequest: median(derivedRounds.map((item) => item.allocationBytesPerRequest)),
    coefficientOfVariation: pooled.coefficientOfVariation,
    p95RangeMs: round(Math.max(...derivedRounds.map((item) => item.p95Ms)) - Math.min(...derivedRounds.map((item) => item.p95Ms)))
  }
  for (const metric of ['meanMs', 'arithmeticMeanMs', 'p50Ms', 'p95Ms', 'pooledP95Ms', 'standardDeviationMs', 'allocationBytesPerRequest']) {
    invariant(measurement[metric] === expected[metric], `${label}.${metric} does not match raw samples/rounds`)
  }
  finiteNumber(measurement.allocationRangeBytes?.min, `${label}.allocationRangeBytes.min`, { integer: true })
  finiteNumber(measurement.allocationRangeBytes?.max, `${label}.allocationRangeBytes.max`, { integer: true })
  const allocations = derivedRounds.map((item) => item.allocationBytesPerRequest)
  invariant(measurement.allocationRangeBytes.min === Math.min(...allocations), `${label}.allocationRangeBytes.min does not match rounds`)
  invariant(measurement.allocationRangeBytes.max === Math.max(...allocations), `${label}.allocationRangeBytes.max does not match rounds`)
  return expected
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[ordered.length >> 1]
}

function deriveSamples(samples) {
  const ordered = [...samples].sort((left, right) => left - right)
  const arithmeticMean = samples.reduce((total, value) => total + value, 0) / samples.length
  const variance = samples.reduce((total, value) => total + ((value - arithmeticMean) ** 2), 0) / samples.length
  const standardDeviation = Math.sqrt(variance)
  return {
    meanMs: round(arithmeticMean),
    p50Ms: percentile(ordered, 0.50),
    p95Ms: percentile(ordered, 0.95),
    standardDeviationMs: round(standardDeviation),
    coefficientOfVariation: arithmeticMean > 0 ? round(standardDeviation / arithmeticMean) : 0
  }
}

function percentile(ordered, quantile) {
  return round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)])
}

function allowedDelta(before, percent, absolute) {
  return Math.max(absolute, before * percent / 100)
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function assessMeasuredResult(result, policy) {
  const isStatic = result.pathGroup === 'static-preencoded'
  if (isStatic) {
    return {
      gating: false,
      policyGroup: 'static-preencoded-reference',
      outcome: 'reference-only',
      regressionReasons: [],
      limits: null,
      deltas: null
    }
  }
  const policyGroup = result.pathGroup === 'tiny-dynamic' ? 'tiny' : 'representative'
  const thresholds = policy[policyGroup]
  const p95Delta = allowedDelta(result.before.p95Ms, thresholds.maxP95RegressionPercent, thresholds.maxP95RegressionMs)
  const meanDelta = allowedDelta(result.before.meanMs, thresholds.maxMeanRegressionPercent, thresholds.maxMeanRegressionMs)
  const allocationDelta = Math.max(
    thresholds.maxAllocationIncreaseBytes,
    Math.ceil(result.before.allocationBytesPerRequest * thresholds.maxAllocationRegressionPercent / 100)
  )
  const limits = {
    p95Ms: round(result.before.p95Ms + p95Delta),
    meanMs: round(result.before.meanMs + meanDelta),
    allocationBytesPerRequest: result.before.allocationBytesPerRequest + allocationDelta
  }
  const regressionReasons = []
  if (result.after.p95Ms > limits.p95Ms) regressionReasons.push('p95-regressed')
  if (result.after.meanMs > limits.meanMs) regressionReasons.push('mean-regressed')
  if (result.after.allocationBytesPerRequest > limits.allocationBytesPerRequest) regressionReasons.push('allocation-regressed')
  const meaningfulImprovement = result.after.p95Ms < result.before.p95Ms - p95Delta
    || result.after.meanMs < result.before.meanMs - meanDelta
    || result.after.allocationBytesPerRequest < result.before.allocationBytesPerRequest - allocationDelta
  return {
    gating: true,
    policyGroup,
    outcome: regressionReasons.length > 0 ? 'regressed' : (meaningfulImprovement ? 'improved' : 'neutral'),
    regressionReasons,
    limits,
    deltas: {
      p95Ms: round(result.after.p95Ms - result.before.p95Ms),
      meanMs: round(result.after.meanMs - result.before.meanMs),
      allocationBytesPerRequest: result.after.allocationBytesPerRequest - result.before.allocationBytesPerRequest
    }
  }
}

function authority(raw, policy) {
  const reasons = new Set(Array.isArray(raw.measuredEvidence?.authority?.blockedReasons)
    ? raw.measuredEvidence.authority.blockedReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : [])
  const source = raw.source ?? {}
  if (source.buildConfiguration !== 'Release') reasons.add('non-release-artifact')
  const environment = raw.measuredEvidence?.environment ?? {}
  for (const field of ['machineName', 'cpu', 'os', 'osArchitecture', 'processArchitecture', 'runtime', 'runtimeVersion', 'affinity']) {
    if (typeof environment[field] !== 'string' || environment[field].trim().length === 0) reasons.add(`${field}-identity-unavailable`)
  }
  if (!Number.isInteger(environment.processorCount) || environment.processorCount <= 0) reasons.add('processor-count-unavailable')
  if (typeof environment.gc?.server !== 'boolean' || typeof environment.gc?.latencyMode !== 'string' || environment.gc.latencyMode.length === 0) {
    reasons.add('gc-identity-unavailable')
  }
  const method = raw.measuredEvidence?.method ?? {}
  if (!Number.isInteger(method.roundCount) || method.roundCount < policy.minimumRounds) reasons.add('insufficient-round-count')
  if (!Number.isInteger(method.warmupIterations) || method.warmupIterations < policy.minimumWarmupIterations) reasons.add('insufficient-warmup')
  if (!Number.isInteger(method.iterationsPerRound) || method.iterationsPerRound < policy.minimumIterationsPerRound) reasons.add('insufficient-iterations-per-round')
  if (method.sampleCountPerVariant !== method.roundCount * method.iterationsPerRound) reasons.add('sample-count-mismatch')
  if (method.ordering !== 'alternating-before-after-by-round') reasons.add('measurement-ordering-uncontrolled')
  if (method.authoritativeMeanAggregation !== policy.authoritativeMeanAggregation) reasons.add('mean-aggregation-uncontrolled')
  if (method.authoritativeP95Aggregation !== policy.authoritativeP95Aggregation) reasons.add('p95-aggregation-uncontrolled')
  if (raw.measuredEvidence?.authority?.authoritative === false && reasons.size === 0) reasons.add('profiler-marked-non-authoritative')
  return {
    authoritative: reasons.size === 0,
    blockedReasons: [...reasons].sort()
  }
}

function validateRawSummary(raw, policy, expectedCommitSha, artifactOptions) {
  invariant(raw?.schema === rawSchema, `aeds-frame-cost.schema must be ${rawSchema}`)
  invariant(raw.status === 'raw' && raw.conclusionsFinalized === false, 'aeds-frame-cost raw summary state is invalid')
  invariant(raw.measurementSource === 'local-aeds-frame-cost-profiler', 'aeds-frame-cost.measurementSource must be local profiler')
  invariant(commitPattern.test(expectedCommitSha), 'expected AEDS frame-cost commit must be a 40-hex SHA')
  invariant(commitPattern.test(raw.source?.commitSha ?? ''), 'aeds-frame-cost.source.commitSha must be a 40-hex SHA')
  invariant(raw.source.commitSha === expectedCommitSha, `aeds-frame-cost.source.commitSha ${raw.source.commitSha} does not match ${expectedCommitSha}`)
  verifyArtifactSet(raw.source, artifactOptions)
  invariant(raw.structuralEvidence?.evidenceKind === 'executable-implementation-derivation', 'aeds-frame-cost structural evidence kind is invalid')
  invariant(raw.structuralEvidence?.copyBytesCounterKind === 'payload-length-derived-not-hardware-counter', 'aeds-frame-cost copy bytes must be marked as derived')
  invariant(raw.measuredEvidence?.evidenceKind === 'same-process-release-artifact-multi-round', 'aeds-frame-cost measured evidence kind is invalid')
  const structural = indexUnique(raw.structuralEvidence.results, 'aeds-frame-cost.structuralEvidence.results')
  const measured = indexUnique(raw.measuredEvidence.results, 'aeds-frame-cost.measuredEvidence.results')
  invariant(structural.size >= 10 && measured.size === structural.size, 'aeds-frame-cost evidence must cover the same full scenario set')
  invariant([...structural.keys()].every((scenario) => measured.has(scenario)), 'aeds-frame-cost structural/measured scenarios differ')
  for (const scenario of policy.requiredRepresentativeScenarios) {
    invariant(structural.get(scenario)?.pathGroup === 'representative-dynamic', `aeds-frame-cost ${scenario} must be representative-dynamic`)
  }
  for (const scenario of policy.staticPreencodedScenarios) {
    invariant(structural.get(scenario)?.pathGroup === 'static-preencoded', `aeds-frame-cost ${scenario} must be static-preencoded`)
  }
  for (const scenario of policy.tinyDynamicScenarios) {
    invariant(structural.get(scenario)?.pathGroup === 'tiny-dynamic', `aeds-frame-cost ${scenario} must be tiny-dynamic`)
  }
  const method = raw.measuredEvidence.method ?? {}
  for (const item of structural.values()) {
    const label = `aeds-frame-cost:${item.scenario}:structural`
    invariant(pathGroups.has(item.pathGroup), `${label}.pathGroup is invalid`)
    finiteNumber(item.rawPayloadBytes, `${label}.rawPayloadBytes`, { integer: true })
    for (const field of ['copyCountBefore', 'copyCountAfter', 'copyBytesBefore', 'copyBytesAfter']) {
      finiteNumber(item[field], `${label}.${field}`, { integer: true })
    }
    nonEmptyString(item.derivation, `${label}.derivation`)
    invariant(item.counterKind === 'implementation-derived-payload-length', `${label}.counterKind must remain derived`)
    invariant(item.hardwareCounter === false, `${label}.hardwareCounter must be false`)
    if (item.pathGroup === 'static-preencoded') {
      invariant(item.copyCountBefore === 0 && item.copyCountAfter === 0, `${label} static path cannot claim a dynamic copy reduction`)
    } else {
      invariant(item.copyBytesBefore === item.rawPayloadBytes, `${label}.copyBytesBefore must be payload-length derived`)
    }
  }
  for (const item of measured.values()) {
    const label = `aeds-frame-cost:${item.scenario}:measured`
    invariant(pathGroups.has(item.pathGroup), `${label}.pathGroup is invalid`)
    invariant(item.pathGroup === structural.get(item.scenario).pathGroup, `${label}.pathGroup differs from structural evidence`)
    invariant(item.rawPayloadBytes === structural.get(item.scenario).rawPayloadBytes, `${label}.rawPayloadBytes differs from structural evidence`)
    finiteNumber(item.rawFrameBytes, `${label}.rawFrameBytes`, { positive: true, integer: true })
    const beforeDerived = validateMeasurement(item.before, `${label}.before`, method)
    const afterDerived = validateMeasurement(item.after, `${label}.after`, method)
    validateMeasurement(item.crc, `${label}.crc`, method)
    for (const field of ['beforeP95RangeMs', 'afterP95RangeMs', 'beforeCoefficientOfVariation', 'afterCoefficientOfVariation']) {
      finiteNumber(item.variability?.[field], `${label}.variability.${field}`)
    }
    invariant(item.variability.beforeP95RangeMs === beforeDerived.p95RangeMs, `${label}.variability.beforeP95RangeMs does not match rounds`)
    invariant(item.variability.afterP95RangeMs === afterDerived.p95RangeMs, `${label}.variability.afterP95RangeMs does not match rounds`)
    invariant(item.variability.beforeCoefficientOfVariation === beforeDerived.coefficientOfVariation, `${label}.variability.beforeCoefficientOfVariation does not match samplesMs`)
    invariant(item.variability.afterCoefficientOfVariation === afterDerived.coefficientOfVariation, `${label}.variability.afterCoefficientOfVariation does not match samplesMs`)
  }
  return { structural, measured }
}

export function finalizeAedsFrameCostSummary(raw, policy, expectedCommitSha, artifactOptions) {
  const { structural, measured } = validateRawSummary(raw, policy, expectedCommitSha, artifactOptions)
  const computedAuthority = authority(raw, policy)
  const structuralDynamic = [...structural.values()].filter((item) => item.pathGroup !== 'static-preencoded')
  const structuralRegressed = structuralDynamic.some((item) => item.copyCountAfter > item.copyCountBefore || item.copyBytesAfter > item.copyBytesBefore)
  const representativeImproved = policy.requiredRepresentativeScenarios.every((scenario) => {
    const item = structural.get(scenario)
    return item.copyCountAfter < item.copyCountBefore && item.copyBytesAfter < item.copyBytesBefore
  })
  const structuralConclusion = structuralRegressed ? 'regressed' : (representativeImproved ? 'improved' : 'neutral')
  const measuredResults = [...measured.values()].map((item) => ({
    ...item,
    assessment: assessMeasuredResult(item, policy)
  }))
  const gatingAssessments = measuredResults.filter((item) => item.assessment.gating).map((item) => item.assessment)
  const measuredRegressed = gatingAssessments.some((assessment) => assessment.outcome === 'regressed')
  const representativeAssessments = measuredResults
    .filter((item) => policy.requiredRepresentativeScenarios.includes(item.scenario))
    .map((item) => item.assessment)
  let measuredConclusion
  if (measuredRegressed) measuredConclusion = 'regressed'
  else if (!computedAuthority.authoritative) measuredConclusion = 'blocked'
  else if (representativeAssessments.some((assessment) => assessment.outcome === 'improved')) measuredConclusion = 'improved'
  else measuredConclusion = 'neutral'
  let overallConclusion
  if (structuralConclusion === 'regressed' || measuredConclusion === 'regressed') overallConclusion = 'regressed'
  else if (structuralConclusion === 'improved' && measuredConclusion === 'blocked') overallConclusion = 'structural-only'
  else if (structuralConclusion === 'improved' && ['improved', 'neutral'].includes(measuredConclusion)) overallConclusion = 'improved'
  else overallConclusion = 'blocked'
  const status = overallConclusion === 'improved'
    ? 'ok'
    : (overallConclusion === 'regressed' ? 'regressed' : 'blocked')
  return {
    ...raw,
    schema: finalSchema,
    status,
    conclusionsFinalized: true,
    policy: {
      file: policy.file,
      fileSha256: policy.fileSha256,
      version: policy.version,
      schema: policy.schema,
      minimumRounds: policy.minimumRounds,
      minimumWarmupIterations: policy.minimumWarmupIterations,
      minimumIterationsPerRound: policy.minimumIterationsPerRound,
      authoritativeMeanAggregation: policy.authoritativeMeanAggregation,
      authoritativeP95Aggregation: policy.authoritativeP95Aggregation,
      requiredRepresentativeScenarios: policy.requiredRepresentativeScenarios,
      staticPreencodedScenarios: policy.staticPreencodedScenarios,
      tinyDynamicScenarios: policy.tinyDynamicScenarios,
      representative: policy.representative,
      tiny: policy.tiny
    },
    structuralEvidence: {
      ...raw.structuralEvidence,
      conclusion: structuralConclusion
    },
    measuredEvidence: {
      ...raw.measuredEvidence,
      authority: computedAuthority,
      conclusion: measuredConclusion,
      results: measuredResults
    },
    structuralConclusion,
    measuredConclusion,
    overallConclusion
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function validateAedsFrameCostSummary(summary, policy, expectedCommitSha, {
  requireAuthoritative = true,
  artifactRoot,
  resolveArtifactPath,
  requireReleaseArtifacts = true
} = {}) {
  invariant(summary?.schema === finalSchema, `aeds-frame-cost.schema must be ${finalSchema}`)
  invariant(summary.conclusionsFinalized === true, 'aeds-frame-cost conclusions must be finalized')
  const raw = {
    ...summary,
    schema: rawSchema,
    status: 'raw',
    conclusionsFinalized: false,
    measuredEvidence: {
      ...summary.measuredEvidence,
      results: summary.measuredEvidence?.results?.map(({ assessment: _assessment, ...result }) => result)
    }
  }
  const expected = finalizeAedsFrameCostSummary(raw, policy, expectedCommitSha, {
    artifactRoot,
    resolveArtifactPath,
    requireReleaseArtifacts
  })
  invariant(sameJson(summary.policy, expected.policy), 'aeds-frame-cost policy identity or thresholds do not match perf-policy.yml')
  for (const field of ['status', 'structuralConclusion', 'measuredConclusion', 'overallConclusion']) {
    invariant(summary[field] === expected[field], `aeds-frame-cost.${field} must be field-driven (${expected[field]})`)
  }
  invariant(summary.structuralEvidence?.conclusion === expected.structuralConclusion, 'aeds-frame-cost structural evidence conclusion is inconsistent')
  invariant(summary.measuredEvidence?.conclusion === expected.measuredConclusion, 'aeds-frame-cost measured evidence conclusion is inconsistent')
  invariant(sameJson(summary.measuredEvidence?.authority, expected.measuredEvidence.authority), 'aeds-frame-cost authority is inconsistent with runtime identity')
  const expectedAssessments = new Map(expected.measuredEvidence.results.map((item) => [item.scenario, item.assessment]))
  for (const item of summary.measuredEvidence?.results ?? []) {
    invariant(sameJson(item.assessment, expectedAssessments.get(item.scenario)), `aeds-frame-cost:${item.scenario}.assessment is inconsistent with policy`)
  }
  if (requireAuthoritative) {
    invariant(summary.measuredEvidence.authority.authoritative === true, `aeds-frame-cost measured evidence is non-authoritative: ${summary.measuredEvidence.authority.blockedReasons.join(', ')}`)
    invariant(summary.status === 'ok' && summary.overallConclusion === 'improved', 'aeds-frame-cost authoritative gate requires overall improved')
  } else {
    invariant(['ok', 'blocked', 'regressed'].includes(summary.status), 'aeds-frame-cost status is invalid')
  }
  return summary
}

export const aedsFrameCostSchemas = Object.freeze({ raw: rawSchema, final: finalSchema })
