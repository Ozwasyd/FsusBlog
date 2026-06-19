import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TASK_MATRIX = [
  ['text-task', 'semantic-decoy', 'homoglyph-noise'],
  ['text-task', 'semantic-decoy', 'instruction-split'],
  ['text-task', 'reading-order', 'bidi-fragment'],
  ['text-task', 'reading-order', 'context-window'],
  ['localization', 'spatial-grid', 'moving-hotspot'],
  ['localization', 'spatial-grid', 'occluded-anchor'],
  ['localization', 'relative-position', 'rotated-frame'],
  ['localization', 'relative-position', 'nested-landmark'],
  ['micro-interaction', 'gesture-chain', 'press-drag-release'],
  ['micro-interaction', 'gesture-chain', 'hold-then-select'],
  ['micro-interaction', 'timing-gate', 'delayed-confirm'],
  ['micro-interaction', 'timing-gate', 'jitter-window']
];

const PROFILE_DEFAULTS = {
  pr: {
    samples: 96,
    attempts: 3,
    thresholds: {
      minHumanSuccessRate: 0.82,
      maxBotSingleTrySuccessRate: 0.34,
      maxBotThreeAttemptSuccessRate: 0.52,
      maxClientRenderP95Ms: 55,
      maxServerVerifyP99Ms: 32,
      maxPayloadP95Bytes: 6200,
      maxMedianSolveTimeMs: 18000
    }
  },
  nightly: {
    samples: 960,
    attempts: 3,
    thresholds: {
      minHumanSuccessRate: 0.84,
      maxBotSingleTrySuccessRate: 0.34,
      maxBotThreeAttemptSuccessRate: 0.49,
      maxClientRenderP95Ms: 50,
      maxServerVerifyP99Ms: 30,
      maxPayloadP95Bytes: 6000,
      maxMedianSolveTimeMs: 17000
    }
  }
};

export function createDefaultThresholds(profile = 'pr') {
  const defaults = PROFILE_DEFAULTS[profile] ?? PROFILE_DEFAULTS.pr;
  return { ...defaults.thresholds };
}

export function createDefaultProfileOptions(profile = 'pr') {
  const defaults = PROFILE_DEFAULTS[profile] ?? PROFILE_DEFAULTS.pr;
  return {
    samples: defaults.samples,
    attempts: defaults.attempts,
    thresholds: createDefaultThresholds(profile)
  };
}

export function generateSyntheticDataset({ seed = 521, samples = PROFILE_DEFAULTS.pr.samples } = {}) {
  const sampleCount = normalizePositiveInteger(samples, 'samples');
  const dataset = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const [taskKind, family, variant] = TASK_MATRIX[index % TASK_MATRIX.length];
    const base = deterministicUnit(`${seed}:${index}:base`);
    const textEntropy = round(0.35 + deterministicUnit(`${seed}:${index}:text`) * 0.6, 4);
    const spatialEntropy = round(0.3 + deterministicUnit(`${seed}:${index}:spatial`) * 0.65, 4);
    const temporalEntropy = round(0.25 + deterministicUnit(`${seed}:${index}:temporal`) * 0.7, 4);
    const decoyDensity = round(0.25 + deterministicUnit(`${seed}:${index}:decoy`) * 0.7, 4);
    const localeShift = round(deterministicUnit(`${seed}:${index}:locale`) * 0.5, 4);
    const pointerPrecision = round(0.2 + deterministicUnit(`${seed}:${index}:pointer`) * 0.75, 4);
    const difficulty = round(
      clamp((textEntropy + spatialEntropy + temporalEntropy + decoyDensity + pointerPrecision) / 5, 0, 1),
      4
    );
    const sampleOrdinal = String(index + 1).padStart(4, '0');
    const expectedAnswer = buildExpectedAnswer(seed, index, taskKind, variant);

    dataset.push({
      id: `pv2-${seed}-${sampleOrdinal}-${hashString(`${taskKind}:${family}:${variant}:${base}`).toString(36)}`,
      seed,
      index,
      taskKind,
      family,
      variant,
      prompt: buildPrompt(taskKind, family, variant, expectedAnswer),
      expectedAnswer,
      decoyAnswers: buildDecoys(expectedAnswer, seed, index),
      expectedHumanSuccessRate: round(clamp(0.975 - difficulty * 0.13 - localeShift * 0.04, 0.8, 0.99), 4),
      medianHumanSolveTimeMs: Math.round(4200 + difficulty * 7300 + localeShift * 1600),
      clientRenderMs: round(7 + spatialEntropy * 20 + temporalEntropy * 13 + decoyDensity * 7, 3),
      serverVerifyMs: round(2.5 + textEntropy * 5 + spatialEntropy * 4 + temporalEntropy * 3, 3),
      payloadBytes: Math.round(960 + textEntropy * 1450 + spatialEntropy * 1550 + temporalEntropy * 1150 + decoyDensity * 850),
      features: {
        textEntropy,
        spatialEntropy,
        temporalEntropy,
        decoyDensity,
        pointerPrecision,
        localeShift,
        difficulty
      }
    });
  }

  return dataset;
}

