#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function usage() {
  console.error('Usage: summarize-cobertura.mjs <coverage-file-or-dir> <out-summary.json> [source-kind]')
  process.exit(2)
}

const [inputPath, outFile, sourceKind = 'backend-cobertura'] = process.argv.slice(2)
if (!inputPath || !outFile) usage()

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(fullPath))
    else if (/coverage\.cobertura\.xml$/i.test(entry.name) || /\.cobertura\.xml$/i.test(entry.name)) files.push(fullPath)
  }
  return files
}

function attrMap(raw) {
  const attrs = {}
  for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function numberAttr(attrs, name) {
  const value = Number(attrs[name])
  return Number.isFinite(value) ? value : null
}

function percent(covered, total) {
  if (total <= 0) return 100
  return Number(((covered / total) * 100).toFixed(4))
}

function parseConditionCoverage(value) {
  const match = String(value || '').match(/\((\d+)\/(\d+)\)/)
  if (!match) return null
  return { covered: Number(match[1]), total: Number(match[2]) }
}

function normalizeSourceFile(filename) {
  return path.posix.normalize(String(filename).replaceAll('\\', '/'))
}

function coveragePercent(value) {
  const match = String(value || '').match(/(-?\d+(?:\.\d+)?)%/)
  return match ? Number(match[1]) : null
}

function mergeCoverageEntries(target, source) {
  for (const [identity, covered] of source) {
    target.set(identity, Boolean(target.get(identity)) || covered)
  }
}

function lineElements(xml) {
  return [...xml.matchAll(/<line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/line>)/gi)]
}

function branchEntries(filename, lineNumber, attrs, body) {
  if (String(attrs.branch || '').toLowerCase() !== 'true') return new Map()
  const aggregate = parseConditionCoverage(attrs['condition-coverage'])
  if (!aggregate || aggregate.total <= 0) return new Map()

  const conditions = [...String(body || '').matchAll(/<condition\b([^>]*)\/?\s*>/gi)]
    .map((match) => attrMap(match[1]))
  const entries = new Map()

  if (conditions.length > 0 && aggregate.total % conditions.length === 0) {
    const slotsPerCondition = aggregate.total / conditions.length
    for (const [conditionIndex, condition] of conditions.entries()) {
      const percentCovered = coveragePercent(condition.coverage)
      const coveredSlots = percentCovered === null
        ? 0
        : Math.max(0, Math.min(slotsPerCondition, Math.round(slotsPerCondition * percentCovered / 100)))
      const conditionIdentity = `${condition.number ?? conditionIndex}\u0000${condition.type ?? ''}`
      for (let slot = 0; slot < slotsPerCondition; slot += 1) {
        entries.set(`${filename}\u0000${lineNumber}\u0000${conditionIdentity}\u0000${slot}`, slot < coveredSlots)
      }
    }
    return entries
  }

  for (let slot = 0; slot < aggregate.total; slot += 1) {
    entries.set(`${filename}\u0000${lineNumber}\u0000aggregate\u0000${slot}`, slot < aggregate.covered)
  }
  return entries
}

