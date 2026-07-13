#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      return path.resolve(value)
    }
    if (argument === '--load') options.load = next()
    else if (argument === '--metrics') options.metrics = next()
    else if (argument === '--output') options.output = next()
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (!options.load || !options.metrics || !options.output) throw new Error('--load, --metrics and --output are required')
  return options
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function digest(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

export function mergeSaturationMeasurement(load, systemMetrics, sourceDigests = {}) {
  if (load?.schema !== 'fsusblog.open-loop-load.v2' || load?.arrivalModel !== 'open-loop-fixed-rate') {
    throw new Error('load input must be fsusblog.open-loop-load.v2 open-loop evidence')
  }
  if (systemMetrics?.schema !== 'fsusblog.saturation-system-metrics.v2') {
    throw new Error('metrics input must be fsusblog.saturation-system-metrics.v2')
  }
  if (systemMetrics.routeId !== load.routeId || systemMetrics.topology !== load.topology) {
    throw new Error('load and metrics route/topology identity do not match')
  }
  const metricsByKey = new Map(systemMetrics.samples.map((sample) => [
    `${sample.offeredRps}/${sample.repeat}`,
    sample
  ]))
  const samples = load.samples.map((sample) => {
    const key = `${sample.offeredRps}/${sample.repeat}`
    const metricSample = metricsByKey.get(key)
    if (!metricSample) throw new Error(`missing system metrics for ${key}`)
    metricsByKey.delete(key)
    const loadStartedAt = Date.parse(sample?.window?.startedAt)
    const loadEndedAt = Date.parse(sample?.window?.endedAt)
    const metricsStartedAt = Date.parse(metricSample?.window?.startedAt)
    const metricsEndedAt = Date.parse(metricSample?.window?.endedAt)
    if (![loadStartedAt, loadEndedAt, metricsStartedAt, metricsEndedAt].every(Number.isFinite)) {
      throw new Error(`load and system metrics require valid windows for ${key}`)
    }
    if (Math.abs(loadStartedAt - metricsStartedAt) > 1000 || Math.abs(loadEndedAt - metricsEndedAt) > 1000) {
      throw new Error(`load and system metrics windows do not match for ${key}`)
    }
    const { generator: _generator, window: _loadWindow, ...canonicalLoadSample } = sample
    return {
      ...canonicalLoadSample,
      resourceSaturation: metricSample.resourceSaturation,
      metrics: {
        ...metricSample.metrics,
        loadGenerator: {
          cpuPercent: sample.generator.cpuPercent,
          scheduleLagP99Ms: sample.generator.scheduleLagP99Ms,
          droppedArrivals: sample.generator.droppedArrivals
        }
      },
      window: sample.window,
      sourceDigests
    }
  })
  if (metricsByKey.size > 0) throw new Error(`metrics input contains ${metricsByKey.size} unmatched sample(s)`)
  return {
    schema: 'fsusblog.saturation-route-measurement.v2',
    routeId: load.routeId,
    topology: load.topology,
    generatedAt: new Date().toISOString(),
    sourceDigests,
    samples
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = mergeSaturationMeasurement(
    readJson(options.load),
    readJson(options.metrics),
    { load: digest(options.load), systemMetrics: digest(options.metrics) }
  )
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  const temporary = `${options.output}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  fs.renameSync(temporary, options.output)
  console.log(`[performance-saturation] merged ${options.output}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[performance-saturation] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
