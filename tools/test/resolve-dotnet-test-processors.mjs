#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

function configuredProcessorCount(env) {
  const parsed = Number.parseInt(String(
    env.FSUSBLOG_DOTNET_TEST_PROCESSORS
      ?? env.DOTNET_PROCESSOR_COUNT
      ?? ''
  ), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(2, parsed) : null
}

export function resolveDotnetTestProcessorCount({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  load1 = os.loadavg()[0] ?? 0
} = {}) {
  const configured = configuredProcessorCount(env)
  if (configured) return configured

  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const freeMemory = Math.max(0, Number(freeMemoryBytes) || 0)
  const currentLoad = Math.max(0, Number(load1) || 0)
  const lowResource = cpus < 4
    || freeMemory < 6 * 1024 ** 3
    || currentLoad >= Math.max(1, cpus - 1)
  return lowResource ? 1 : 2
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  process.stdout.write(`${resolveDotnetTestProcessorCount()}\n`)
}
