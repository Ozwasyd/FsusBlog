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

  const classAttrs = [...xml.matchAll(/<class\b([^>]*)>/g)].map((match) => attrMap(match[1]))
  const packageCount = [...xml.matchAll(/<package\b/g)].length
  const files = new Set(classAttrs.map((attrs) => attrs.filename).filter(Boolean))

  return {
    file,
    totals: {
      lines: { covered: linesCovered ?? 0, total: linesTotal ?? 0 },
      branches: { covered: branchesCovered ?? 0, total: branchesTotal ?? 0 },
      methods: { covered: methodsCovered, total: methodsTotal }
    },
    assemblies: Math.max(1, packageCount),
    classes: classAttrs.length,
    files: files.size || classAttrs.length
  }
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
const sumMetric = (metric, key) => parsed.reduce((sum, item) => sum + Number(item.totals[metric][key] ?? 0), 0)
const totals = {
  lines: { covered: sumMetric('lines', 'covered'), total: sumMetric('lines', 'total') },
  branches: { covered: sumMetric('branches', 'covered'), total: sumMetric('branches', 'total') },
  methods: { covered: sumMetric('methods', 'covered'), total: sumMetric('methods', 'total') }
}

const summary = {
  summary: {
    linecoverage: percent(totals.lines.covered, totals.lines.total),
    branchcoverage: percent(totals.branches.covered, totals.branches.total),
    methodcoverage: percent(totals.methods.covered, totals.methods.total),
    assemblies: parsed.reduce((sum, item) => sum + item.assemblies, 0),
    classes: parsed.reduce((sum, item) => sum + item.classes, 0),
    files: parsed.reduce((sum, item) => sum + item.files, 0)
  },
  totals,
  source: sourceKind,
  reportPaths: reports.map((file) => path.relative(process.cwd(), file).replaceAll(path.sep, '/')),
  generatedAt: new Date().toISOString()
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`[coverage:cobertura] wrote ${outFile} from ${reports.length} report(s)`)
