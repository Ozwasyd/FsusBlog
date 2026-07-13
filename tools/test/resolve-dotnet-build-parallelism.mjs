#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveManifestWorkers } from './run-command-manifest.mjs'

export function resolveDotnetBuildParallelism(options = {}) {
  return resolveManifestWorkers(options)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  process.stdout.write(`${resolveDotnetBuildParallelism()}\n`)
}
