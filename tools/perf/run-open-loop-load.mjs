#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import {
  createOpenLoopSchedule,
  readSaturationPolicy,
  summarizeOpenLoopAttempts
} from './performance-saturation-v2.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function positiveNumber(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`)
  return parsed
}

export function parseOpenLoopArgs(argv) {
  const options = {
    method: 'GET',
    rates: [],
    durationMs: 30_000,
    repeats: 3,
    timeoutMs: 10_000,
    maxInFlight: 10_000,
    policyFile: path.join(root, 'tests/performance/perf-policy.yml'),
    headers: {}
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new Error(`${argument} requires a value`)
      return next
    }
    if (argument === '--url') options.url = value()
    else if (argument === '--output') options.output = path.resolve(value())
    else if (argument === '--route-id') options.routeId = value()
    else if (argument === '--topology') options.topology = value()
    else if (argument === '--method') options.method = value().toUpperCase()
    else if (argument === '--rates') options.rates = value().split(',').map((item) => positiveNumber(item, 'rate'))
    else if (argument === '--duration-ms') options.durationMs = positiveNumber(value(), 'duration-ms')
    else if (argument === '--repeats') options.repeats = positiveNumber(value(), 'repeats')
    else if (argument === '--timeout-ms') options.timeoutMs = positiveNumber(value(), 'timeout-ms')
    else if (argument === '--max-in-flight') options.maxInFlight = positiveNumber(value(), 'max-in-flight')
    else if (argument === '--policy') options.policyFile = path.resolve(value())
    else if (argument === '--header') {
      const header = value()
      const separator = header.indexOf(':')
      if (separator <= 0) throw new Error('--header requires Name:Value')
      options.headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim()
    } else throw new Error(`unknown argument: ${argument}`)
  }
  if (!options.url || !options.output || !options.routeId) throw new Error('--url, --output and --route-id are required')
  if (!['kestrel-only', 'production-topology'].includes(options.topology)) throw new Error('--topology must be kestrel-only or production-topology')
  if (options.rates.length < 1) throw new Error('--rates requires at least one offered rate')
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error('--repeats must be a positive integer')
  return options
}

function wait(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchAttempt({ url, method, headers, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal })
    const body = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await response.arrayBuffer())
    return {
      completed: true,
      error: !response.ok,
      timeout: false,
      status: response.status,
      responseBytes: body.byteLength,
      latencyMs: performance.now() - startedAt
    }
  } catch (error) {
    const timeoutError = error?.name === 'AbortError'
    return {
      completed: false,
      error: true,
      timeout: timeoutError,
      status: 0,
      responseBytes: 0,
      latencyMs: performance.now() - startedAt,
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runOfferedRate({
  rate,
  durationMs,
  maxInFlight,
  request,
  clock = () => performance.now(),
  sleep = wait
}) {
  const startMs = clock() + 25
  const schedule = createOpenLoopSchedule({ rate, durationMs, startMs })
  const attempts = []
  const pending = new Set()
  for (const dueAt of schedule) {
    await sleep(Math.max(0, dueAt - clock()))
    const scheduleLagMs = Math.max(0, clock() - dueAt)
    if (pending.size >= maxInFlight) {
      attempts.push({ completed: false, dropped: true, error: true, timeout: false, latencyMs: 0, scheduleLagMs })
      continue
    }
    const attempt = { scheduleLagMs }
    attempts.push(attempt)
    const promise = Promise.resolve(request()).then((result) => Object.assign(attempt, result))
      .finally(() => pending.delete(promise))
    pending.add(promise)
  }
  await Promise.allSettled([...pending])
  return attempts
}

export async function runOpenLoopLoad(options) {
  const policy = readSaturationPolicy(options.policyFile).policy
  const samples = []
  for (const rate of options.rates) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const cpuStart = process.cpuUsage()
      const wallStart = performance.now()
      const windowStartedAt = Date.now()
      const attempts = await runOfferedRate({
        rate,
        durationMs: options.durationMs,
        maxInFlight: options.maxInFlight,
        request: () => fetchAttempt(options)
      })
      const wallMs = performance.now() - wallStart
      const cpu = process.cpuUsage(cpuStart)
      const processCpuPercent = (cpu.user + cpu.system) / 1000 / wallMs * 100
      samples.push({
        repeat,
        ...summarizeOpenLoopAttempts({ attempts, durationMs: options.durationMs, processCpuPercent }),
        window: {
          startedAt: new Date(windowStartedAt).toISOString(),
          endedAt: new Date(windowStartedAt + options.durationMs).toISOString()
        }
      })
    }
  }
  return {
    schema: 'fsusblog.open-loop-load.v2',
    evidenceKind: 'real',
    generatedAt: new Date().toISOString(),
    routeId: options.routeId,
    topology: options.topology,
    target: {
      url: options.url,
      method: options.method,
      headerNames: Object.keys(options.headers).sort()
    },
    arrivalModel: 'open-loop-fixed-rate',
    durationMs: options.durationMs,
    repeats: options.repeats,
    offeredRates: [...options.rates],
    policy,
    samples
  }
}

async function main() {
  const options = parseOpenLoopArgs(process.argv.slice(2))
  const report = await runOpenLoopLoad(options)
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  const temporary = `${options.output}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  fs.renameSync(temporary, options.output)
  const generatorBlocked = report.samples.some((sample) => (
    sample.generator.cpuPercent >= report.policy.maximumGeneratorCpuPercent ||
    sample.generator.scheduleLagP99Ms > report.policy.maximumGeneratorScheduleLagP99Ms ||
    sample.generator.droppedArrivals > 0
  ))
  console.log(`[open-loop] wrote ${options.output}; generator=${generatorBlocked ? 'blocked' : 'ok'}`)
  if (generatorBlocked) process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[open-loop] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
