import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const resourceUtilizationSchema = 'fsusblog.production.resource-utilization.v1'
export const waitCategories = Object.freeze([
  'dependency-blocked',
  'capacity-blocked',
  'counted-resource-blocked',
  'exclusive-resource-blocked',
  'readiness-marker-blocked',
  'external-service-io-blocked',
  'benchmark-isolation-cooldown'
])

export function resolveResourceSampleIntervalMs({ cpuUnits, benchmark = false } = {}) {
  const machineCpu = Math.max(1, Number(cpuUnits) || os.availableParallelism?.() || os.cpus().length)
  const ordinary = Math.max(100, Math.min(1000, Math.ceil(1000 / Math.sqrt(machineCpu))))
  return benchmark ? Math.max(1000, ordinary * 4) : ordinary
}

const linuxClockTicks = (() => {
  if (process.platform !== 'linux') return null
  const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 })
  const value = Number(result.stdout?.trim())
  return result.status === 0 && Number.isFinite(value) && value > 0 ? value : 100
})()

function finite(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

export function integrateResourceGrantHistory(history, startedAtMs, finishedAtMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) {
    throw new Error('grant integration requires an ordered finite time interval')
  }
  const points = (history ?? []).map((entry) => ({
    atMs: Number(entry.atMs ?? Date.parse(entry.effectiveAt)),
    cpuUnits: Number(entry.cpuUnits),
    memoryGiB: Number(entry.memoryGiB)
  })).filter((entry) => Number.isFinite(entry.atMs)
    && Number.isFinite(entry.cpuUnits) && entry.cpuUnits > 0
    && Number.isFinite(entry.memoryGiB) && entry.memoryGiB > 0)
    .sort((left, right) => left.atMs - right.atMs)
  if (points.length === 0) {
    return { status: 'unavailable', cpuSeconds: null, memoryGiBSeconds: null, segments: [] }
  }
  let current = points[0]
  for (const point of points) {
    if (point.atMs <= startedAtMs) current = point
    else break
  }
  const boundaries = points.filter((point) => point.atMs > startedAtMs && point.atMs < finishedAtMs)
  let cursor = startedAtMs
  let cpuSeconds = 0
  let memoryGiBSeconds = 0
  const segments = []
  for (const next of [...boundaries, { atMs: finishedAtMs }]) {
    const durationMs = Math.max(0, next.atMs - cursor)
    if (durationMs > 0) {
      segments.push({ startedAtMs: cursor, finishedAtMs: next.atMs, durationMs,
        cpuUnits: current.cpuUnits, memoryGiB: current.memoryGiB })
      cpuSeconds += current.cpuUnits * durationMs / 1000
      memoryGiBSeconds += current.memoryGiB * durationMs / 1000
    }
    const replacement = points.findLast((point) => point.atMs <= next.atMs)
    if (replacement) current = replacement
    cursor = next.atMs
  }
  return {
    status: 'measured',
    cpuSeconds: round(cpuSeconds),
    memoryGiBSeconds: round(memoryGiBSeconds),
    segments
  }
}

export function classifyResourceWait(state = {}) {
  state ??= {}
  if (state.readinessMarker) return { category: 'readiness-marker-blocked', detail: state.readinessMarker }
  if (state.dependencies?.length) return { category: 'dependency-blocked', detail: [...state.dependencies].sort() }
  if (state.benchmarkIsolation || state.cooldown) return { category: 'benchmark-isolation-cooldown', detail: state.cooldown ?? 'benchmark-window' }
  if (state.exclusiveResources?.length) return { category: 'exclusive-resource-blocked', detail: [...state.exclusiveResources].sort() }
  if (state.countedResources && Object.keys(state.countedResources).length > 0) {
    return { category: 'counted-resource-blocked', detail: state.countedResources }
  }
  if (state.capacity?.cpu || state.capacity?.memory) return {
    category: 'capacity-blocked',
    detail: { cpu: Boolean(state.capacity.cpu), memory: Boolean(state.capacity.memory) }
  }
  if (state.externalService || state.io) return { category: 'external-service-io-blocked', detail: state.externalService ?? state.io }
  return null
}

