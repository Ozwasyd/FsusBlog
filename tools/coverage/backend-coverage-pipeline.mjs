#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sidecarName = 'coverage.identity.json'
const rawName = 'coverage.json'

function fail(message) {
  throw new Error(message)
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function normalizedRelative(file) {
  return path.relative(repositoryRoot, file).replaceAll(path.sep, '/')
}

export function normalizeCoverageSourcePath(value) {
  let normalized = String(value ?? '').replaceAll('\\', '/')
  normalized = normalized.replace(/^[A-Za-z]:/u, '')
  const repositoryMarker = normalized.toLowerCase().lastIndexOf('/fsusblog/')
  if (repositoryMarker >= 0) normalized = normalized.slice(repositoryMarker + '/fsusblog/'.length)
  else {
    const sourceMarker = normalized.search(/\/(?:src|tests|benchmarks)\//u)
    if (sourceMarker >= 0) normalized = normalized.slice(sourceMarker + 1)
  }
  normalized = path.posix.normalize(normalized).replace(/^\.\/+/u, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`coverage source path is not normalizable: ${value}`)
  }
  return normalized
}

function parseRawBytes(bytes, label) {
  let payload
  try {
    payload = JSON.parse(bytes)
  } catch (error) {
    fail(`${label} is corrupt JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    fail(`${label} must contain a Coverlet JSON object`)
  }
  const modules = Object.keys(payload).sort()
  if (modules.length === 0) fail(`${label} contains no modules`)
  const sources = new Set()
  for (const [moduleName, documents] of Object.entries(payload)) {
    if (!moduleName || !documents || Array.isArray(documents) || typeof documents !== 'object') {
      fail(`${label} contains an invalid module entry`)
    }
    for (const [sourceName, classes] of Object.entries(documents)) {
      sources.add(normalizeCoverageSourcePath(sourceName))
      if (!classes || Array.isArray(classes) || typeof classes !== 'object') {
        fail(`${label} contains invalid classes for ${sourceName}`)
      }
      for (const [className, methods] of Object.entries(classes)) {
        if (!className || !methods || Array.isArray(methods) || typeof methods !== 'object') {
          fail(`${label} contains invalid methods for ${sourceName}`)
        }
        for (const [methodName, coverage] of Object.entries(methods)) {
          if (!methodName || !coverage || Array.isArray(coverage) || typeof coverage !== 'object') {
            fail(`${label} contains invalid coverage for ${methodName || '<missing>'}`)
          }
          if (!coverage.Lines || Array.isArray(coverage.Lines) || typeof coverage.Lines !== 'object') {
            fail(`${label} method ${methodName} is missing line identity`)
          }
          if (!Array.isArray(coverage.Branches)) {
            fail(`${label} method ${methodName} is missing branch identity`)
          }
          for (const [line, hits] of Object.entries(coverage.Lines)) {
            if (!/^\d+$/u.test(line) || !Number.isFinite(Number(hits)) || Number(hits) < 0) {
              fail(`${label} contains an invalid line hit count`)
            }
          }
          for (const branch of coverage.Branches) {
            for (const key of ['Line', 'Offset', 'EndOffset', 'Path', 'Ordinal', 'Hits']) {
              if (!Number.isFinite(Number(branch?.[key])) || Number(branch[key]) < 0) {
                fail(`${label} contains an invalid branch ${key}`)
              }
            }
          }
        }
      }
    }
  }
  if (sources.size === 0) fail(`${label} contains no source files`)
  return { payload, modules, sources: [...sources].sort() }
}

function walk(directory, predicate) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file, predicate) : (predicate(file) ? [file] : [])
  })
}

function serializedTransportRoot(directory, file) {
  const relativeParts = path.relative(directory, file).split(path.sep)
  if (relativeParts.length === 4
    && relativeParts[0].startsWith('_')
    && relativeParts[1] === 'In'
    && relativeParts[2]
    && relativeParts[3] === rawName) {
    return path.join(directory, relativeParts[0])
  }
  let current = path.dirname(file)
  while (current !== directory && current.startsWith(`${directory}${path.sep}`)) {
    if (path.basename(current).startsWith('_ser')) return current
    current = path.dirname(current)
  }
  return null
}

function locateCanonicalRaw(directory, { pruneSerializedCopies = true } = {}) {
  const reports = walk(directory, (file) => path.basename(file) === rawName)
  const primary = reports.filter((file) => !serializedTransportRoot(directory, file))
  if (primary.length !== 1) {
    fail(`${normalizedRelative(directory)} must contain exactly one canonical ${rawName}; found ${primary.length}`)
  }
  const primaryBytes = fs.readFileSync(primary[0])
  for (const report of reports.filter((file) => serializedTransportRoot(directory, file))) {
    const transportRoot = serializedTransportRoot(directory, report)
    if (!fs.readFileSync(report).equals(primaryBytes)) {
      fail(`${normalizedRelative(directory)} contains a divergent VSTest serialized attachment`)
    }
    if (pruneSerializedCopies) fs.rmSync(transportRoot, { recursive: true, force: true })
  }
  return { file: primary[0], bytes: primaryBytes, serializedCopiesPruned: reports.length - primary.length }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function resolveCoverageBinding(env = process.env) {
  const sourceCommit = String(env.FSUSBLOG_TEST_SOURCE_COMMIT || gitHead() || '').trim()
  if (!sourceCommit) fail('coverage binding requires a source commit')
  return {
    runId: String(env.FSUSBLOG_TEST_RUN_ID || `local-${sourceCommit}`).trim(),
    sourceCommit,
    sourceFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || sourceCommit).trim()
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function prepareCoverageShard({
  directory,
  shardId,
  binding = resolveCoverageBinding(),
  pruneSerializedCopies = true
}) {
  if (!shardId || !/^[A-Za-z0-9._-]+$/u.test(shardId)) fail(`invalid coverage shard id: ${shardId}`)
  const resolvedDirectory = path.resolve(directory)
  const raw = locateCanonicalRaw(resolvedDirectory, { pruneSerializedCopies })
  const parsed = parseRawBytes(raw.bytes, normalizedRelative(raw.file))
  const sidecar = {
    schema: 'fsusblog.backend-coverage-shard.v1',
    shardId,
    format: 'coverlet-json',
    raw: {
      path: path.relative(path.dirname(raw.file), raw.file).replaceAll(path.sep, '/'),
      bytes: raw.bytes.length,
      digest: sha256(raw.bytes)
    },
    identity: {
      modules: parsed.modules,
      sources: parsed.sources
    },
    producer: binding,
    transport: {
      serializedCopiesPruned: raw.serializedCopiesPruned
    }
  }
  const sidecarFile = path.join(path.dirname(raw.file), sidecarName)
  atomicJson(sidecarFile, sidecar)
  return { sidecarFile, rawFile: raw.file, sidecar }
}

export function writeCoverageUniverse({
  file,
  shards,
  binding = resolveCoverageBinding()
}) {
  if (!Array.isArray(shards) || shards.length === 0) fail('coverage universe requires at least one shard')
  const ids = new Set()
  const normalized = shards.map(({ id, directory }) => {
    if (!id || ids.has(id)) fail(`coverage universe repeats shard ${id || '<missing>'}`)
    ids.add(id)
    return {
      id,
      directory: path.relative(path.dirname(file), path.resolve(directory)).replaceAll(path.sep, '/')
    }
  })
  atomicJson(file, {
    schema: 'fsusblog.backend-coverage-universe.v1',
    format: 'coverlet-json',
    producer: binding,
    shards: normalized
  })
}

function readUniverse(file) {
  let universe
  try {
    universe = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`coverage universe is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (universe?.schema !== 'fsusblog.backend-coverage-universe.v1'
    || universe.format !== 'coverlet-json'
    || !Array.isArray(universe.shards)
    || universe.shards.length === 0) {
    fail('coverage universe has an invalid schema')
  }
  const ids = new Set()
  const shards = universe.shards.map((entry) => {
    if (!entry?.id || ids.has(entry.id) || !entry.directory) {
      fail(`coverage universe contains a duplicate or invalid shard: ${entry?.id ?? '<missing>'}`)
    }
    ids.add(entry.id)
    return { id: entry.id, directory: path.resolve(path.dirname(file), entry.directory) }
  })
  return { producer: universe.producer, shards }
}

function equalArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateSidecar({ shard, expectedBinding, baselineIdentity }) {
  const sidecars = walk(shard.directory, (file) => path.basename(file) === sidecarName)
  if (sidecars.length !== 1) fail(`coverage shard ${shard.id} must contain exactly one identity sidecar; found ${sidecars.length}`)
  let sidecar
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecars[0], 'utf8'))
  } catch (error) {
    fail(`coverage shard ${shard.id} has a corrupt identity sidecar: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (sidecar?.schema !== 'fsusblog.backend-coverage-shard.v1'
    || sidecar.shardId !== shard.id
    || sidecar.format !== 'coverlet-json') {
    fail(`coverage shard ${shard.id} has an invalid identity sidecar`)
  }
  for (const key of ['runId', 'sourceCommit', 'sourceFingerprint']) {
    if (!sidecar.producer?.[key] || sidecar.producer[key] !== expectedBinding?.[key]) {
      fail(`coverage shard ${shard.id} ${key} binding mismatch`)
    }
  }
  const rawFile = path.resolve(path.dirname(sidecars[0]), sidecar.raw?.path ?? '')
  if (path.basename(rawFile) !== rawName || !fs.existsSync(rawFile)) {
    fail(`coverage shard ${shard.id} is missing canonical raw coverage`)
  }
  const bytes = fs.readFileSync(rawFile)
  if (sidecar.raw.bytes !== bytes.length || sidecar.raw.digest !== sha256(bytes)) {
    fail(`coverage shard ${shard.id} raw coverage digest or byte count mismatch`)
  }
  const parsed = parseRawBytes(bytes, `coverage shard ${shard.id}`)
  if (!equalArray(sidecar.identity?.modules ?? [], parsed.modules)
    || !equalArray(sidecar.identity?.sources ?? [], parsed.sources)) {
    fail(`coverage shard ${shard.id} sidecar module/source identity mismatch`)
  }
  if (baselineIdentity
    && (!equalArray(parsed.modules, baselineIdentity.modules)
      || !equalArray(parsed.sources, baselineIdentity.sources))) {
    fail(`coverage shard ${shard.id} module/source universe mismatch`)
  }
  return { sidecar, rawFile, bytes, parsed }
}

function branchKey(branch) {
  return [branch.Line, branch.Offset, branch.EndOffset, branch.Path, branch.Ordinal].join('\u0000')
}

function mergeRaw(shards) {
  const merged = {}
  for (const shard of shards) {
    for (const [moduleName, documents] of Object.entries(shard.parsed.payload)) {
      const targetDocuments = (merged[moduleName] ??= {})
      for (const [sourceName, classes] of Object.entries(documents)) {
        const source = normalizeCoverageSourcePath(sourceName)
        const targetClasses = (targetDocuments[source] ??= {})
        for (const [className, methods] of Object.entries(classes)) {
          const targetMethods = (targetClasses[className] ??= {})
          for (const [methodName, coverage] of Object.entries(methods)) {
            const target = (targetMethods[methodName] ??= { Lines: {}, Branches: [] })
            for (const [line, hits] of Object.entries(coverage.Lines)) {
              target.Lines[line] = Number(target.Lines[line] ?? 0) + Number(hits)
            }
            const existing = new Map(target.Branches.map((branch) => [branchKey(branch), branch]))
            for (const branch of coverage.Branches) {
              const key = branchKey(branch)
              const prior = existing.get(key)
              if (prior) prior.Hits += Number(branch.Hits)
              else {
                const clone = { ...branch, Hits: Number(branch.Hits) }
                target.Branches.push(clone)
                existing.set(key, clone)
              }
            }
            target.Branches.sort((left, right) => branchKey(left).localeCompare(branchKey(right)))
          }
        }
      }
    }
  }
  return merged
}

function percent(covered, total) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(4))
}

function summarizeRaw(raw) {
  const lineHits = new Map()
  const branchHits = new Map()
  const methodHits = new Map()
  const files = new Map()
  const classes = new Set()
  for (const [moduleName, documents] of Object.entries(raw)) {
    for (const [sourceName, classMap] of Object.entries(documents)) {
      const source = normalizeCoverageSourcePath(sourceName)
      const file = files.get(source) ?? { lines: new Map(), branches: new Map(), methods: new Map() }
      files.set(source, file)
      for (const [className, methods] of Object.entries(classMap)) {
        classes.add(`${moduleName}\u0000${source}\u0000${className}`)
        for (const [methodName, coverage] of Object.entries(methods)) {
          const methodIdentity = `${moduleName}\u0000${source}\u0000${className}\u0000${methodName}`
          // Coverlet's Cobertura exchange contract treats a method without
          // sequence points as covered (line-rate=1, branch-rate=1). Preserve
          // that historical method-threshold semantic while line and branch
          // totals continue to contain only instrumented identities.
          let coveredMethod = Object.keys(coverage.Lines).length === 0
            || coverage.Branches.length === 0
          for (const [line, hits] of Object.entries(coverage.Lines)) {
            const covered = Number(hits) > 0
            const identity = `${source}\u0000${line}`
            lineHits.set(identity, Boolean(lineHits.get(identity)) || covered)
            file.lines.set(line, Boolean(file.lines.get(line)) || covered)
            coveredMethod ||= covered
          }
          for (const branch of coverage.Branches) {
            const identity = `${methodIdentity}\u0000${branchKey(branch)}`
            const covered = Number(branch.Hits) > 0
            branchHits.set(identity, covered)
            file.branches.set(identity, covered)
            coveredMethod ||= covered
          }
          methodHits.set(methodIdentity, coveredMethod)
          file.methods.set(methodIdentity, coveredMethod)
        }
      }
    }
  }
  const totals = (entries) => ({
    covered: [...entries.values()].filter(Boolean).length,
    total: entries.size
  })
  const overall = {
    lines: totals(lineHits),
    branches: totals(branchHits),
    methods: totals(methodHits)
  }
  return {
    summary: {
      linecoverage: percent(overall.lines.covered, overall.lines.total),
      branchcoverage: percent(overall.branches.covered, overall.branches.total),
      methodcoverage: percent(overall.methods.covered, overall.methods.total),
      assemblies: Object.keys(raw).length,
      classes: classes.size,
      files: files.size
    },
    totals: overall,
    files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, metrics]) => {
      const lines = totals(metrics.lines)
      const branches = totals(metrics.branches)
      const methods = totals(metrics.methods)
      return {
        path: file,
        linecoverage: percent(lines.covered, lines.total),
        branchcoverage: percent(branches.covered, branches.total),
        methodcoverage: percent(methods.covered, methods.total),
        totals: { lines, branches, methods }
      }
    })
  }
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function methodStats(coverage) {
  const lines = Object.entries(coverage.Lines)
  const branches = coverage.Branches
  return {
    linesCovered: lines.filter(([, hits]) => Number(hits) > 0).length,
    linesTotal: lines.length,
    branchesCovered: branches.filter((branch) => Number(branch.Hits) > 0).length,
    branchesTotal: branches.length
  }
}

function coberturaFromRaw(raw, summary) {
  const packages = []
  for (const [moduleName, documents] of Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))) {
    const classXml = []
    for (const [source, classMap] of Object.entries(documents).sort(([left], [right]) => left.localeCompare(right))) {
      for (const [className, methods] of Object.entries(classMap).sort(([left], [right]) => left.localeCompare(right))) {
        const methodXml = []
        const classLines = new Map()
        const classBranches = new Map()
        const classBranchesByLine = new Map()
        for (const [methodName, coverage] of Object.entries(methods).sort(([left], [right]) => left.localeCompare(right))) {
          const stats = methodStats(coverage)
          const branchesByLine = new Map()
          for (const branch of coverage.Branches) {
            const list = branchesByLine.get(String(branch.Line)) ?? []
            list.push(branch)
            branchesByLine.set(String(branch.Line), list)
            const classList = classBranchesByLine.get(String(branch.Line)) ?? []
            classList.push(branch)
            classBranchesByLine.set(String(branch.Line), classList)
            classBranches.set(`${methodName}\u0000${branchKey(branch)}`, Number(branch.Hits) > 0)
          }
          const lines = Object.entries(coverage.Lines).sort(([left], [right]) => Number(left) - Number(right)).map(([line, hits]) => {
            classLines.set(line, Boolean(classLines.get(line)) || Number(hits) > 0)
            const branches = branchesByLine.get(line) ?? []
            if (branches.length === 0) return `<line number="${line}" hits="${Number(hits)}" branch="false"/>`
            const covered = branches.filter((branch) => Number(branch.Hits) > 0).length
            const conditions = branches.map((branch, index) => (
              `<condition number="${branch.Ordinal ?? index}" type="jump" coverage="${Number(branch.Hits) > 0 ? 100 : 0}%"/>`
            )).join('')
            return `<line number="${line}" hits="${Number(hits)}" branch="true" condition-coverage="${percent(covered, branches.length)}% (${covered}/${branches.length})"><conditions>${conditions}</conditions></line>`
          }).join('')
          methodXml.push(
            `<method name="${xml(methodName)}" signature="" line-rate="${stats.linesTotal ? stats.linesCovered / stats.linesTotal : 1}" branch-rate="${stats.branchesTotal ? stats.branchesCovered / stats.branchesTotal : 1}"><lines>${lines}</lines></method>`
          )
        }
        const classLineXml = [...classLines.entries()].sort(([left], [right]) => Number(left) - Number(right))
          .map(([line, covered]) => {
            const branches = classBranchesByLine.get(line) ?? []
            if (branches.length === 0) return `<line number="${line}" hits="${covered ? 1 : 0}" branch="false"/>`
            const coveredBranches = branches.filter((branch) => Number(branch.Hits) > 0).length
            const conditions = branches.map((branch, index) => (
              `<condition number="${branch.Ordinal ?? index}" type="jump" coverage="${Number(branch.Hits) > 0 ? 100 : 0}%"/>`
            )).join('')
            return `<line number="${line}" hits="${covered ? 1 : 0}" branch="true" condition-coverage="${percent(coveredBranches, branches.length)}% (${coveredBranches}/${branches.length})"><conditions>${conditions}</conditions></line>`
          }).join('')
        const classLineStats = { covered: [...classLines.values()].filter(Boolean).length, total: classLines.size }
        const classBranchStats = { covered: [...classBranches.values()].filter(Boolean).length, total: classBranches.size }
        classXml.push(
          `<class name="${xml(className)}" filename="${xml(source)}" line-rate="${classLineStats.total ? classLineStats.covered / classLineStats.total : 1}" branch-rate="${classBranchStats.total ? classBranchStats.covered / classBranchStats.total : 1}"><methods>${methodXml.join('')}</methods><lines>${classLineXml}</lines></class>`
        )
      }
    }
    packages.push(`<package name="${xml(moduleName)}"><classes>${classXml.join('')}</classes></package>`)
  }
  const totals = summary.totals
  return `<?xml version="1.0" encoding="utf-8"?>\n<coverage line-rate="${totals.lines.total ? totals.lines.covered / totals.lines.total : 1}" branch-rate="${totals.branches.total ? totals.branches.covered / totals.branches.total : 1}" lines-covered="${totals.lines.covered}" lines-valid="${totals.lines.total}" branches-covered="${totals.branches.covered}" branches-valid="${totals.branches.total}" complexity="0" version="fsusblog-coverlet-json-v1"><sources><source>.</source></sources><packages>${packages.join('')}</packages></coverage>\n`
}

export function mergeCoverageUniverse({ universeFile, outDirectory }) {
  const started = process.cpuUsage()
  const universe = readUniverse(path.resolve(universeFile))
  const seenDirectories = new Set()
  const validated = []
  let baselineIdentity = null
  for (const shard of universe.shards) {
    if (!fs.existsSync(shard.directory)) {
      fail(`coverage universe is missing shard ${shard.id}: ${normalizedRelative(shard.directory)}`)
    }
    const realDirectory = fs.realpathSync(shard.directory)
    if (seenDirectories.has(realDirectory)) fail(`coverage universe repeats shard input ${normalizedRelative(realDirectory)}`)
    seenDirectories.add(realDirectory)
    const value = validateSidecar({ shard, expectedBinding: universe.producer, baselineIdentity })
    baselineIdentity ??= value.parsed
    validated.push(value)
  }
  const mergedRaw = mergeRaw(validated)
  const summaryCore = summarizeRaw(mergedRaw)
  const rawBytes = Buffer.from(`${JSON.stringify(mergedRaw, null, 2)}\n`)
  const cobertura = coberturaFromRaw(mergedRaw, summaryCore)
  const coberturaBytes = Buffer.from(cobertura)
  const resolvedOut = path.resolve(outDirectory)
  fs.mkdirSync(resolvedOut, { recursive: true })
  fs.writeFileSync(path.join(resolvedOut, rawName), rawBytes)
  fs.writeFileSync(path.join(resolvedOut, 'coverage.cobertura.xml'), coberturaBytes)
  const producer = universe.producer
  const summary = {
    ...summaryCore,
    source: 'backend-coverlet-json-authoritative-merge',
    reportPaths: validated.map(({ rawFile }) => normalizedRelative(rawFile)),
    authoritativeRaw: normalizedRelative(path.join(resolvedOut, rawName)),
    exchangeFormats: [normalizedRelative(path.join(resolvedOut, 'coverage.cobertura.xml'))],
    producer,
    generatedAt: new Date().toISOString()
  }
  atomicJson(path.join(resolvedOut, 'Summary.json'), summary)
  const cpu = process.cpuUsage(started)
  const rawShardBytes = validated.reduce((sum, item) => sum + item.bytes.length, 0)
  const sidecarBytes = validated.reduce((sum, item) => sum + fs.statSync(path.join(path.dirname(item.rawFile), sidecarName)).size, 0)
  const legacyCoberturaBytes = validated.reduce((sum, item) => {
    const itemSummary = summarizeRaw(item.parsed.payload)
    return sum + Buffer.byteLength(coberturaFromRaw(item.parsed.payload, itemSummary))
  }, 0)
  const evidence = {
    schema: 'fsusblog.backend-coverage-format-migration.v1',
    canonicalRawFormat: 'coverlet-json',
    shardCount: validated.length,
    before: {
      coverageBytesWritten: rawShardBytes + legacyCoberturaBytes,
      coverageAttachments: validated.length * 2,
      parseCount: validated.length * 2,
      formatsPerShard: ['coverlet-json', 'cobertura']
    },
    after: {
      coverageBytesWritten: rawShardBytes + rawBytes.length + coberturaBytes.length,
      identitySidecarBytesWritten: sidecarBytes,
      coverageAttachments: validated.length,
      parseCount: validated.length,
      formatsPerShard: ['coverlet-json'],
      exchangeFormatConversions: 1
    },
    mergeCpuMicroseconds: cpu.user + cpu.system,
    producer,
    generatedAt: new Date().toISOString()
  }
  atomicJson(path.join(resolvedOut, 'migration-evidence.json'), evidence)
  return { summary, evidence }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

async function main() {
  const command = process.argv[2]
  if (command === 'prepare') {
    const directory = argument('--dir')
    const shardId = argument('--shard')
    if (!directory || !shardId) fail('prepare requires --dir and --shard')
    const result = prepareCoverageShard({ directory, shardId })
    console.log(`[coverage:backend] prepared ${shardId} ${normalizedRelative(result.rawFile)}`)
    return
  }
  if (command === 'universe') {
    const file = argument('--out')
    const inputRoot = argument('--input-root')
    const expected = String(argument('--expected-shards') ?? '').split(',').filter(Boolean)
    if (!file || !inputRoot || expected.length === 0) {
      fail('universe requires --out, --input-root, and --expected-shards')
    }
    writeCoverageUniverse({
      file: path.resolve(file),
      shards: expected.map((id) => ({ id, directory: path.resolve(inputRoot, id) }))
    })
    console.log(`[coverage:backend] wrote universe ${normalizedRelative(path.resolve(file))}`)
    return
  }
  if (command === 'merge') {
    const universeFile = argument('--manifest')
    const outDirectory = argument('--out')
    if (!universeFile || !outDirectory) fail('merge requires --manifest and --out')
    const result = mergeCoverageUniverse({ universeFile, outDirectory })
    console.log(`[coverage:backend] merged ${result.evidence.shardCount} shard(s) with one exchange conversion`)
    return
  }
  fail('usage: backend-coverage-pipeline.mjs prepare|universe|merge ...')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(`[coverage:backend] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
