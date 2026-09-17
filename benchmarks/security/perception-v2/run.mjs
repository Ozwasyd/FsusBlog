#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  createDefaultProfileOptions,
  createDefaultThresholds,
  generateSyntheticDataset,
  runPerceptionBenchmark,
  writeBenchmarkReport
} from './perception-harness.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const profile = args.profile ?? process.env.FSUSBLOG_PERCEPTION_V2_PROFILE ?? 'pr';
const profileOptions = createDefaultProfileOptions(profile);
const samples = args.samples ?? numberFromEnv('FSUSBLOG_PERCEPTION_V2_SAMPLES') ?? profileOptions.samples;
const seed = args.seed ?? numberFromEnv('FSUSBLOG_PERCEPTION_V2_SEED') ?? 521;
const thresholds = {
  ...createDefaultThresholds(profile),
  ...thresholdOverridesFromEnv(),
  ...thresholdOverridesFromArgs(args)
};
const outputDir = args.out ?? process.env.FSUSBLOG_PERCEPTION_V2_OUT ?? `.tmp/security/perception-v2/${profile}`;

const dataset = generateSyntheticDataset({ seed, samples });
const report = runPerceptionBenchmark({
  dataset,
  profile,
  thresholds,
  attempts: args.attempts ?? profileOptions.attempts
});
const written = await writeBenchmarkReport(report, resolve(outputDir));

console.log(`perception-sealed@v2 ${profile}: ${report.status}`);
console.log(`samples=${report.totals.sampleCount} seed=${seed} solvers=${report.totals.solverCount} attempts=${report.totals.attemptsPerSolver}`);
console.log(`bot_single_try=${formatRate(report.metrics.botSingleTrySuccessRate)} bot_three_attempt=${formatRate(report.metrics.botThreeAttemptSuccessRate)}`);
console.log(`issue_p99_ms=${report.metrics.issueP99Ms} client_render_p95_ms=${report.metrics.clientRenderP95Ms} server_verify_p99_ms=${report.metrics.serverVerifyP99Ms} payload_p95_bytes=${report.metrics.payloadP95Bytes}`);
console.log(`json=${written.json}`);
console.log(`markdown=${written.markdown}`);

if (report.failures.length > 0) {
  for (const failure of report.failures) {
    console.error(`${failure.scope}:${failure.metric} observed=${failure.observed} expected ${failure.operator} ${failure.threshold}`);
  }
}

if (report.status !== 'pass' && args.failOnThreshold !== false) {
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--no-fail-on-threshold') {
      parsed.failOnThreshold = false;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new Error(`missing value for --${rawKey}`);
    }

    switch (rawKey) {
      case 'profile':
        parsed.profile = value;
        break;
      case 'out':
        parsed.out = value;
        break;
      case 'seed':
        parsed.seed = parsePositiveInteger(value, rawKey);
        break;
      case 'samples':
        parsed.samples = parsePositiveInteger(value, rawKey);
        break;
      case 'attempts':
        parsed.attempts = parsePositiveInteger(value, rawKey);
        break;
      case 'min-human-success':
        parsed.minHumanSuccessRate = parseNumber(value, rawKey);
        break;
      case 'max-bot-single-try':
        parsed.maxBotSingleTrySuccessRate = parseNumber(value, rawKey);
        break;
      case 'max-bot-three-attempt':
        parsed.maxBotThreeAttemptSuccessRate = parseNumber(value, rawKey);
        break;
      case 'max-issue-p99-ms':
        parsed.maxIssueP99Ms = parseNumber(value, rawKey);
        break;
      case 'max-client-render-p95-ms':
        parsed.maxClientRenderP95Ms = parseNumber(value, rawKey);
        break;
      case 'max-server-verify-p99-ms':
        parsed.maxServerVerifyP99Ms = parseNumber(value, rawKey);
        break;
      case 'max-payload-p95-bytes':
        parsed.maxPayloadP95Bytes = parseNumber(value, rawKey);
        break;
      case 'max-median-solve-ms':
        parsed.maxMedianSolveTimeMs = parseNumber(value, rawKey);
        break;
      default:
        throw new Error(`unknown argument: --${rawKey}`);
    }
  }
  return parsed;
}

function thresholdOverridesFromArgs(parsed) {
  return compactObject({
    minHumanSuccessRate: parsed.minHumanSuccessRate,
    maxBotSingleTrySuccessRate: parsed.maxBotSingleTrySuccessRate,
    maxBotThreeAttemptSuccessRate: parsed.maxBotThreeAttemptSuccessRate,
    maxIssueP99Ms: parsed.maxIssueP99Ms,
    maxClientRenderP95Ms: parsed.maxClientRenderP95Ms,
    maxServerVerifyP99Ms: parsed.maxServerVerifyP99Ms,
    maxPayloadP95Bytes: parsed.maxPayloadP95Bytes,
    maxMedianSolveTimeMs: parsed.maxMedianSolveTimeMs
  });
}

function thresholdOverridesFromEnv() {
  return compactObject({
    minHumanSuccessRate: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MIN_HUMAN_SUCCESS'),
    maxBotSingleTrySuccessRate: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_BOT_SINGLE_TRY'),
    maxBotThreeAttemptSuccessRate: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_BOT_THREE_ATTEMPT'),
    maxIssueP99Ms: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_ISSUE_P99_MS'),
    maxClientRenderP95Ms: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_CLIENT_RENDER_P95_MS'),
    maxServerVerifyP99Ms: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_SERVER_VERIFY_P99_MS'),
    maxPayloadP95Bytes: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_PAYLOAD_P95_BYTES'),
    maxMedianSolveTimeMs: numberFromEnv('FSUSBLOG_PERCEPTION_V2_MAX_MEDIAN_SOLVE_MS')
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function numberFromEnv(name) {
  if (process.env[name] === undefined || process.env[name] === '') {
    return undefined;
  }
  return parseNumber(process.env[name], name);
}

function parsePositiveInteger(value, name) {
  const raw = String(value).trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNumber(value, name) {
  const raw = String(value).trim();
  if (!/^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
    throw new Error(`${name} must be a number`);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function formatRate(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printHelp() {
  console.log(`Usage: node benchmarks/security/perception-v2/run.mjs [options]

Options:
  --profile pr|nightly
  --samples <count>
  --seed <number>
  --attempts <count>
  --out <directory>
  --min-human-success <rate>
  --max-bot-single-try <rate>
  --max-bot-three-attempt <rate>
  --max-issue-p99-ms <ms>
  --max-client-render-p95-ms <ms>
  --max-server-verify-p99-ms <ms>
  --max-payload-p95-bytes <bytes>
  --max-median-solve-ms <ms>
  --no-fail-on-threshold

Environment overrides use FSUSBLOG_PERCEPTION_V2_* names matching the option names.
`);
}