export function createWaitLedger(now = () => Date.now()) {
  const open = new Map()
  const intervals = []
  const observe = (ownerId, state, atMs = now()) => {
    const classified = classifyResourceWait(state)
    const previous = open.get(ownerId)
    const key = classified ? JSON.stringify(classified) : null
    if (previous?.key === key) return
    if (previous) {
      intervals.push({ ownerId, category: previous.category, detail: previous.detail,
        startedAtMs: previous.startedAtMs, finishedAtMs: atMs,
        durationMs: Math.max(0, atMs - previous.startedAtMs) })
      open.delete(ownerId)
    }
    if (classified) open.set(ownerId, { ...classified, key, startedAtMs: atMs })
  }
  const finish = (atMs = now()) => {
    for (const ownerId of [...open.keys()]) observe(ownerId, null, atMs)
    const totals = Object.fromEntries(waitCategories.map((category) => [category,
      intervals.filter((entry) => entry.category === category)
        .reduce((total, entry) => total + entry.durationMs, 0)]))
    return { intervals: [...intervals], totalsMs: totals }
  }
  return { observe, finish }
}

function readNumber(file) {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function readProcRecord(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    const fields = stat.slice(end + 2).split(' ')
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8')
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    const statusValue = (name) => finite(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'mu'))?.[1])
    const ioValue = (name) => finite(io.match(new RegExp(`^${name}:\\s+(\\d+)`, 'mu'))?.[1])
    return {
      pid,
      userSeconds: Number(fields[11]) / linuxClockTicks,
      systemSeconds: Number(fields[12]) / linuxClockTicks,
      rssBytes: Number(fields[21]) * os.constants.sysconf?.PAGESIZE || Number(fields[21]) * 4096,
      readBytes: ioValue('read_bytes'),
      writeBytes: ioValue('write_bytes'),
      voluntaryContextSwitches: statusValue('voluntary_ctxt_switches'),
      involuntaryContextSwitches: statusValue('nonvoluntary_ctxt_switches'),
      browserProcess: /(?:^|[ /])(?:chromium|chrome|firefox|webkit)(?:[ /-]|$)/iu.test(commandLine)
    }
  } catch {
    return null
  }
}

function childrenOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
      .split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger)
  } catch {
    return []
  }
}

function processTree(rootPid) {
  const pending = [rootPid]
  const seen = new Set()
  while (pending.length > 0) {
    const pid = pending.pop()
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    pending.push(...childrenOf(pid))
  }
  return [...seen]
}

export function measureResourceCollectorOverhead({ iterations } = {}) {
  if (process.platform !== 'linux') {
    return { status: 'unsupported', iterations: null, baselineNs: null, observedNs: null, addedNs: null }
  }
  const count = Math.max(3, Math.min(32,
    Math.floor(Number(iterations) || Math.sqrt(os.availableParallelism?.() ?? os.cpus().length) * 2)))
  const baselineStarted = process.hrtime.bigint()
  for (let index = 0; index < count; index += 1) process.hrtime.bigint()
  const baselineNs = Number(process.hrtime.bigint() - baselineStarted)
  const observedStarted = process.hrtime.bigint()
  for (let index = 0; index < count; index += 1) {
    processTree(process.pid).map(readProcRecord).filter(Boolean)
  }
  const observedNs = Number(process.hrtime.bigint() - observedStarted)
  return {
    status: 'measured',
    iterations: count,
    baselineNs,
    observedNs,
    addedNs: Math.max(0, observedNs - baselineNs),
    addedNsPerSample: Math.max(0, observedNs - baselineNs) / count,
    measuredAt: new Date().toISOString()
  }
}