function parseCobertura(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const coverageTag = xml.match(/<coverage\b([^>]*)>/i)
  if (!coverageTag) {
    throw new Error(`missing <coverage> root: ${file}`)
  }

  const rootAttrs = attrMap(coverageTag[1])
  let linesTotal = numberAttr(rootAttrs, 'lines-valid')
  let linesCovered = numberAttr(rootAttrs, 'lines-covered')
  let branchesTotal = numberAttr(rootAttrs, 'branches-valid')
  let branchesCovered = numberAttr(rootAttrs, 'branches-covered')

  if (linesTotal === null || linesCovered === null) {
    const lines = [...xml.matchAll(/<line\b([^>]*)\/?>/g)].map((match) => attrMap(match[1]))
    linesTotal = lines.length
    linesCovered = lines.filter((attrs) => Number(attrs.hits ?? 0) > 0).length
  }

  if (branchesTotal === null || branchesCovered === null) {
    branchesTotal = 0
    branchesCovered = 0
    for (const match of xml.matchAll(/<line\b([^>]*)\/?>/g)) {
      const attrs = attrMap(match[1])
      if (attrs.branch !== 'true') continue
      const parsed = parseConditionCoverage(attrs['condition-coverage'])
      if (parsed) {
        branchesTotal += parsed.total
        branchesCovered += parsed.covered
      }
    }
  }

  const methodAttrs = [...xml.matchAll(/<method\b([^>]*)>/g)].map((match) => attrMap(match[1]))
  const methodsTotal = methodAttrs.length
  const methodsCovered = methodAttrs.filter((attrs) => {
    const lineRate = Number(attrs['line-rate'] ?? 0)
    const branchRate = Number(attrs['branch-rate'] ?? 0)
    return lineRate > 0 || branchRate > 0
  }).length

  const classMatches = [...xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/gi)]
  const classAttrs = classMatches.map((match) => attrMap(match[1]))
  const packageAttrs = [...xml.matchAll(/<package\b([^>]*)>/gi)].map((match) => attrMap(match[1]))
  const packageCount = packageAttrs.length
  const files = new Set(classAttrs.map((attrs) => attrs.filename).filter(Boolean))

  const lineCoverage = new Map()
  const branchCoverage = new Map()
  const methodCoverage = new Map()
  const classIdentities = new Set()
  const fileIdentities = new Set()
  const assemblyIdentities = new Set(
    packageAttrs.map((attrs, index) => attrs.name || `anonymous-package:${index}`)
  )
  if (assemblyIdentities.size === 0) assemblyIdentities.add('anonymous-package:0')

  for (const [classIndex, match] of classMatches.entries()) {
    const classAttrsForMatch = attrMap(match[1])
    const classBody = match[2]
    const filename = normalizeSourceFile(
      classAttrsForMatch.filename || `anonymous-class-file:${classAttrsForMatch.name || classIndex}`
    )
    const className = classAttrsForMatch.name || `anonymous-class:${classIndex}`
    fileIdentities.add(filename)
    classIdentities.add(`${filename}\u0000${className}`)

    for (const methodMatch of classBody.matchAll(/<method\b([^>]*)>/gi)) {
      const attrs = attrMap(methodMatch[1])
      const identity = `${filename}\u0000${className}\u0000${attrs.name ?? ''}\u0000${attrs.signature ?? ''}`
      const covered = Number(attrs['line-rate'] ?? 0) > 0 || Number(attrs['branch-rate'] ?? 0) > 0
      methodCoverage.set(identity, Boolean(methodCoverage.get(identity)) || covered)
    }

    const classLines = classBody.replace(/<methods\b[^>]*>[\s\S]*?<\/methods>/gi, '')
    for (const lineMatch of lineElements(classLines)) {
      const attrs = attrMap(lineMatch[1])
      if (attrs.number === undefined) continue
      const identity = `${filename}\u0000${attrs.number}`
      lineCoverage.set(identity, Boolean(lineCoverage.get(identity)) || Number(attrs.hits ?? 0) > 0)
      mergeCoverageEntries(branchCoverage, branchEntries(filename, attrs.number, attrs, lineMatch[2]))
    }
  }

  return {
    file,
    totals: {
      lines: { covered: linesCovered ?? 0, total: linesTotal ?? 0 },
      branches: { covered: branchesCovered ?? 0, total: branchesTotal ?? 0 },
      methods: { covered: methodsCovered, total: methodsTotal }
    },
    assemblies: Math.max(1, packageCount),
    classes: classAttrs.length,
    files: files.size || classAttrs.length,
    identities: {
      lines: lineCoverage,
      branches: branchCoverage,
      methods: methodCoverage,
      assemblies: assemblyIdentities,
      classes: classIdentities,
      files: fileIdentities
    }
  }
}

function parseCoverletJson(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  const identities = {
    lines: new Map(),
    branches: new Map(),
    methods: new Map(),
    assemblies: new Set(),
    classes: new Set(),
    files: new Set()
  }

  for (const [moduleName, documents] of Object.entries(payload ?? {})) {
    identities.assemblies.add(moduleName)
    for (const [documentName, classes] of Object.entries(documents ?? {})) {
      const filename = normalizeSourceFile(documentName)
      identities.files.add(filename)
      for (const [className, methods] of Object.entries(classes ?? {})) {
        identities.classes.add(`${moduleName}\u0000${filename}\u0000${className}`)
        for (const [methodName, method] of Object.entries(methods ?? {})) {
          const methodIdentity = `${moduleName}\u0000${filename}\u0000${className}\u0000${methodName}`
          let methodCovered = false
          for (const [lineNumber, hits] of Object.entries(method?.Lines ?? {})) {
            const covered = Number(hits) > 0
            const lineIdentity = `${filename}\u0000${lineNumber}`
            identities.lines.set(lineIdentity, Boolean(identities.lines.get(lineIdentity)) || covered)
            methodCovered ||= covered
          }
          for (const branch of method?.Branches ?? []) {
            const covered = Number(branch?.Hits) > 0
            const branchIdentity = [
              moduleName,
              filename,
              className,
              methodName,
              branch?.Line,
              branch?.Offset,
              branch?.EndOffset,
              branch?.Path,
              branch?.Ordinal
            ].join('\u0000')
            identities.branches.set(branchIdentity, Boolean(identities.branches.get(branchIdentity)) || covered)
            methodCovered ||= covered
          }
          identities.methods.set(methodIdentity, Boolean(identities.methods.get(methodIdentity)) || methodCovered)
        }
      }
    }
  }
  return identities
}

