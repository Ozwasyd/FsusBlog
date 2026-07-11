#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { writeJsonAtomic } from './release-assets.mjs'
import { executeReleaseAssetGc, RELEASE_GC_EVIDENCE_SCHEMA } from './release-gc.mjs'

let options = {}
try {
  options = parseArgs(process.argv.slice(2))
  const storeDirectory = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
  const stateFile = path.resolve(options.state ?? process.env.FSUSBLOG_RELEASE_RETENTION_STATE ?? path.join(storeDirectory, 'retention-state.json'))
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const evidence = executeReleaseAssetGc({
    storeDirectory,
    state,
    apply: options.apply === true,
    evidenceFile: options.out ? path.resolve(options.out) : null,
    lockFile: options.lock ? path.resolve(options.lock) : null
  })
  process.stdout.write(`${JSON.stringify({ ...evidence, retentionState: stateFile })}\n`)
} catch (error) {
  const report = {
    schema: RELEASE_GC_EVIDENCE_SCHEMA,
    status: 'fail',
    dryRun: options.apply !== true,
    releaseActions: [],
    objectActions: [],
    errors: [error instanceof Error ? error.message : String(error)]
  }
  if (options.out) {
    try { writeJsonAtomic(path.resolve(options.out), report) } catch {}
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--apply') {
      parsed.apply = true
      continue
    }
    if (name === '--dry-run') {
      parsed.apply = false
      continue
    }
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    parsed[name.slice(2)] = value
    index += 1
  }
  return parsed
}
