#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const allowlistPath = path.join(root, 'tools/contracts/aeds-only-policy.allowlist.json')
const reportPath = path.join(root, '.tmp/gate-logs/aeds-only-policy-inventory.json')

const validClassifications = new Set(['allowed-exemption', 'must-migrate', 'test-tool-docs-only'])

const signalDefinitions = [
  {
    id: 'backend-json-api-response',
    scope: 'backend',
    regex: /\bJsonApiResponse\s*</
  },
  {
    id: 'backend-json-result',
    scope: 'backend',
    regex: /\b(?:Results|TypedResults)\.Json\b/
  },
  {
    id: 'backend-json-content-type',
    scope: 'backend',
    regex: /application\/(?:json|feed\+json)/
  },
  {
    id: 'frontend-json-envelope-type',
    scope: 'frontend',
    regex: /\bJsonApiResponse\s*</
  },
  {
    id: 'frontend-response-json',
    scope: 'frontend',
    regex: /\bresponse\.json\s*\(/
  },
  {
    id: 'frontend-json-content-type',
    scope: 'frontend',
    regex: /application\/json/
  },
  {
    id: 'frontend-json-stringify',
    scope: 'frontend',
    regex: /\bJSON\.stringify\s*\(/
  }
]

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function toRepoPath(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function listFiles(dir, extension) {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) return []
  const files = []
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(full, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(toRepoPath(child), extension))
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(toRepoPath(child))
    }
  }
  return files
}

function loadAllowlist() {
  const payload = readJson(allowlistPath)
  if (payload.version !== 'aeds-only-policy-v1') {
    throw new Error(`invalid allowlist version: ${payload.version ?? 'missing'}`)
  }

  const entries = payload.entries ?? []
  const ids = new Set()
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) {
      throw new Error(`invalid or duplicate allowlist id: ${entry.id ?? 'missing'}`)
    }
    ids.add(entry.id)
    if (!validClassifications.has(entry.classification)) {
      throw new Error(`${entry.id} has invalid classification: ${entry.classification}`)
    }
    if (!entry.file || entry.file.includes('*') || entry.file.endsWith('/')) {
      throw new Error(`${entry.id} must bind to one concrete file`)
    }
    if (!fs.existsSync(path.join(root, entry.file))) {
      throw new Error(`${entry.id} references missing file: ${entry.file}`)
    }
    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      throw new Error(`${entry.id} must include one or more line patterns`)
    }
    for (const pattern of entry.patterns) {
      if (!pattern || pattern === '*' || pattern.length < 3) {
        throw new Error(`${entry.id} has an over-broad pattern: ${pattern}`)
      }
    }
    if (!entry.reason || entry.reason.length < 20) {
      throw new Error(`${entry.id} must include a concrete reason`)
    }
  }

  return entries
}

function classifyMatch(entries, match) {
  const candidates = entries.filter((entry) => entry.file === match.file)
  return candidates.find((entry) => entry.patterns.some((pattern) => match.line.includes(pattern))) ?? null
}

function scanFiles() {
  return [
    ...listFiles('src/backend/Modules/Endpoints', '.cs'),
    'src/backend/Infrastructure/Operations/ProductionHealth.cs',
    'src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs',
    ...listFiles('src/frontend/src/api', '.ts'),
    'src/frontend/src/services/telemetryService.ts',
    'src/frontend/src/services/notificationStreamRuntime.ts'
  ].filter((file, index, files) => files.indexOf(file) === index && fs.existsSync(path.join(root, file)))
}

function scan(entries) {
  const matches = []
  for (const file of scanFiles()) {
    const scope = file.includes('/src/frontend/') ? 'frontend' : 'backend'
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      for (const signal of signalDefinitions.filter((item) => item.scope === scope)) {
        if (!signal.regex.test(line)) continue
        const match = {
          file,
          lineNumber: index + 1,
          signal: signal.id,
          line: line.trim()
        }
        const entry = classifyMatch(entries, match)
        matches.push({
          ...match,
          classification: entry?.classification ?? 'unknown',
          allowlistId: entry?.id ?? null,
          routes: entry?.routes ?? [],
          issue: entry?.issue ?? null,
          reason: entry?.reason ?? null
        })
      }
    }
  }

  return matches
}

function summarize(matches) {
  const counts = {}
  for (const match of matches) {
    counts[match.classification] = (counts[match.classification] ?? 0) + 1
  }
  const unknown = matches.filter((match) => match.classification === 'unknown')
  const mustMigrate = matches.filter((match) => match.classification === 'must-migrate')
  return {
    status: unknown.length === 0 ? 'ok' : 'blocked',
    generatedAt: new Date().toISOString(),
    policy: 'Internal Application API AEDS-only',
    allowlist: path.relative(root, allowlistPath),
    scannedFiles: scanFiles().length,
    matchCount: matches.length,
    counts,
    unknown,
    mustMigrate
  }
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

try {
  const entries = loadAllowlist()
  const matches = scan(entries)
  const report = summarize(matches)
  writeReport(report)
  if (report.unknown.length > 0) {
    for (const item of report.unknown.slice(0, 20)) {
      console.error(`[aeds-only-policy] unknown ${item.file}:${item.lineNumber} ${item.signal}: ${item.line}`)
    }
    console.error(`[aeds-only-policy] blocked unknown=${report.unknown.length} report=${path.relative(root, reportPath)}`)
    process.exit(1)
  }
  console.log(`[aeds-only-policy] ok matches=${report.matchCount} mustMigrate=${report.counts['must-migrate'] ?? 0} report=${path.relative(root, reportPath)}`)
} catch (error) {
  console.error(`[aeds-only-policy] ${error.message}`)
  process.exit(1)
}
