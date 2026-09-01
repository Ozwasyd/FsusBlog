#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  buildLegacyRealDumpMembership,
  buildLegacyRealDumpOutcome,
  legacyRealDumpContract,
  parseLegacyRealDumpTrx,
  validateLegacyRealDumpPreflight,
  validateLegacyRealDumpRuntimeEvidence,
  writeJson
} from './legacy-real-dump-contract.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options
  })
  if (result.error) throw result.error
  return result
}

function commandOutput(command, args, label) {
  const result = run(command, args)
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr ?? '').trim() || `exit ${result.status}`}`)
  }
  return String(result.stdout ?? '').trim()
}

function main() {
  const outputRoot = path.resolve(
    process.env.FSUS_LEGACY_20260517_EVIDENCE_DIR
      ?? path.join(root, '.tmp/test-results/backend/legacy-20260517-real-dump')
  )
  fs.mkdirSync(outputRoot, { recursive: true })
  for (const name of ['membership-plan.json', 'legacy-20260517-real-dump.trx', 'semantic-outcome.json']) {
    fs.rmSync(path.join(outputRoot, name), { force: true })
  }
  writeJson(
    path.join(outputRoot, 'membership-plan.json'),
    buildLegacyRealDumpMembership(legacyRealDumpContract.producerId)
  )

  const currentSourceSha = commandOutput('git', ['rev-parse', 'HEAD'], 'source identity')
  const currentWorktreeStatus = commandOutput(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    'worktree identity'
  )
  const identity = validateLegacyRealDumpPreflight({
    env: process.env,
    repositoryRoot: root,
    currentSourceSha,
    currentWorktreeStatus,
    inspectImage: (image) => commandOutput(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', image],
      'PostgreSQL image inspection'
    )
  })
  const trxPath = path.join(outputRoot, 'legacy-20260517-real-dump.trx')
  const filter = `FullyQualifiedName=${legacyRealDumpContract.fullyQualifiedName}&Fixture=${legacyRealDumpContract.fixture}`
  const result = run('dotnet', [
    'test',
    'tests/backend/FsusBlog.Server.Tests.csproj',
    '--filter', filter,
    '--logger', `trx;LogFileName=${trxPath}`
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FSUS_ENABLE_LEGACY_DUMP_TESTS: '1',
      FSUS_LEGACY_20260517_DUMP: identity.dumpPath,
      FSUS_LEGACY_20260517_DUMP_SHA256: identity.dumpSha256,
      FSUSBLOG_TEST_SOURCE_COMMIT: identity.sourceSha,
      FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE: identity.postgresImage,
      FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID: identity.postgresImageId
    }
  })
  if (!fs.existsSync(trxPath)) throw new Error('dedicated real-dump producer did not emit its TRX report')
  const parsed = parseLegacyRealDumpTrx(fs.readFileSync(trxPath, 'utf8'))
  if (parsed.outcome === 'Passed') validateLegacyRealDumpRuntimeEvidence(parsed.runtimeEvidence, identity)
  const outcome = buildLegacyRealDumpOutcome({ identity, result: parsed })
  writeJson(path.join(outputRoot, 'semantic-outcome.json'), outcome)
  if (result.status !== 0 || parsed.outcome !== 'Passed') {
    throw new Error(`dedicated real-dump test failed with dotnet exit ${result.status}`)
  }
  process.stdout.write(`[legacy-real-dump-producer] passed evidence=${path.relative(root, outputRoot)}\n`)
}

try {
  main()
} catch (error) {
  console.error(`[legacy-real-dump-producer] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
