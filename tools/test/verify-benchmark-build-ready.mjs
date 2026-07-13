#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { digestDeclaredOutputs } from '../test-matrix/local-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
if (!runId) throw new Error('FSUSBLOG_TEST_RUN_ID is required')

const markerFile = path.join(root, '.tmp/test-runs', runId, 'benchmark-build-ready.json')
if (!fs.existsSync(markerFile)) throw new Error(`benchmark readiness marker is missing for ${runId}`)
const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
if (marker?.schema !== 'fsusblog.local-production.benchmark-build-ready.v1'
  || marker.status !== 'success'
  || marker.physicalBundleId !== 'backend-tests'
  || marker.schedulerRunId !== runId) {
  throw new Error(`benchmark readiness marker is not bound to the current fresh backend bundle: ${runId}`)
}
const declaration = String(marker.benchmarkDll?.path ?? '')
if (!declaration || marker.benchmarkDll?.digest !== digestDeclaredOutputs(root, [declaration])[declaration]) {
  throw new Error(`benchmark readiness artifact digest is invalid: ${declaration || '<missing>'}`)
}
console.log(`[benchmark-build-ready] verified run=${runId} artifact=${declaration}`)