export function createDefaultSolvers() {
  return [
    makeSolver('ocr-token-scraper', 'ocr', (sample, attempt) => {
      if (sample.taskKind !== 'text-task') return 0.035 + attempt * 0.01;
      return 0.18 - sample.features.textEntropy * 0.1 - sample.features.decoyDensity * 0.055 + attempt * 0.025;
    }),
    makeSolver('cnn-grid-hotspot', 'cnn', (sample, attempt) => {
      if (sample.taskKind !== 'localization') return 0.04 + attempt * 0.008;
      return 0.2 - sample.features.spatialEntropy * 0.11 - sample.features.pointerPrecision * 0.05 + attempt * 0.03;
    }),
    makeSolver('vit-layout-ranker', 'vit', (sample, attempt) => {
      const kindBonus = sample.taskKind === 'localization' ? 0.075 : 0.035;
      return 0.13 + kindBonus - sample.features.spatialEntropy * 0.09 - sample.features.decoyDensity * 0.03 + attempt * 0.022;
    }),
    makeSolver('vlm-instruction-follower', 'vlm', (sample, attempt) => {
      const kindBonus = sample.taskKind === 'text-task' ? 0.08 : sample.taskKind === 'micro-interaction' ? 0.025 : 0.04;
      return 0.12 + kindBonus - sample.features.textEntropy * 0.065 - sample.features.temporalEntropy * 0.035 + attempt * 0.018;
    }),
    makeSolver('gui-agent-replay', 'gui-agent', (sample, attempt) => {
      if (sample.taskKind !== 'micro-interaction') return 0.035 + attempt * 0.012;
      return 0.22 - sample.features.temporalEntropy * 0.13 - sample.features.pointerPrecision * 0.045 + attempt * 0.032;
    })
  ];
}

export function runPerceptionBenchmark({
  dataset,
  profile = 'pr',
  generatedAt = new Date().toISOString(),
  thresholds = undefined,
  solvers = createDefaultSolvers(),
  attempts = createDefaultProfileOptions(profile).attempts
} = {}) {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    throw new Error('dataset must be a non-empty array');
  }
  if (!Array.isArray(solvers) || solvers.length === 0) {
    throw new Error('solvers must be a non-empty array');
  }

  const attemptCount = normalizePositiveInteger(attempts, 'attempts');
  const sampleEvaluations = dataset.map((sample) => evaluateSample(sample, solvers, attemptCount));
  const metrics = aggregateMetrics(dataset, sampleEvaluations);
  const groups = aggregateGroups(dataset, sampleEvaluations);
  const solverResults = aggregateSolvers(dataset, sampleEvaluations, solvers);
  const normalizedThresholds = normalizeThresholds(thresholds, profile);
  const failures = evaluateThresholds(metrics, normalizedThresholds, profile);

  return {
    schemaVersion: 'perception-sealed-redteam-benchmark@v2',
    generatedAt,
    profile,
    status: failures.length === 0 ? 'pass' : 'fail',
    environment: {
      dataSource: 'synthetic-deterministic',
      productionDatabaseRequired: false,
      mlInferenceRequiredInProductionPath: false
    },
    thresholds: normalizedThresholds,
    totals: {
      sampleCount: dataset.length,
      taskKindCount: new Set(dataset.map((sample) => sample.taskKind)).size,
      familyVariantCount: new Set(dataset.map((sample) => groupKey(sample))).size,
      solverCount: solvers.length,
      attemptsPerSolver: attemptCount
    },
    metrics,
    groups,
    solverResults,
    failures
  };
}

