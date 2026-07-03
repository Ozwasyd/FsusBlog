#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import process from 'node:process'

const profile = process.argv[2] || 'default'

function readMemAvailableBytes() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text)
    if (match) {
      return Number(match[1]) * 1024
    }
  } catch {
    // Fall back to os.freemem() on non-Linux hosts.
  }
  return os.freemem()
}

function readCpuTimes() {
  try {
    const [line] = fs.readFileSync('/proc/stat', 'utf8').split('\n')
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'cpu' || parts.length < 5) {
      return null
    }

    const values = parts.slice(1).map((part) => Number(part))
    if (values.some((value) => !Number.isFinite(value))) {
      return null
    }

    const idle = values[3] + (values[4] || 0)
    const total = values.reduce((sum, value) => sum + value, 0)
    return { idle, total }
  } catch {
    return null
  }
}

function sampleCpuBusyCpus(cpus) {
  const before = readCpuTimes()
  if (!before) {
    return null
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)

  const after = readCpuTimes()
  if (!after) {
    return null
  }

  const totalDelta = after.total - before.total
  const idleDelta = after.idle - before.idle
  if (totalDelta <= 0 || idleDelta < 0) {
    return null
  }

  const busyRatio = Math.max(0, Math.min(1, 1 - (idleDelta / totalDelta)))
  return busyRatio * cpus
}

function profilePolicy(name, cpus) {
  if (name === 'ux-viewport-smoke') {
    return {
      memoryPerWorkerGiB: 2.5,
      cpuCap: cpus >= 12 ? 4 : cpus >= 8 ? 3 : cpus >= 4 ? 2 : 1
    }
  }

  if (name === 'visual-public' || name === 'visual-console') {
    return {
      memoryPerWorkerGiB: 4,
      cpuCap: cpus >= 6 ? 2 : 1
    }
  }

  if (name === 'acceptance-spa-routes') {
    return {
      memoryPerWorkerGiB: 4,
      cpuCap: cpus >= 8 ? 2 : 1
    }
  }

  return {
    memoryPerWorkerGiB: 4,
    cpuCap: cpus >= 8 ? 2 : 1
  }
}

const cpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
const memAvailableBytes = readMemAvailableBytes()
const memAvailableGiB = memAvailableBytes / 1024 / 1024 / 1024
const load1 = os.loadavg()[0] || 0
const policy = profilePolicy(profile, cpus)
const memCap = Math.max(1, Math.floor(memAvailableGiB / policy.memoryPerWorkerGiB))
const cpuBusyCpus = sampleCpuBusyCpus(cpus)
const pressureCpus = Number.isFinite(cpuBusyCpus) ? cpuBusyCpus : load1
const pressureCap = Math.max(1, Math.floor(cpus - pressureCpus - 1))
const workers = Math.max(1, Math.min(policy.cpuCap, memCap, pressureCap))

console.error(
  `[playwright-workers] profile=${profile} cpus=${cpus} memAvailableGiB=${memAvailableGiB.toFixed(1)} load1=${load1.toFixed(2)} cpuBusyCpus=${Number.isFinite(cpuBusyCpus) ? cpuBusyCpus.toFixed(2) : 'n/a'} workers=${workers}`
)
process.stdout.write(`${workers}\n`)
