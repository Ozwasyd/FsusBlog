/**
 * Pure arithmetic over caller-supplied observations, without collectors, timers,
 * environment access, policy loading, identity verification or receipt authority.
 * A complete input is still unqualified; source-bound policy admission, actual
 * window identity, workload completion and environment admission have other owners.
 */

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new TypeError(`resource retention series: ${message}`);
    }
}

function exactKeys(value, keys, label)
{
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
    requireCondition(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
        `${label} must be a plain object`);
    const actual = Reflect.ownKeys(value);
    requireCondition(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)),
        `${label} must contain exactly ${keys.join(', ')}`);
}

function positiveInteger(value, label)
{
    requireCondition(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function validateContract(mode, contract)
{
    exactKeys(contract, [
        'warmupDurationMs', 'baselineRecoveryDurationMs', 'cycleCount',
        'loadDurationMsPerCycle', 'recoveryDurationMsPerCycle', 'finalRecoveryDurationMs',
        'sampleIntervalMs', 'loadConcurrency', 'threshold',
        'minimumSamplesPerWarmup', 'minimumSamplesPerBaselineRecovery',
        'minimumSamplesPerLoadCycle', 'minimumSamplesPerRecoveryCycle',
        'minimumSamplesPerFinalRecovery', 'maximumSampleLatenessMs'
    ], 'contract');
    // These checks preserve the requested invariants; they supply no missing policy.
    const fixed = {
        warmupDurationMs: mode === 'memory-leak' ? 60000 : 30000,
        cycleCount: 5,
        loadDurationMsPerCycle: 30000,
        recoveryDurationMsPerCycle: 15000,
        finalRecoveryDurationMs: 30000,
        sampleIntervalMs: 1000,
        loadConcurrency: 8,
        minimumSamplesPerLoadCycle: 25,
        minimumSamplesPerRecoveryCycle: 10,
        threshold: mode === 'memory-leak' ? 67108864 : 16
    };
    for (const [key, expected] of Object.entries(fixed))
    {
        requireCondition(contract[key] === expected, `contract.${key} must equal ${expected}`);
    }
    positiveInteger(contract.baselineRecoveryDurationMs, 'contract.baselineRecoveryDurationMs');
    requireCondition(contract.baselineRecoveryDurationMs % contract.sampleIntervalMs === 0,
        'baseline recovery duration must contain whole sampling intervals');
    requireCondition(Number.isSafeInteger(contract.maximumSampleLatenessMs)
        && contract.maximumSampleLatenessMs >= 0
        && contract.maximumSampleLatenessMs < contract.sampleIntervalMs,
    'maximum sample lateness must be explicit and within one sampling interval');
    for (const [minimum, duration] of [
        ['minimumSamplesPerWarmup', 'warmupDurationMs'],
        ['minimumSamplesPerBaselineRecovery', 'baselineRecoveryDurationMs'],
        ['minimumSamplesPerFinalRecovery', 'finalRecoveryDurationMs']
    ])
    {
        positiveInteger(contract[minimum], `contract.${minimum}`);
        requireCondition(contract[minimum] <= contract[duration] / contract.sampleIntervalMs,
            `contract.${minimum} exceeds the available sampling slots`);
    }
}

function expectedPhases(contract)
{
    const phases = [
        { phase: 'warmup', cycle: null, durationMs: contract.warmupDurationMs, minimumSamples: contract.minimumSamplesPerWarmup },
        {
            phase: 'baseline-recovery', cycle: null, durationMs: contract.baselineRecoveryDurationMs,
            minimumSamples: contract.minimumSamplesPerBaselineRecovery
        }
    ];
    for (let cycle = 1; cycle <= contract.cycleCount; cycle += 1)
    {
        phases.push(
            { phase: 'load', cycle, durationMs: contract.loadDurationMsPerCycle, minimumSamples: contract.minimumSamplesPerLoadCycle },
            { phase: 'recovery', cycle, durationMs: contract.recoveryDurationMsPerCycle, minimumSamples: contract.minimumSamplesPerRecoveryCycle }
        );
    }
    phases.push({
        phase: 'final-recovery', cycle: null, durationMs: contract.finalRecoveryDurationMs,
        minimumSamples: contract.minimumSamplesPerFinalRecovery
    });
    return phases;
}

function exactHalf(doubledValue)
{
    const value = Number(doubledValue) / 2;
    // Multiplication by two is exact for the finite integer/half-integer domain.
    // Reject only unrepresentable derived values, without imposing a resource cap.
    requireCondition(Number.isFinite(value) && BigInt(value * 2) === doubledValue,
        'derived median or growth cannot be represented exactly as a Number');
    return value;
}

function median(values)
{
    requireCondition(values.length > 0, 'recovery latter half has no samples');
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const doubledMedian = sorted.length % 2 === 1
        ? BigInt(sorted[middle]) * 2n
        : BigInt(sorted[middle - 1]) + BigInt(sorted[middle]);
    return exactHalf(doubledMedian);
}

function retainedGrowth(recovered, baseline)
{
    // Both medians have already passed the exact doubled-integer round trip.
    return exactHalf(BigInt(recovered * 2) - BigInt(baseline * 2));
}

function summarizePhase(phase, expected, contract, mode, previousEnd)
{
    const label = `${expected.phase}/${expected.cycle ?? 'none'}`;
    exactKeys(phase, ['phase', 'cycle', 'startMonotonicMs', 'endMonotonicMs', 'samples'], label);
    requireCondition(phase.phase === expected.phase && phase.cycle === expected.cycle,
        `${label} is missing, duplicated or out of order`);
    requireCondition(Number.isSafeInteger(phase.startMonotonicMs) && phase.startMonotonicMs >= 0,
        `${label} start must be a non-negative monotonic millisecond integer`);
    requireCondition(Number.isSafeInteger(phase.endMonotonicMs)
        && phase.endMonotonicMs - phase.startMonotonicMs === expected.durationMs,
    `${label} duration must equal ${expected.durationMs}ms`);
    requireCondition(previousEnd === null || phase.startMonotonicMs === previousEnd,
        `${label} must immediately follow the previous phase without overlap or gaps`);
    const expectedCount = expected.durationMs / contract.sampleIntervalMs;
    requireCondition(Array.isArray(phase.samples) && phase.samples.length === expectedCount
        && phase.samples.length >= expected.minimumSamples,
    `${label} requires all ${expectedCount} sampling slots and at least ${expected.minimumSamples} samples`);

    const latterHalf = [];
    const midpoint = phase.startMonotonicMs + expected.durationMs / 2;
    // Indexed iteration also rejects sparse arrays rather than silently skipping holes.
    for (let index = 0; index < expectedCount; index += 1)
    {
        const sample = phase.samples[index];
        const sampleLabel = `${label} sample ${index}`;
        exactKeys(sample, ['status', 'monotonicMs', 'value'], sampleLabel);
        requireCondition(sample.status === 'ok', `${sampleLabel} collection failed or is unavailable`);
        const scheduledMs = phase.startMonotonicMs + index * contract.sampleIntervalMs;
        requireCondition(Number.isSafeInteger(sample.monotonicMs)
            && sample.monotonicMs >= scheduledMs
            && sample.monotonicMs <= scheduledMs + contract.maximumSampleLatenessMs
            && sample.monotonicMs < phase.endMonotonicMs,
        `${sampleLabel} is early, late, duplicated or outside its sampling slot`);
        requireCondition(Number.isSafeInteger(sample.value) && sample.value >= 0
            && (mode !== 'memory-leak' || sample.value > 0),
        `${sampleLabel} requires an observed ${mode === 'memory-leak' ? 'positive RSS byte' : 'non-negative total handle/FD'} count`);
        if (sample.monotonicMs >= midpoint)
        {
            latterHalf.push(sample.value);
        }
    }
    const isRecovery = expected.phase === 'baseline-recovery'
        || expected.phase === 'recovery' || expected.phase === 'final-recovery';
    return {
        phase: expected.phase,
        cycle: expected.cycle,
        startMonotonicMs: phase.startMonotonicMs,
        endMonotonicMs: phase.endMonotonicMs,
        sampleCount: expectedCount,
        latterHalfSampleCount: isRecovery ? latterHalf.length : null,
        recoveredMedian: isRecovery ? median(latterHalf) : null
    };
}

/**
 * Validate a complete explicit calculation contract and summarize sampled phases.
 * Windows are contiguous and half-open [start, end); slot zero is at phase start.
 * Each 1000ms slot requires exactly one successful observation within the caller's
 * explicit maximum lateness. Minimum counts never excuse missing or late slots.
 * Recovery statistics use actual monotonic timestamps in [midpoint, end).
 *
 * This accepts plain data only. `contract` contains every key checked above;
 * undefined baseline duration, sampling tolerance or minimum counts are errors.
 * Samples use `value` for RSS bytes or total handles/FDs according to `mode`.
 * It neither authenticates the caller's contract nor verifies any observation.
 * Numerical threshold comparisons never imply workload, identity or runtime PASS.
 * Medians and growth use exact doubled BigInt arithmetic; a derived value that
 * cannot round-trip through the Number output representation is rejected.
 *
 * @param {object} input Explicit mode, contract and ordered sampled phases.
 * @returns {object} Unqualified arithmetic summary; invalid input throws TypeError.
 */
export function summarizeResourceRetentionSeries(input)
{
    exactKeys(input, ['mode', 'contract', 'phases'], 'input');
    const { mode, contract, phases } = input;
    requireCondition(mode === 'memory-leak' || mode === 'open-handle', 'mode must be memory-leak or open-handle');
    validateContract(mode, contract);
    const expected = expectedPhases(contract);
    requireCondition(Array.isArray(phases) && phases.length === expected.length,
        `all ${expected.length} phases are required; start/end-only observations are invalid`);
    const summaries = [];
    let previousEnd = null;
    for (let index = 0; index < expected.length; index += 1)
    {
        const summary = summarizePhase(phases[index], expected[index], contract, mode, previousEnd);
        summaries.push(summary);
        previousEnd = summary.endMonotonicMs;
    }
    const baseline = summaries[1].recoveredMedian;
    const cycleRecovered = summaries.filter(phase => phase.phase === 'recovery').map(phase => phase.recoveredMedian);
    const finalRecovered = summaries[summaries.length - 1].recoveredMedian;
    const maxRetainedGrowth = retainedGrowth(Math.max(...cycleRecovered, finalRecovered), baseline);
    const finalRetainedGrowth = retainedGrowth(finalRecovered, baseline);
    return {
        qualificationEligible: false,
        evidenceClass: 'calculation-only',
        mode,
        unit: mode === 'memory-leak' ? 'bytes' : 'count',
        durationMs: summaries[summaries.length - 1].endMonotonicMs - summaries[0].startMonotonicMs,
        sampleCount: summaries.reduce((count, phase) => count + phase.sampleCount, 0),
        phases: summaries,
        baseline,
        cycleRecovered,
        finalRecovered,
        maxRetainedGrowth,
        finalRetainedGrowth,
        threshold: contract.threshold,
        thresholdEvaluation: {
            maxRetainedGrowthWithinThreshold: maxRetainedGrowth <= contract.threshold,
            finalRetainedGrowthWithinThreshold: finalRetainedGrowth <= contract.threshold
        }
    };
}