export function createLinuxProcessTreeCollector({ rootPid, grantProvider, sampleIntervalMs, now = () => Date.now() }) {
  const startedAtMs = now()
  const resolvedSampleIntervalMs = Number.isFinite(Number(sampleIntervalMs)) && Number(sampleIntervalMs) > 0
    ? Number(sampleIntervalMs)
    : resolveResourceSampleIntervalMs()
  const supported = process.platform === 'linux' && Number.isInteger(rootPid) && rootPid > 0
  const firstByPid = new Map()
  const lastByPid = new Map()
  const observedPids = new Set()
  const observedBrowserPids = new Set()
  const samples = []
  const maxCurveSamples = Math.max(256, Math.min(4096,
    Math.ceil((os.availableParallelism?.() ?? os.cpus().length) * 256)))
  const grantHistory = []
  const overheadStart = process.resourceUsage()
  let timer = null
  let previousGrantKey = null
  let rssAreaByteMs = 0
  let previousRssBytes = null
  let previousSampleAtMs = null
  let peakRssBytes = null
  let compactionCount = 0
  let peakBrowserProcessCount = 0
  const sample = () => {
    const sampleStarted = process.hrtime.bigint()
    const atMs = now()
    const records = supported ? processTree(rootPid).map(readProcRecord).filter(Boolean) : []
    for (const record of records) {
      observedPids.add(record.pid)
      if (record.browserProcess) observedBrowserPids.add(record.pid)
      if (!firstByPid.has(record.pid)) firstByPid.set(record.pid, record)
      lastByPid.set(record.pid, record)
    }
    const grant = grantProvider?.()
    if (grant && Number.isFinite(Number(grant.cpuUnits)) && Number(grant.cpuUnits) > 0) {
      const normalized = { atMs, effectiveAt: new Date(atMs).toISOString(),
        cpuUnits: Number(grant.cpuUnits), memoryGiB: Number(grant.memoryGiB) }
      const key = `${normalized.cpuUnits}/${normalized.memoryGiB}`
      if (key !== previousGrantKey) grantHistory.push(normalized)
      previousGrantKey = key
    }
    const aggregate = (key) => records.reduce((total, record) => total + (Number(record[key]) || 0), 0)
    const rssBytes = aggregate('rssBytes')
    const browserProcessCount = records.filter((record) => record.browserProcess).length
    peakBrowserProcessCount = Math.max(peakBrowserProcessCount, browserProcessCount)
    if (previousSampleAtMs !== null && previousRssBytes !== null) {
      rssAreaByteMs += previousRssBytes * Math.max(0, atMs - previousSampleAtMs)
    }
    previousSampleAtMs = atMs
    previousRssBytes = rssBytes
    peakRssBytes = peakRssBytes === null ? rssBytes : Math.max(peakRssBytes, rssBytes)
    if (samples.length >= maxCurveSamples) {
      const compacted = samples.filter((_, index) => index % 2 === 0)
      samples.splice(0, samples.length, ...compacted)
      compactionCount += 1
    }
    samples.push({ atMs, processCount: records.length, browserProcessCount,
      userSeconds: round(aggregate('userSeconds')), systemSeconds: round(aggregate('systemSeconds')),
      rssBytes, readBytes: aggregate('readBytes'), writeBytes: aggregate('writeBytes'),
      collectionNs: Number(process.hrtime.bigint() - sampleStarted) })
  }
  sample()
  if (supported) {
    timer = setInterval(sample, Math.max(25, resolvedSampleIntervalMs))
    timer.unref?.()
  }
  return {
    stop({ gnuTime = null } = {}) {
      if (timer) clearInterval(timer)
      sample()
      const finishedAtMs = now()
      const grant = integrateResourceGrantHistory(grantHistory, startedAtMs, finishedAtMs)
      const processDelta = (key) => {
        if (!supported) return null
        let total = 0
        let measured = false
        for (const [pid, lastRecord] of lastByPid) {
          const firstRecord = firstByPid.get(pid)
          if (!Number.isFinite(firstRecord?.[key]) || !Number.isFinite(lastRecord?.[key])) continue
          total += Math.max(0, lastRecord[key] - firstRecord[key])
          measured = true
        }
        return measured ? total : null
      }
      const cpuUserSeconds = supported ? (finite(gnuTime?.userSeconds) ?? processDelta('userSeconds')) : null
      const cpuSystemSeconds = supported ? (finite(gnuTime?.systemSeconds) ?? processDelta('systemSeconds')) : null
      const overheadEnd = process.resourceUsage()
      const collectorCpuSeconds = ((overheadEnd.userCPUTime - overheadStart.userCPUTime)
        + (overheadEnd.systemCPUTime - overheadStart.systemCPUTime)) / 1e6
      const actualCpuSeconds = cpuUserSeconds === null || cpuSystemSeconds === null
        ? null : cpuUserSeconds + cpuSystemSeconds
      return {
        status: supported ? 'measured' : 'unsupported',
        platform: process.platform,
        startedAtMs,
        finishedAtMs,
        wallSeconds: round((finishedAtMs - startedAtMs) / 1000),
        cpuUserSeconds: round(cpuUserSeconds),
        cpuSystemSeconds: round(cpuSystemSeconds),
        actualCpuSeconds: round(actualCpuSeconds),
        grantedCpuSeconds: grant.cpuSeconds,
        grantedMemoryGiBSeconds: grant.memoryGiBSeconds,
        cpuGrantEfficiency: actualCpuSeconds === null || !Number.isFinite(grant.cpuSeconds) || grant.cpuSeconds <= 0
          ? null : round(actualCpuSeconds / grant.cpuSeconds),
        peakRssBytes: peakRssBytes === null ? finite(gnuTime?.peakRssBytes) : Math.max(peakRssBytes, finite(gnuTime?.peakRssBytes) ?? 0),
        averageRssBytes: finishedAtMs > startedAtMs ? round(rssAreaByteMs / (finishedAtMs - startedAtMs)) : null,
        readBytes: processDelta('readBytes'),
        writeBytes: processDelta('writeBytes'),
        voluntaryContextSwitches: finite(gnuTime?.voluntaryContextSwitches),
        involuntaryContextSwitches: finite(gnuTime?.involuntaryContextSwitches),
        processSpawnCount: supported ? observedPids.size : null,
        processSpawnCountStatus: supported ? 'sampled-lower-bound' : 'unsupported',
        browserProcessCount: supported ? observedBrowserPids.size : null,
        peakBrowserProcessCount: supported ? peakBrowserProcessCount : null,
        browserProcessCountStatus: supported ? 'sampled-lower-bound' : 'unsupported',
        exitedProcessAccounting: gnuTime ? 'kernel-rusage-including-descendants' : 'sampled',
        grantHistory,
        samples,
        collector: {
          sampleIntervalMs: supported ? Math.max(25, resolvedSampleIntervalMs) : null,
          sampleCount: samples.length,
          rawSampleCompactions: compactionCount,
          maximumRetainedCurveSamples: maxCurveSamples,
          cpuSeconds: round(collectorCpuSeconds),
          cpuOverheadRatio: finishedAtMs === startedAtMs ? null : round(collectorCpuSeconds / ((finishedAtMs - startedAtMs) / 1000)),
          collectionCpuNs: samples.reduce((sum, entry) => sum + entry.collectionNs, 0)
        }
      }
    }
  }
}

