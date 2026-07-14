#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { validateRuntimeMatrixEvidence } from './runtime-publish-evidence.mjs'

try {
  const file = optionValue('--evidence')
  if (!file) throw new Error('missing --evidence')
  const resolved = path.resolve(file)
  const evidence = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const allowPartial = process.argv.includes('--allow-partial')
  const errors = validateRuntimeMatrixEvidence(evidence, {
    requireComplete: !allowPartial,
    expectedSelectedProfileId: optionValue('--expected-profile-id'),
    expectedProfileManifestDigest: optionValue('--expected-profile-manifest-digest'),
    expectedProfileDigest: optionValue('--expected-profile-digest')
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(JSON.stringify({ status: 'ok', evidence: resolved, matrixStatus: evidence.status, runs: evidence.runs.length }))
} catch (error) {
  console.error(`[check-runtime-publish-evidence] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
