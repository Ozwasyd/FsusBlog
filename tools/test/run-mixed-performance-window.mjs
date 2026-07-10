#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const qpsModes = Object.freeze([
  'view-count-flush', 'visitlog-invalidation', 'cache-hit', 'comment-cursor', 'hotread',
  'cache-miss-singleflight', 'risk-filter', 'related-reading', 'list-pagination',
  'article-detail-miss', 'cache-registry', 'cache-invalidation-batch', 'index-plan'
])

export function buildMixedWindowPlan() {
  return {
    durationMs: 60_000,
    cohorts: {
      baseline: { minimumDurationMs: 30_000, command: 'tools/test/lanes/load-profile.sh baseline' },
      peak: { minimumDurationMs: 60_000, command: 'tools/test/lanes/load-profile.sh expected-peak' },
      burst: { minimumDurationMs: 15_000, command: 'tools/test/lanes/load-profile.sh burst' },
      notification: { minimumDurationMs: 30_000, command: 'npm run check:load:notification-stream-pressure' },
      qps: { modes: [...qpsModes] }
    }
  }
}

function command(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

async function runRepeatedCohort(name, declaration, windowStartedAt) {
  const deadline = windowStartedAt + declaration.minimumDurationMs
  const sampleRoot = path.join(root, `.tmp/perf/mixed-window/${name}`)
  fs.mkdirSync(sampleRoot, { recursive: true })
  let sampleCount = 0
  do {
    await command(declaration.command)
    const profile = name === 'peak' ? 'expected-peak' : name
    const summary = path.join(root, `.tmp/perf/load-${profile}/summary.json`)
    if (!fs.existsSync(summary)) throw new Error(`${name} did not produce ${path.relative(root, summary)}`)
    fs.copyFileSync(summary, path.join(sampleRoot, `${String(sampleCount + 1).padStart(4, '0')}.json`))
    sampleCount += 1
  } while (Date.now() < deadline)
  return { name, minimumDurationMs: declaration.minimumDurationMs, elapsedMs: Date.now() - windowStartedAt, sampleCount }
}

async function runNotification(windowStartedAt, declaration) {
  const frontend = path.join(root, 'src/frontend')
  await command(declaration.command, {
    cwd: frontend,
    env: {
      FSUSBLOG_NOTIFICATION_STREAM_DURATION_MS: String(declaration.minimumDurationMs),
      FSUSBLOG_BASE_URL: process.env.FSUSBLOG_DEBUG_BACKEND_URL,
      PLAYWRIGHT_BASE_URL: process.env.FSUSBLOG_DEBUG_FRONTEND_URL
    }
  })
  return {
    name: 'notification',
    minimumDurationMs: declaration.minimumDurationMs,
    elapsedMs: Date.now() - windowStartedAt,
    sampleCount: 1
  }
}

async function runQps() {
  await Promise.all(qpsModes.map((mode) => command(`tools/test/lanes/backend-qps.sh ${mode}`)))
  await command('tools/test/lanes/backend-qps.sh aggregate')
  return { name: 'qps', modes: [...qpsModes], sampleCount: qpsModes.length }
}

async function main() {
  const plan = buildMixedWindowPlan()
  if (process.argv.includes('--plan')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  const startedAt = Date.now()
  process.env.FSUSBLOG_BASE_URL ||= process.env.FSUSBLOG_DEBUG_BACKEND_URL
  process.env.FSUSBLOG_PUBLIC_BASE_URL ||= process.env.FSUSBLOG_RELEASE_PREVIEW_URL
  process.env.PLAYWRIGHT_BASE_URL ||= process.env.FSUSBLOG_RELEASE_PREVIEW_URL
  await command('cd src/frontend && npm run check:load:public-api', {
    env: {
      FSUSBLOG_BASE_URL: process.env.FSUSBLOG_DEBUG_BACKEND_URL,
      FSUSBLOG_PUBLIC_BASE_URL: process.env.FSUSBLOG_RELEASE_PREVIEW_URL,
      PLAYWRIGHT_BASE_URL: process.env.FSUSBLOG_RELEASE_PREVIEW_URL
    }
  })
  const cohorts = await Promise.all([
    runRepeatedCohort('baseline', plan.cohorts.baseline, startedAt),
    runRepeatedCohort('peak', plan.cohorts.peak, startedAt),
    runRepeatedCohort('burst', plan.cohorts.burst, startedAt),
    runNotification(startedAt, plan.cohorts.notification),
    runQps()
  ])
  const elapsedMs = Date.now() - startedAt
  for (const cohort of cohorts.filter((entry) => entry.minimumDurationMs)) {
    if (cohort.elapsedMs < cohort.minimumDurationMs) {
      throw new Error(`${cohort.name} sampled ${cohort.elapsedMs}ms below ${cohort.minimumDurationMs}ms`)
    }
  }
  if (elapsedMs < plan.durationMs) await new Promise((resolve) => setTimeout(resolve, plan.durationMs - elapsedMs))
  const summary = {
    schema: 'fsusblog.mixed-performance-window.v1',
    status: 'ok',
    executionSource: 'fresh',
    minimumWindowMs: plan.durationMs,
    elapsedMs: Date.now() - startedAt,
    cohorts,
    generatedAt: new Date().toISOString()
  }
  const outFile = path.join(root, '.tmp/perf/mixed-window/summary.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`[mixed-performance-window] elapsedMs=${summary.elapsedMs} cohorts=${cohorts.length}`)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch((error) => {
    console.error(`[mixed-performance-window] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