export function parseGnuTimeReport(file) {
  try {
    const values = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index), Number(line.slice(index + 1))]
    }))
    return {
      userSeconds: finite(values.user_seconds), systemSeconds: finite(values.system_seconds),
      peakRssBytes: finite(values.max_rss_kib) === null ? null : values.max_rss_kib * 1024,
      voluntaryContextSwitches: finite(values.voluntary_context_switches),
      involuntaryContextSwitches: finite(values.involuntary_context_switches),
      fileSystemInputs: finite(values.file_system_inputs), fileSystemOutputs: finite(values.file_system_outputs)
    }
  } catch {
    return null
  }
}

export const gnuTimeFormat = [
  'user_seconds=%U', 'system_seconds=%S', 'max_rss_kib=%M',
  'voluntary_context_switches=%w', 'involuntary_context_switches=%c',
  'file_system_inputs=%I', 'file_system_outputs=%O'
].join('\\n')

export function validateResourceUtilizationBinding(evidence, expected) {
  const errors = []
  if (evidence?.schema !== resourceUtilizationSchema) errors.push('schema mismatch')
  if (evidence?.runId !== expected.runId) errors.push('runId mismatch')
  if (evidence?.sourceState?.commit !== expected.sourceState?.commit
    || evidence?.sourceState?.worktreeFingerprint !== expected.sourceState?.worktreeFingerprint) errors.push('sourceState mismatch')
  if (Number(evidence?.checkpoint?.revision) !== Number(expected.checkpoint?.revision)) errors.push('checkpoint revision mismatch')
  return errors
}

export function writeResourceUtilizationEvidence(file, evidence, expected) {
  const document = { schema: resourceUtilizationSchema, observeOnly: true, ...evidence }
  const errors = validateResourceUtilizationBinding(document, expected)
  if (errors.length) throw new Error(`resource utilization evidence binding rejected: ${errors.join('; ')}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
  fs.renameSync(temporary, file)
  return document
}
