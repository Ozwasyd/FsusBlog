#!/usr/bin/env node
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  completeTransformCache,
  inspectTransformCache,
  invalidateTransformCache,
  openTransformCacheForPerf,
  transformCacheEnvironment
} from './frontend-vitest-transform-cache.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendRoot = path.join(root, 'src/frontend')
const reportFile = path.join(root, '.tmp/test-results/vitest/production/perf-isolated.json')
const ordinaryReportFile = path.join(root, '.tmp/test-results/vitest/production-rolling/merged.json')
const timingEvidenceFile = path.join(root, '.tmp/test-results/vitest/production/perf-isolated-timing.json')
const coverageRoot = path.join(frontendRoot, 'coverage/unit')
let activeChild = null

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function digestDirectory(directory) {
  if (!fs.existsSync(directory)) return null
  const entries = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) entries.push({
        file: path.relative(directory, absolute).replaceAll(path.sep, '/'),
        digest: sha256(fs.readFileSync(absolute))
      })
    }
  }
  visit(directory)
  return sha256(JSON.stringify(entries.sort((left, right) => left.file.localeCompare(right.file))))
}

function canonicalTests(report) {
  return (report.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).map((assertion) => ({
    id: `${path.resolve(file.name).replaceAll(path.sep, '/')}#${assertion.fullName || assertion.title}`,
    status: assertion.status,
    file: path.resolve(file.name).replaceAll(path.sep, '/')
  })))
}

export function validateIsolatedPerfExecution(perfReport, ordinaryReport, coverageBefore, coverageAfter) {
  const perf = canonicalTests(perfReport)
  const ordinary = canonicalTests(ordinaryReport)
  const perfIds = new Set(perf.map((entry) => entry.id))
  const ordinaryIds = new Set(ordinary.map((entry) => entry.id))
  const duplicatePerf = perf.filter((entry, index) => perf.findIndex((candidate) => candidate.id === entry.id) !== index)
  const overlap = [...perfIds].filter((id) => ordinaryIds.has(id))
  if (!perf.length || duplicatePerf.length || overlap.length || perf.some((entry) => entry.status !== 'passed')) {
    throw new Error(`isolated perf exact execution failed: tests=${perf.length} duplicates=${duplicatePerf.length} overlap=${overlap.length}`)
  }
  if (coverageBefore !== coverageAfter) throw new Error('isolated perf modified ordinary Vitest coverage')
  return {
    perfTestIdCount: perf.length,
    ordinaryTestIdCount: ordinary.length,
    exactOnce: true,
    disjointFromOrdinary: true,
    coverageUnchanged: true
    };
}

export function parseTransformCacheDebug(output, { cachePath } = {})
{
    const normalizedCachePath = cachePath
        ? path.resolve(cachePath).replaceAll(path.sep, '/')
        : null;
    const plain = String(output).replaceAll(/\u001b\[[0-9;]*m/gu, '');
    const cacheLines = plain.split(/\r?\n/gu)
        .map((line) => line.replaceAll('\\', '/'))
        .filter((line) => /(?:^|\s)vitest:cache:fs(?:\s|$)/u.test(line)
      && (!normalizedCachePath || line.includes(normalizedCachePath)));
    return {
        hits: cacheLines.filter((line) => line.includes('[read]')).length,
        misses: cacheLines.filter((line) => line.includes('[empty]')).length,
        writes: cacheLines.filter((line) => line.includes('[write]')).length
    };
}

export function requireTransformCacheReuse(stats, { allowSafeRebuild = false } = {}) {
  if (!stats || !Number.isInteger(stats.hits) || stats.hits < 1) {
    if (allowSafeRebuild) {
      const requests = Number(stats?.hits ?? 0) + Number(stats?.misses ?? 0)
      return { ...stats, requests, hitRate: 0, reused: false, safeRebuild: true }
    }
    throw new Error('isolated perf did not reuse any ordinary Vitest transform-cache entry')
  }
  const requests = stats.hits + stats.misses
    return { ...stats, requests, hitRate: requests > 0 ? stats.hits / requests : 0, reused: true, safeRebuild: false };
}

export function validatePerfTiming({
    processStartedAtMs,
    vitestStartedAtMs,
    testStartedAtMs,
    processFinishedAtMs
})
{
    const testStarts = Array.isArray(testStartedAtMs) ? testStartedAtMs.map(Number) : [];
    const firstPerfTestStartedAtMs = testStarts.length > 0 ? Math.min(...testStarts) : Number.NaN;
    const values = {
        processStartedAtMs: Number(processStartedAtMs),
        vitestStartedAtMs: Number(vitestStartedAtMs),
        firstPerfTestStartedAtMs,
        processFinishedAtMs: Number(processFinishedAtMs)
    };
    const invalid = Object.entries(values).filter(([, value]) => !Number.isFinite(value) || value < 0);
    if (invalid.length > 0)
{
        throw new Error(`isolated perf timing is missing or invalid: ${invalid.map(([key]) => key).join(',')}`);
    }
    if (!(values.processStartedAtMs <= values.vitestStartedAtMs
    && values.vitestStartedAtMs <= values.firstPerfTestStartedAtMs
    && values.firstPerfTestStartedAtMs <= values.processFinishedAtMs))
{
        throw new Error('isolated perf timing is not monotonic');
    }
    return {
        ...values,
        coldStartupMs: values.vitestStartedAtMs - values.processStartedAtMs,
        timeToFirstTestMs: values.firstPerfTestStartedAtMs - values.processStartedAtMs,
        wallClockMs: values.processFinishedAtMs - values.processStartedAtMs
    };
}

function runPerf(env)
{
    return new Promise((resolve) =>
{
        const startedAtMs = Date.now();
    const child = spawn('npx', [
      'vitest', 'run', '--config', 'vitest.production.config.ts', '--project=perf'
    ], {
      cwd: frontendRoot,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeChild = child
    const chunks = []
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (chunk) => {
        chunks.push(chunk)
        target.write(chunk)
      })
    }
    child.once('error', (error) => resolve({ code: 1, error, startedAtMs, finishedAtMs: Date.now(), output: Buffer.concat(chunks).toString('utf8') }))
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = null
      resolve({
        code: code ?? 1,
        signal,
        startedAtMs,
        finishedAtMs: Date.now(),
        output: Buffer.concat(chunks).toString('utf8')
      })
    })
  })
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