const inputStat = fs.existsSync(inputPath) ? fs.statSync(inputPath) : null
if (!inputStat) {
  console.error(`[coverage:cobertura] missing input: ${inputPath}`)
  process.exit(1)
}

const reports = inputStat.isDirectory() ? walk(inputPath) : [inputPath]
if (reports.length === 0) {
  console.error(`[coverage:cobertura] no cobertura reports under ${inputPath}`)
  process.exit(1)
}

const parsed = reports.map(parseCobertura)
const exactJsonReports = reports.map((report) => path.join(path.dirname(report), 'coverage.json'))
if (parsed.length > 1) {
  const missingJsonReports = exactJsonReports.filter((file) => !fs.existsSync(file))
  if (missingJsonReports.length > 0) {
    console.error(`[coverage:cobertura] exact multi-run union requires one Coverlet JSON beside every Cobertura report; missing: ${missingJsonReports.join(', ')}`)
    process.exit(1)
  }
}
const mergedIdentities = {
  lines: new Map(),
  branches: new Map(),
  methods: new Map(),
  assemblies: new Set(),
  classes: new Set(),
  files: new Set()
}
for (const report of parsed) {
  mergeCoverageEntries(mergedIdentities.lines, report.identities.lines)
  mergeCoverageEntries(mergedIdentities.branches, report.identities.branches)
  mergeCoverageEntries(mergedIdentities.methods, report.identities.methods)
  for (const metric of ['assemblies', 'classes', 'files']) {
    for (const identity of report.identities[metric]) mergedIdentities[metric].add(identity)
  }
}

const identityTotals = (entries) => ({
  covered: [...entries.values()].filter(Boolean).length,
  total: entries.size
})
const singleReport = parsed.length === 1 ? parsed[0] : null
const exactMergedIdentities = parsed.length > 1
  ? exactJsonReports.map(parseCoverletJson).reduce((merged, identities) => {
      mergeCoverageEntries(merged.lines, identities.lines)
      mergeCoverageEntries(merged.branches, identities.branches)
      mergeCoverageEntries(merged.methods, identities.methods)
      for (const metric of ['assemblies', 'classes', 'files']) {
        for (const identity of identities[metric]) merged[metric].add(identity)
      }
      return merged
    }, {
      lines: new Map(),
      branches: new Map(),
      methods: new Map(),
      assemblies: new Set(),
      classes: new Set(),
      files: new Set()
    })
  : null
const totals = singleReport?.totals ?? {
  lines: identityTotals(exactMergedIdentities.lines),
  branches: identityTotals(exactMergedIdentities.branches),
  // Preserve the existing Cobertura method-coverage contract and its release
  // threshold. Coverlet JSON is required only for exact line/branch identity;
  // migrating the historical method definition is a separate policy change.
  methods: identityTotals(mergedIdentities.methods)
}

const summary = {
  summary: {
    linecoverage: percent(totals.lines.covered, totals.lines.total),
    branchcoverage: percent(totals.branches.covered, totals.branches.total),
    methodcoverage: percent(totals.methods.covered, totals.methods.total),
    assemblies: singleReport?.assemblies ?? mergedIdentities.assemblies.size,
    classes: singleReport?.classes ?? mergedIdentities.classes.size,
    files: singleReport?.files ?? mergedIdentities.files.size
  },
  totals,
  source: sourceKind,
  reportPaths: reports.map((file) => path.relative(process.cwd(), file).replaceAll(path.sep, '/')),
  producer: {
    runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT || null,
    sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
  },
  generatedAt: new Date().toISOString()
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`[coverage:cobertura] wrote ${outFile} from ${reports.length} report(s)`)
