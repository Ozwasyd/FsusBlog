#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { collectStaleProductionBuildRoots, validateProductionRunId } from './production-build-layout.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultByteBudget = 16 * 1024 * 1024 * 1024
const defaultInodeBudget = 500_000

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseManagedBuildGcArgs(args) {
  const options = {
    root: defaultRoot,
    currentRunId: null,
    byteBudget: defaultByteBudget,
    inodeBudget: defaultInodeBudget,
    dryRun: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--root') options.root = path.resolve(args[++index])
    else if (argument === '--current-run') options.currentRunId = validateProductionRunId(args[++index])
    else if (argument === '--byte-budget') options.byteBudget = positiveInteger(args[++index], '--byte-budget')
    else if (argument === '--inode-budget') options.inodeBudget = positiveInteger(args[++index], '--inode-budget')
    else if (argument === '--dry-run') options.dryRun = true
    else throw new Error(`unknown managed production build GC option: ${argument}`)
  }
  if (!options.currentRunId) throw new Error('--current-run is required')
  return options
}

function writeReport(root, runId, report) {
  const reportDirectory = path.join(root, '.tmp/release-evidence/build-gc')
  fs.mkdirSync(reportDirectory, { recursive: true })
  const reportFile = path.join(reportDirectory, `${runId}.json`)
  const temporary = `${reportFile}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, reportFile)
  return reportFile
}

export function executeManagedProductionBuildGc(options) {
  const startedAt = new Date().toISOString()
  const roots = []
  const consumed = { byteCount: 0, inodeCount: 0 }
  let failure = null
  let collection = null
  try {
    const collectRoots = options.collectRoots ?? collectStaleProductionBuildRoots
    collection = collectRoots({
      root: options.root,
      currentRunId: options.currentRunId,
      allowDelete(observation) {
        if (options.dryRun) return false
        const nextBytes = consumed.byteCount + observation.size.byteCount
        const nextInodes = consumed.inodeCount + observation.size.inodeCount
        if (nextBytes > options.byteBudget || nextInodes > options.inodeBudget) return false
        consumed.byteCount = nextBytes
        consumed.inodeCount = nextInodes
        return true
      },
      onRoot(observation) {
        roots.push(structuredClone(observation))
      }
    })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const acceptedDecisions = new Set(['delete-stale-complete', 'retain-current-run', 'retain-active-owner'])
  const status = failure === null && !options.dryRun && roots.every((root) => acceptedDecisions.has(root.decision))
    ? 'success'
    : 'failure'
  const report = {
    schema: 'fsusblog.managed-production-build-gc-receipt.v1',
    status,
    failureClass: status === 'success' ? null : 'infra.build-gc',
    mode: options.dryRun ? 'dry-run' : 'execute',
    currentRunId: options.currentRunId,
    targetRoots: [path.join(path.resolve(options.root), '.tmp/build')],
    resourceBudget: {
      byteBudget: options.byteBudget,
      inodeBudget: options.inodeBudget,
      consumedByteCount: collection?.reclaimed?.byteCount ?? 0,
      consumedInodeCount: collection?.reclaimed?.inodeCount ?? 0
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    roots,
    summary: collection ?? { removed: [], retained: [], reclaimed: { byteCount: 0, inodeCount: 0 }, durationMs: null },
    failure
  }
  return report
}

function main() {
  const options = parseManagedBuildGcArgs(process.argv.slice(2))
  const report = executeManagedProductionBuildGc(options)
  const reportFile = writeReport(options.root, options.currentRunId, report)
  process.stdout.write(`${JSON.stringify({ status: report.status, reportFile })}\n`)
  if (report.status !== 'success') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
