#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  assertValidSaturationReport,
  buildSaturationReport,
  readSaturationPolicy
} from './performance-saturation-v2.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(argv) {
  const options = {
    measurements: [],
    requireOk: false,
    policy: path.join(root, 'tests/performance/perf-policy.yml')
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new Error(`${argument} requires a value`)
      return path.resolve(next)
    }
    if (argument === '--identity') options.identity = value()
    else if (argument === '--measurement') options.measurements.push(value())
    else if (argument === '--output') options.output = value()
    else if (argument === '--policy') options.policy = value()
    else if (argument === '--expected-commit') options.expectedCommit = argv[++index]
    else if (argument === '--expected-image-digest') options.expectedImageDigest = argv[++index]
    else if (argument === '--require-ok') options.requireOk = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (!options.identity || !options.output) throw new Error('--identity and --output are required')
  return options
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function buildFromFiles(options) {
  const identity = readJson(options.identity, 'identity')
  const measurements = options.measurements.flatMap((file) => {
    const payload = readJson(file, `measurement ${file}`)
    return Array.isArray(payload) ? payload : [payload]
  })
  const policy = readSaturationPolicy(options.policy).policy
  const report = buildSaturationReport({ identity, measurements, policy })
  assertValidSaturationReport(report, {
    expectedCommit: options.expectedCommit,
    expectedImageDigest: options.expectedImageDigest
  })
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  const temporary = `${options.output}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  fs.renameSync(temporary, options.output)
  return report
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = buildFromFiles(options)
  console.log(`[performance-saturation] wrote ${options.output}; status=${report.status}`)
  if (options.requireOk && report.status !== 'ok') process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[performance-saturation] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