async function main() {
  const cache = openTransformCacheForPerf()
  let completed = false
  const interrupt = (signal) => {
    if (activeChild?.pid) {
      try {
        process.kill(process.platform === 'win32' ? activeChild.pid : -activeChild.pid, 'SIGTERM')
      } catch {}
    }
    if (!completed) invalidateTransformCache(cache, `perf-${signal.toLowerCase()}`)
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    fs.rmSync(reportFile, { force: true })
    fs.rmSync(timingEvidenceFile, { force: true })
    if (!fs.existsSync(ordinaryReportFile)) throw new Error('ordinary Vitest report is missing before isolated perf')
    const coverageBefore = digestDirectory(coverageRoot)
    const inventoryBefore = inspectTransformCache(cache.cachePath)
    const result = await runPerf({
      ...process.env,
      ...transformCacheEnvironment(cache),
      FSUSBLOG_VITEST_LANE: 'production',
      FSUSBLOG_VITEST_REPORT_ID: 'perf-isolated',
      FSUSBLOG_VITEST_PERF_TRANSFORM_CACHE_CONSUMER: '1',
      DEBUG: [process.env.DEBUG, 'vitest:cache:fs'].filter(Boolean).join(',')
    })
    if (result.code !== 0 || result.signal || result.error) {
      throw result.error ?? new Error(`isolated perf Vitest failed (${result.signal ?? result.code})`)
    }
    const perfReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
        const ordinaryReport = JSON.parse(fs.readFileSync(ordinaryReportFile, 'utf8'));
        const coverageAfter = digestDirectory(coverageRoot);
        const exact = validateIsolatedPerfExecution(perfReport, ordinaryReport, coverageBefore, coverageAfter);
        const timing = validatePerfTiming({
            processStartedAtMs: result.startedAtMs,
            vitestStartedAtMs: perfReport.startTime,
            testStartedAtMs: perfReport.testResults.map((entry) => entry.startTime),
            processFinishedAtMs: result.finishedAtMs
        });
        const cacheReuse = requireTransformCacheReuse(parseTransformCacheDebug(result.output, {
            cachePath: cache.cachePath
        }), {
            allowSafeRebuild: cache.repair.recreatedDirectory || cache.repair.rebuiltEntries > 0
        });
        const evidence = {
      schema: 'fsusblog.frontend-vitest-perf-transform-cache-timing.v1',
      status: 'success',
      schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID,
      sourceState: cache.identity.source,
      cacheIdentity: {
        identityDigest: cache.identity.identityDigest,
        configDigest: cache.identity.configDigest,
        tools: cache.identity.tools,
        environment: cache.identity.environment,
        targetIdentity: cache.identity.targetIdentity
      },
      processIsolation: {
        independentProcess: true,
        ordinaryWorkersSettledBeforeStart: true,
        mutableRuntimeStateReused: false,
        coverageResultReused: false,
        coverageCollectionEnabled: false,
        cacheKeyCompatibilityProviderOnly: true
      },
      cache: {
        ...cacheReuse,
        repair: cache.repair,
                before: inventoryBefore,
                after: inspectTransformCache(cache.cachePath)
            },
            timing,
            execution: exact,
            artifacts: {
                perfReport: path.relative(root, reportFile).replaceAll(path.sep, '/'),
        ordinaryReport: path.relative(root, ordinaryReportFile).replaceAll(path.sep, '/'),
        timingEvidence: path.relative(root, timingEvidenceFile).replaceAll(path.sep, '/')
      }
    }
    atomicWriteJson(timingEvidenceFile, evidence)
    completeTransformCache(cache, evidence.artifacts.timingEvidence)
    completed = true
    console.log(`[frontend-vitest-perf] hits=${evidence.cache.hits} misses=${evidence.cache.misses} timeToFirstTestMs=${evidence.timing.timeToFirstTestMs}`)
  } catch (error) {
    invalidateTransformCache(cache, 'perf-failed')
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
