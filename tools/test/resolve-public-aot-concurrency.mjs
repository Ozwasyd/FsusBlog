#!/usr/bin/env node

import os from 'node:os'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

function positiveNumber(value) {
  if (value === undefined || String(value).trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function firstPositive(env, names) {
  for (const name of names) {
    const value = positiveNumber(env[name])
    if (value !== undefined) return value
  }
  return undefined
}

export function resolvePublicAotConcurrency({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryGiB = os.freemem() / 1024 ** 3,
  workersPerCpu = 1,
  memoryPerWorkerGiB = 0.5,
  maximum = cpuCount
} = {}) {
  const physicalCpu = Math.max(1, Math.floor(positiveNumber(cpuCount) ?? 1))
  const cpuGrant = Math.min(physicalCpu, firstPositive(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ]) ?? physicalCpu)
  const memoryGrantGiB = firstPositive(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ]) ?? Math.max(0.125, positiveNumber(freeMemoryGiB) ?? 0.125)
  const normalizedFanout = Math.max(1, Math.floor(positiveNumber(workersPerCpu) ?? 1))
  const normalizedMemory = Math.max(0.125, positiveNumber(memoryPerWorkerGiB) ?? 0.5)
  const normalizedMaximum = Math.max(1, Math.floor(positiveNumber(maximum) ?? physicalCpu))
  const cpuCap = Math.max(1, Math.floor(cpuGrant * normalizedFanout))
  const memoryCap = Math.max(1, Math.floor(memoryGrantGiB / normalizedMemory))
  return Math.min(normalizedMaximum, physicalCpu, cpuCap, memoryCap)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdout.write(`${resolvePublicAotConcurrency()}\n`)
}