export function formatMarkdownReport(report) {
  const failureRows = report.failures.length === 0
    ? '| none | - | - | - | - |\n'
    : report.failures
      .map((failure) => `| ${failure.scope} | ${failure.metric} | ${formatMetric(failure.observed)} | ${failure.operator} | ${formatMetric(failure.threshold)} |`)
      .join('\n') + '\n';

  const groupRows = report.groups
    .map((group) => [
      group.taskKind,
      group.family,
      group.variant,
      group.sampleCount,
      formatRate(group.humanSuccessRate),
      `${Math.round(group.medianSolveTimeMs)} ms`,
      formatRate(group.botSingleTrySuccessRate),
      formatRate(group.botThreeAttemptSuccessRate),
      `${Math.round(group.clientRenderP95Ms)} ms`,
      `${Math.round(group.serverVerifyP99Ms)} ms`,
      `${Math.round(group.payloadP95Bytes)} B`
    ].join(' | '))
    .map((row) => `| ${row} |`)
    .join('\n');

  const solverRows = report.solverResults
    .map((solver) => `| ${solver.name} | ${solver.solverFamily} | ${formatRate(solver.singleTrySuccessRate)} | ${formatRate(solver.threeAttemptSuccessRate)} | ${formatMetric(solver.meanConfidence)} |`)
    .join('\n');

  return [
    `# Perception-Sealed V2 ${report.profile} Red-Team Benchmark`,
    '',
    `Status: **${report.status.toUpperCase()}**`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Samples: ${report.totals.sampleCount}`,
    `- Synthetic data only: ${report.environment.productionDatabaseRequired ? 'no' : 'yes'}`,
    `- Human success: ${formatRate(report.metrics.humanSuccessRate)}`,
    `- Median solve time: ${Math.round(report.metrics.medianSolveTimeMs)} ms`,
    `- Bot single-try success: ${formatRate(report.metrics.botSingleTrySuccessRate)}`,
    `- Bot three-attempt success: ${formatRate(report.metrics.botThreeAttemptSuccessRate)}`,
    `- Client render p95: ${Math.round(report.metrics.clientRenderP95Ms)} ms`,
    `- Server verify p99: ${Math.round(report.metrics.serverVerifyP99Ms)} ms`,
    `- Payload p95: ${Math.round(report.metrics.payloadP95Bytes)} B`,
    '',
    '## Threshold Failures',
    '',
    '| scope | metric | observed | operator | threshold |',
    '| --- | --- | ---: | --- | ---: |',
    failureRows.trimEnd(),
    '',
    '## Solver Regression',
    '',
    '| solver | family | single try | three attempts | mean confidence |',
    '| --- | --- | ---: | ---: | ---: |',
    solverRows,
    '',
    '## Task / Family / Variant Groups',
    '',
    '| task kind | family | variant | samples | human success | median solve | bot single try | bot three attempts | render p95 | verify p99 | payload p95 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    groupRows,
    ''
  ].join('\n');
}

export async function writeBenchmarkReport(report, outputDir) {
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });
  await writeFile(resolve(resolvedOutputDir, 'perception-v2-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(resolvedOutputDir, 'perception-v2-report.md'), formatMarkdownReport(report));
  return {
    json: resolve(resolvedOutputDir, 'perception-v2-report.json'),
    markdown: resolve(resolvedOutputDir, 'perception-v2-report.md')
  };
}

function makeSolver(name, solverFamily, probabilityFor) {
  return {
    name,
    family: solverFamily,
    solve(sample, attemptIndex = 0) {
      const probability = clamp(probabilityFor(sample, attemptIndex), 0.01, 0.42);
      const roll = deterministicUnit(`${sample.id}:${name}:${attemptIndex}`);
      const accepted = roll < probability;
      return {
        accepted,
        answer: accepted ? sample.expectedAnswer : sample.decoyAnswers[attemptIndex % sample.decoyAnswers.length],
        confidence: round(accepted ? 0.58 + probability : 0.18 + probability * 0.7, 4)
      };
    }
  };
}

function evaluateSample(sample, solvers, attempts) {
  const solverAttempts = solvers.map((solver) => {
    const attemptsForSolver = [];
    for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
      const rawResult = solver.solve(sample, attemptIndex);
      attemptsForSolver.push(normalizeSolverResult(sample, rawResult));
    }
    return {
      solverName: solver.name,
      solverFamily: solver.family ?? 'unknown',
      attempts: attemptsForSolver,
      singleTrySuccess: attemptsForSolver[0]?.accepted === true,
      threeAttemptSuccess: attemptsForSolver.some((attempt) => attempt.accepted)
    };
  });

  return {
    sampleId: sample.id,
    solverAttempts,
    botSingleTrySuccess: solverAttempts.some((solver) => solver.singleTrySuccess),
    botThreeAttemptSuccess: solverAttempts.some((solver) => solver.threeAttemptSuccess)
  };
}

function normalizeSolverResult(sample, rawResult) {
  const result = rawResult && typeof rawResult === 'object' ? rawResult : {};
  const answerMatches = result.answer === undefined || result.answer === sample.expectedAnswer;
  return {
    accepted: result.accepted === true && answerMatches,
    answer: typeof result.answer === 'string' ? result.answer : '',
    confidence: Number.isFinite(result.confidence) ? clamp(result.confidence, 0, 1) : 0
  };
}

function aggregateMetrics(dataset, evaluations) {
  return {
    humanSuccessRate: round(mean(dataset.map((sample) => sample.expectedHumanSuccessRate)), 4),
    medianSolveTimeMs: round(quantile(dataset.map((sample) => sample.medianHumanSolveTimeMs), 0.5), 3),
    botSingleTrySuccessRate: round(rate(evaluations, (evaluation) => evaluation.botSingleTrySuccess), 4),
    botThreeAttemptSuccessRate: round(rate(evaluations, (evaluation) => evaluation.botThreeAttemptSuccess), 4),
    clientRenderP95Ms: round(quantile(dataset.map((sample) => sample.clientRenderMs), 0.95), 3),
    serverVerifyP99Ms: round(quantile(dataset.map((sample) => sample.serverVerifyMs), 0.99), 3),
    payloadP95Bytes: round(quantile(dataset.map((sample) => sample.payloadBytes), 0.95), 3)
  };
}

function aggregateGroups(dataset, evaluations) {
  const buckets = new Map();

  for (let index = 0; index < dataset.length; index += 1) {
    const sample = dataset[index];
    const key = groupKey(sample);
    if (!buckets.has(key)) {
      buckets.set(key, {
        taskKind: sample.taskKind,
        family: sample.family,
        variant: sample.variant,
        samples: [],
        evaluations: []
      });
    }

    const bucket = buckets.get(key);
    bucket.samples.push(sample);
    bucket.evaluations.push(evaluations[index]);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      taskKind: bucket.taskKind,
      family: bucket.family,
      variant: bucket.variant,
      sampleCount: bucket.samples.length,
      humanSuccessRate: round(mean(bucket.samples.map((sample) => sample.expectedHumanSuccessRate)), 4),
      medianSolveTimeMs: round(quantile(bucket.samples.map((sample) => sample.medianHumanSolveTimeMs), 0.5), 3),
      botSingleTrySuccessRate: round(rate(bucket.evaluations, (evaluation) => evaluation.botSingleTrySuccess), 4),
      botThreeAttemptSuccessRate: round(rate(bucket.evaluations, (evaluation) => evaluation.botThreeAttemptSuccess), 4),
      clientRenderP95Ms: round(quantile(bucket.samples.map((sample) => sample.clientRenderMs), 0.95), 3),
      serverVerifyP99Ms: round(quantile(bucket.samples.map((sample) => sample.serverVerifyMs), 0.99), 3),
      payloadP95Bytes: round(quantile(bucket.samples.map((sample) => sample.payloadBytes), 0.95), 3)
    }))
    .sort((left, right) =>
      left.taskKind.localeCompare(right.taskKind) ||
      left.family.localeCompare(right.family) ||
      left.variant.localeCompare(right.variant));
}

function aggregateSolvers(dataset, evaluations, solvers) {
  return solvers.map((solver) => {
    const solverEvaluations = evaluations.map((evaluation) =>
      evaluation.solverAttempts.find((candidate) => candidate.solverName === solver.name));
    const allAttempts = solverEvaluations.flatMap((evaluation) => evaluation?.attempts ?? []);

    return {
      name: solver.name,
      solverFamily: solver.family ?? 'unknown',
      sampleCount: dataset.length,
      singleTrySuccessRate: round(rate(solverEvaluations, (evaluation) => evaluation?.singleTrySuccess === true), 4),
      threeAttemptSuccessRate: round(rate(solverEvaluations, (evaluation) => evaluation?.threeAttemptSuccess === true), 4),
      meanConfidence: round(mean(allAttempts.map((attempt) => attempt.confidence)), 4)
    };
  });
}

function evaluateThresholds(metrics, thresholds, profile) {
  const normalized = normalizeThresholds(thresholds, profile);
  const checks = [
    ['humanSuccessRate', metrics.humanSuccessRate, '>=', normalized.minHumanSuccessRate],
    ['medianSolveTimeMs', metrics.medianSolveTimeMs, '<=', normalized.maxMedianSolveTimeMs],
    ['botSingleTrySuccessRate', metrics.botSingleTrySuccessRate, '<=', normalized.maxBotSingleTrySuccessRate],
    ['botThreeAttemptSuccessRate', metrics.botThreeAttemptSuccessRate, '<=', normalized.maxBotThreeAttemptSuccessRate],
    ['clientRenderP95Ms', metrics.clientRenderP95Ms, '<=', normalized.maxClientRenderP95Ms],
    ['serverVerifyP99Ms', metrics.serverVerifyP99Ms, '<=', normalized.maxServerVerifyP99Ms],
    ['payloadP95Bytes', metrics.payloadP95Bytes, '<=', normalized.maxPayloadP95Bytes]
  ];

  return checks
    .filter(([, observed, operator, threshold]) => operator === '>=' ? observed < threshold : observed > threshold)
    .map(([metric, observed, operator, threshold]) => ({
      scope: 'global',
      metric,
      observed,
      operator,
      threshold
    }));
}

function normalizeThresholds(thresholds, profile = 'pr') {
  const defaults = createDefaultThresholds(profile);
  return {
    minHumanSuccessRate: numberOrDefault(thresholds?.minHumanSuccessRate, defaults.minHumanSuccessRate),
    maxBotSingleTrySuccessRate: numberOrDefault(thresholds?.maxBotSingleTrySuccessRate, defaults.maxBotSingleTrySuccessRate),
    maxBotThreeAttemptSuccessRate: numberOrDefault(thresholds?.maxBotThreeAttemptSuccessRate, defaults.maxBotThreeAttemptSuccessRate),
    maxClientRenderP95Ms: numberOrDefault(thresholds?.maxClientRenderP95Ms, defaults.maxClientRenderP95Ms),
    maxServerVerifyP99Ms: numberOrDefault(thresholds?.maxServerVerifyP99Ms, defaults.maxServerVerifyP99Ms),
    maxPayloadP95Bytes: numberOrDefault(thresholds?.maxPayloadP95Bytes, defaults.maxPayloadP95Bytes),
    maxMedianSolveTimeMs: numberOrDefault(thresholds?.maxMedianSolveTimeMs, defaults.maxMedianSolveTimeMs)
  };
}

function buildExpectedAnswer(seed, index, taskKind, variant) {
  const token = hashString(`${seed}:${index}:${taskKind}:${variant}`).toString(36).slice(0, 5);
  if (taskKind === 'localization') {
    const x = 1 + (hashString(`${token}:x`) % 7);
    const y = 1 + (hashString(`${token}:y`) % 5);
    return `cell-${x}-${y}`;
  }
  if (taskKind === 'micro-interaction') {
    return `gesture-${token}`;
  }
  return `phrase-${token}`;
}

function buildPrompt(taskKind, family, variant, expectedAnswer) {
  if (taskKind === 'localization') {
    return `Select ${expectedAnswer} after resolving ${family}/${variant} spatial decoys.`;
  }
  if (taskKind === 'micro-interaction') {
    return `Complete ${expectedAnswer} through the ${family}/${variant} interaction path.`;
  }
  return `Recover ${expectedAnswer} from the ${family}/${variant} text task.`;
}

function buildDecoys(expectedAnswer, seed, index) {
  return [0, 1, 2].map((offset) => `${expectedAnswer}-decoy-${hashString(`${seed}:${index}:decoy:${offset}`).toString(36).slice(0, 4)}`);
}

function groupKey(sample) {
  return `${sample.taskKind}\u0000${sample.family}\u0000${sample.variant}`;
}

function deterministicUnit(input) {
  return hashString(input) / 0xffffffff;
}

function hashString(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(values, predicate) {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function numberOrDefault(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function formatRate(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
