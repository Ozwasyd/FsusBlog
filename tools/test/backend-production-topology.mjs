const DEFAULT_MAX_TESTHOSTS = 12
const DEFAULT_MEMORY_GIB_PER_TESTHOST = 1
const DEFAULT_PARTITION_MULTIPLIER = 2
const CALIBRATION_TESTHOST_CANDIDATES = [2, 4, 6, 8, 12]
const CALIBRATION_PARTITION_MULTIPLIERS = [1.5, 2, 3]
const CALIBRATION_PROCESSOR_ALLOCATION_MODES = ['uniform', 'weighted']

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function positiveNumber(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`)
  return parsed
}

function optionalPositiveInteger(value, label) {
  return value === null || value === undefined ? null : positiveInteger(value, label)
}

function optionalPositiveNumber(value, label) {
  return value === null || value === undefined ? null : positiveNumber(value, label)
}

function normalizeWeights(testhostCount, weights) {
  if (weights === null || weights === undefined) return Array.from({ length: testhostCount }, () => 1)
  if (!Array.isArray(weights) || weights.length !== testhostCount) {
    throw new Error('backend topology processor weights must contain one value per testhost')
  }
  return weights.map((weight) => positiveNumber(weight, 'backend topology processor weight'))
}

export function allocateBackendTopologyProcessors(cpuBudgetValue, testhostCountValue, {
  mode = 'uniform',
  weights = null
} = {}) {
  const cpuBudget = positiveInteger(cpuBudgetValue, 'backend topology CPU budget')
  const testhostCount = positiveInteger(testhostCountValue, 'backend topology testhost count')
  if (testhostCount > cpuBudget) {
    throw new Error(`backend topology testhost count ${testhostCount} exceeds CPU budget ${cpuBudget}`)
  }
  if (!CALIBRATION_PROCESSOR_ALLOCATION_MODES.includes(mode)) {
    throw new Error(`backend topology processor allocation mode must be one of ${CALIBRATION_PROCESSOR_ALLOCATION_MODES.join(', ')}`)
  }
  if (mode === 'uniform') {
    return Array.from({ length: testhostCount }, (_, index) => (
      Math.floor(cpuBudget / testhostCount) + (index < cpuBudget % testhostCount ? 1 : 0)
    ))
  }

  const normalizedWeights = normalizeWeights(testhostCount, weights)
  const allocations = Array.from({ length: testhostCount }, () => 1)
  const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0)
  while (allocations.reduce((sum, processors) => sum + processors, 0) < cpuBudget) {
    let selected = 0
    let largestDeficit = Number.NEGATIVE_INFINITY
    for (let index = 0; index < allocations.length; index += 1) {
      const ideal = cpuBudget * normalizedWeights[index] / weightTotal
      const deficit = ideal - allocations[index]
      if (deficit > largestDeficit) {
        largestDeficit = deficit
        selected = index
      }
    }
    allocations[selected] += 1
  }
  return allocations
}

export function resolveBackendTopologyCapacity({
  cpuBudget: cpuBudgetValue,
  memoryGiB: memoryGiBValue,
  planningUnitCount: planningUnitCountValue,
  maxTesthosts: maxTesthostsValue = DEFAULT_MAX_TESTHOSTS,
  memoryGiBPerTesthost: memoryGiBPerTesthostValue = DEFAULT_MEMORY_GIB_PER_TESTHOST
}) {
  const cpuBudget = positiveInteger(cpuBudgetValue, 'backend topology CPU budget')
  const memoryGiB = positiveNumber(memoryGiBValue, 'backend topology memory budget')
  const planningUnitCount = positiveInteger(planningUnitCountValue, 'backend topology planning unit count')
  const configuredMaxTesthosts = positiveInteger(maxTesthostsValue, 'backend topology maximum testhosts')
  const memoryGiBPerTesthost = positiveNumber(
    memoryGiBPerTesthostValue,
    'backend topology memory per testhost'
  )
  const memoryTesthostLimit = Math.floor((memoryGiB + 1e-9) / memoryGiBPerTesthost)
  const testhostLimit = Math.min(cpuBudget, memoryTesthostLimit, planningUnitCount, configuredMaxTesthosts)
  if (testhostLimit < 2) {
    throw new Error(
      `backend topology requires capacity for at least two testhosts; CPU=${cpuBudget} memoryGiB=${memoryGiB}`
    )
  }
  return {
    cpuBudget,
    memoryGiB,
    planningUnitCount,
    configuredMaxTesthosts,
    memoryGiBPerTesthost,
    memoryTesthostLimit,
    testhostLimit
  }
}

function deriveAutomaticTesthostCount(capacity, {
  coldApplicationStartupPenalty,
  classStartupPenalty,
  weightedDependencyCount,
  affinityGroupCount
}) {
  // The stable machine term prevents one-testhost-per-core fan-out. Workload
  // terms can move the target by one host, but never bypass the hard limits.
  const machineTarget = Math.max(2, Math.floor(Math.sqrt(capacity.cpuBudget)))
  const longTailPressure = Math.ceil(
    (weightedDependencyCount + classStartupPenalty + affinityGroupCount)
    / Math.max(1, coldApplicationStartupPenalty)
  )
  const workloadAdjustment = longTailPressure >= machineTarget * 2 ? 1 : 0
  return Math.min(capacity.testhostLimit, machineTarget + workloadAdjustment)
}

function topologyScore({
  testhostCount,
  planningUnitCount,
  productionTestCaseCount,
  coldApplicationStartupPenalty,
  classStartupPenalty,
  weightedDependencyCount,
  affinityGroupCount
}) {
  const hostStartup = testhostCount * coldApplicationStartupPenalty
  const rollingTail = Math.ceil(planningUnitCount / testhostCount) * classStartupPenalty
  const dependencyTail = Math.ceil(weightedDependencyCount / testhostCount)
  const affinityQueue = Math.max(0, affinityGroupCount - testhostCount) * classStartupPenalty
  const estimatedWorkPerHost = Math.ceil(productionTestCaseCount / testhostCount)
  return {
    total: hostStartup + rollingTail + dependencyTail + affinityQueue + estimatedWorkPerHost,
    hostStartup,
    rollingTail,
    dependencyTail,
    affinityQueue,
    estimatedWorkPerHost
  }
}

export function planBackendProductionTopology({
  cpuBudget,
  memoryGiB,
  planningUnitCount,
  productionTestCaseCount,
  coldApplicationStartupPenalty,
  classStartupPenalty,
  weightedDependencyCount = 0,
  affinityGroupCount = 0,
  governancePostludeCount = 1,
  testhostOverride = null,
  partitionMultiplier = DEFAULT_PARTITION_MULTIPLIER,
  processorAllocationMode = 'uniform',
  processorWeights = null,
  maxTesthosts = DEFAULT_MAX_TESTHOSTS,
  memoryGiBPerTesthost = DEFAULT_MEMORY_GIB_PER_TESTHOST
}) {
  const capacity = resolveBackendTopologyCapacity({
    cpuBudget,
    memoryGiB,
    planningUnitCount,
    maxTesthosts,
    memoryGiBPerTesthost
  })
  const cases = positiveInteger(productionTestCaseCount, 'backend topology production test case count')
  const coldPenalty = positiveInteger(coldApplicationStartupPenalty, 'backend topology cold startup penalty')
  const classPenalty = positiveInteger(classStartupPenalty, 'backend topology class startup penalty')
  const dependencyCount = Number(weightedDependencyCount)
  const affinityCount = Number(affinityGroupCount)
  const postludeCount = Number(governancePostludeCount)
  if (!Number.isInteger(dependencyCount) || dependencyCount < 0) {
    throw new Error('backend topology weighted dependency count must be a non-negative integer')
  }
  if (!Number.isInteger(affinityCount) || affinityCount < 0) {
    throw new Error('backend topology affinity group count must be a non-negative integer')
  }
  if (!Number.isInteger(postludeCount) || postludeCount < 1) {
    throw new Error('backend topology governance postlude count must be a positive integer')
  }
  const configuredTesthosts = optionalPositiveInteger(testhostOverride, 'backend topology diagnostic testhost override')
  if (configuredTesthosts !== null && configuredTesthosts > capacity.testhostLimit) {
    throw new Error(
      `backend topology testhost override ${configuredTesthosts} exceeds capacity ${capacity.testhostLimit}`
    )
  }
  const multiplier = optionalPositiveNumber(partitionMultiplier, 'backend topology partition multiplier')
  if (multiplier < 1) throw new Error('backend topology partition multiplier must be at least one')
  const testhostCount = configuredTesthosts ?? deriveAutomaticTesthostCount(capacity, {
    coldApplicationStartupPenalty: coldPenalty,
    classStartupPenalty: classPenalty,
    weightedDependencyCount: dependencyCount,
    affinityGroupCount: affinityCount
  })
  const resolvedProcessorWeights = processorAllocationMode === 'weighted' && processorWeights === null
    ? Array.from({ length: testhostCount }, (_, index) => Math.max(
        1,
        Math.ceil((capacity.planningUnitCount - index) / testhostCount)
      ))
    : processorWeights
  const processorsByTesthost = allocateBackendTopologyProcessors(capacity.cpuBudget, testhostCount, {
    mode: processorAllocationMode,
    weights: resolvedProcessorWeights
  })
  const allocatedCpuUnits = processorsByTesthost.reduce((sum, processors) => sum + processors, 0)
  const memoryGiBByTesthost = Array.from(
    { length: testhostCount },
    () => capacity.memoryGiB / testhostCount
  )
  if (memoryGiBByTesthost.some((value) => value + 1e-9 < capacity.memoryGiBPerTesthost)) {
    throw new Error('backend topology processor allocation violates the per-testhost memory floor')
  }
  const rollingPartitionCount = Math.min(
    capacity.planningUnitCount,
    Math.max(testhostCount, Math.ceil(testhostCount * multiplier))
  )
  if (rollingPartitionCount < testhostCount) {
    throw new Error('backend topology rolling partition count cannot be lower than testhost count')
  }
  const candidates = Array.from({ length: capacity.testhostLimit - 1 }, (_, index) => index + 2)
    .map((candidateTesthosts) => ({
      testhostCount: candidateTesthosts,
      score: topologyScore({
        testhostCount: candidateTesthosts,
        planningUnitCount: capacity.planningUnitCount,
        productionTestCaseCount: cases,
        coldApplicationStartupPenalty: coldPenalty,
        classStartupPenalty: classPenalty,
        weightedDependencyCount: dependencyCount,
        affinityGroupCount: affinityCount
      })
    }))
  return {
    schema: 'fsusblog.backend-production-topology.v1',
    source: configuredTesthosts === null ? 'automatic-machine-workload-model' : 'diagnostic-override',
    testhostCount,
    rollingPartitionCount,
    governancePostludeCount: postludeCount,
    totalPartitionCount: rollingPartitionCount + postludeCount,
    processorsByTesthost,
    memoryGiBByTesthost,
    allocatedCpuUnits,
    allocatedMemoryGiB: memoryGiBByTesthost.reduce((sum, value) => sum + value, 0),
    partitionMultiplier: multiplier,
    processorAllocationMode,
    processorWeights: resolvedProcessorWeights,
    capacity,
    modelInputs: {
      productionTestCaseCount: cases,
      coldApplicationStartupPenalty: coldPenalty,
      classStartupPenalty: classPenalty,
      weightedDependencyCount: dependencyCount,
      affinityGroupCount: affinityCount
    },
    candidateScores: candidates,
    formula: 'bounded sqrt(machine CPU) plus workload long-tail pressure; rolling partitions are independent',
    invariants: {
      exactCpuConservation: allocatedCpuUnits === capacity.cpuBudget,
      exactMemoryConservation: Math.abs(
        memoryGiBByTesthost.reduce((sum, value) => sum + value, 0) - capacity.memoryGiB
      ) < 1e-9,
      affinityUnitsRemainIndivisible: true,
      governancePostludeSeparated: true
    }
  }
}

export function buildBackendTopologyCalibrationMatrix({
  cpuBudget,
  memoryGiB,
  planningUnitCount,
  maxTesthosts = DEFAULT_MAX_TESTHOSTS,
  memoryGiBPerTesthost = DEFAULT_MEMORY_GIB_PER_TESTHOST,
  testhostCandidates = CALIBRATION_TESTHOST_CANDIDATES,
  partitionMultipliers = CALIBRATION_PARTITION_MULTIPLIERS,
  processorAllocationModes = CALIBRATION_PROCESSOR_ALLOCATION_MODES
}) {
  const capacity = resolveBackendTopologyCapacity({
    cpuBudget,
    memoryGiB,
    planningUnitCount,
    maxTesthosts,
    memoryGiBPerTesthost
  })
  const hosts = [...new Set(testhostCandidates.map((value) => positiveInteger(
    value,
    'backend calibration testhost candidate'
  )))].filter((value) => value <= capacity.testhostLimit)
  const multipliers = [...new Set(partitionMultipliers.map((value) => {
    const parsed = positiveNumber(value, 'backend calibration partition multiplier')
    if (parsed < 1) throw new Error('backend calibration partition multiplier must be at least one')
    return parsed
  }))]
  const allocationModes = [...new Set(processorAllocationModes)]
  if (allocationModes.some((mode) => !CALIBRATION_PROCESSOR_ALLOCATION_MODES.includes(mode))) {
    throw new Error('backend calibration processor allocation mode is invalid')
  }
  if (hosts.length === 0) throw new Error('backend calibration matrix has no feasible testhost candidate')
  return hosts.flatMap((testhostCount) => multipliers.flatMap((partitionMultiplier) => (
    allocationModes.map((processorAllocationMode) => ({
      id: `h${testhostCount}-p${String(partitionMultiplier).replace('.', '_')}-${processorAllocationMode}`,
      testhostCount,
      partitionMultiplier,
      processorAllocationMode,
      rollingPartitionCount: Math.min(
        capacity.planningUnitCount,
        Math.max(testhostCount, Math.ceil(testhostCount * partitionMultiplier))
      )
    }))
  )))
}

export const backendTopologyDefaults = Object.freeze({
  maxTesthosts: DEFAULT_MAX_TESTHOSTS,
  memoryGiBPerTesthost: DEFAULT_MEMORY_GIB_PER_TESTHOST,
  partitionMultiplier: DEFAULT_PARTITION_MULTIPLIER,
  calibrationTesthostCandidates: CALIBRATION_TESTHOST_CANDIDATES,
  calibrationPartitionMultipliers: CALIBRATION_PARTITION_MULTIPLIERS,
  calibrationProcessorAllocationModes: CALIBRATION_PROCESSOR_ALLOCATION_MODES
})
