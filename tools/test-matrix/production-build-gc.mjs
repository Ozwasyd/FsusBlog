#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { collectStaleProductionBuildRoots } from './production-build-layout.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(args) {
  const options = { root: defaultRoot, currentRunId: null }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--root') options.root = path.resolve(args[++index])
    else if (argument === '--current-run') options.currentRunId = args[++index]
    else throw new Error(`unknown production build GC option: ${argument}`)
  }
  if (!options.currentRunId) throw new Error('--current-run is required')
  return options
}

const options = parseArgs(process.argv.slice(2))
const report = {
  schema: 'fsusblog.production-build-gc.v1',
  currentRunId: options.currentRunId,
  generatedAt: new Date().toISOString(),
  ...collectStaleProductionBuildRoots({
    root: options.root,
    currentRunId: options.currentRunId
  })
}
const reportDirectory = path.join(options.root, '.tmp/build-gc')
fs.mkdirSync(reportDirectory, { recursive: true })
const reportFile = path.join(reportDirectory, `${options.currentRunId}.json`)
const temporary = `${reportFile}.next-${process.pid}`
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
fs.renameSync(temporary, reportFile)
