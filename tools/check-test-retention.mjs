#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const defaultOut = path.join(root, '.tmp/release-evidence/test-retention-audit.json')
const retentionClasses = new Set(['must-keep', 'conditional', 'redundant-candidate', 'obsolete'])

function parseArgs(argv) {
  const options = { out: defaultOut }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') {
      options.out = path.resolve(root, argv[index + 1] ?? '')
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/check-test-retention.mjs [--out .tmp/release-evidence/test-retention-audit.json]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseMatrix(text) {
  const matrix = { tiers: [] }
  let current = null
  let inTiers = false

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (topMatch && !rawLine.startsWith(' ')) {
      if (topMatch[1] === 'tiers') {
        inTiers = true
        current = null
        continue
      }
      matrix[topMatch[1]] = parseValue(topMatch[2])
      continue
    }

    if (!inTiers) continue

    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (itemMatch) {
      current = {}
      matrix.tiers.push(current)
      current[itemMatch[1]] = parseValue(itemMatch[2])
      continue
    }

    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseValue(fieldMatch[2])
    }
  }

  return matrix
}

function toRepoPath(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    const relative = toRepoPath(absolute)
    if (entry.isDirectory()) {
      if (/(^|\/)(bin|obj|node_modules|dist|coverage|TestResults|test-results|\.tmp|\.artifacts)(\/|$)/.test(relative)) continue
      walk(absolute, files)
    } else {
      files.push(relative)
    }
  }
  return files
}

function isAuditedTestFile(file) {
  if (file.startsWith('tests/backend/')) {
    return /(?:Tests?|Fixture|Collection)\.cs$/.test(file)
      || /tests\/backend\/Fixtures\/.*\.(json|jsonc|sql|txt)$/.test(file)
  }
  if (file.startsWith('tests/frontend/')) {
    return /\.(test|spec)\.ts$/.test(file)
      || /tests\/frontend\/checks\/.*\.mjs$/.test(file)
      || /tests\/frontend\/support\/.*\.(mjs|ts)$/.test(file)
      || /tests\/frontend\/fixtures\/.*\.mjs$/.test(file)
  }
  if (file.startsWith('tools/test/')) {
    return /\.(sh|mjs)$/.test(file)
  }
  if (file.startsWith('tools/coverage/')) {
    return /\.(sh|mjs)$/.test(file)
  }
  return /^tools\/check-.*\.(mjs|sh)$/.test(file)
    || /^tools\/docs\/generate-testing-docs\.mjs$/.test(file)
    || /^tools\/check-workflow-matrix-sync\.mjs$/.test(file)
    || /^tools\/run-test-matrix\.mjs$/.test(file)
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function pathMatchesPattern(file, pattern) {
  if (!pattern || pattern.startsWith('.tmp/')) return false
  if (pattern.includes('*')) return wildcardToRegExp(pattern).test(file)
  if (file === pattern) return true
  return pattern.endsWith('/') ? file.startsWith(pattern) : file.startsWith(`${pattern}/`)
}

function addMapSet(map, key, value) {
  if (!key) return
  const bucket = map.get(key) ?? new Set()
  bucket.add(value)
  map.set(key, bucket)
}

function commandReferencedFiles(command) {
  const refs = []
  for (const token of String(command ?? '').split(/\s+/)) {
    const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\$/, '').replace(/^\.\//, '')
    if (!/^(tools|tests)\//.test(normalized)) continue
    if (fs.existsSync(path.join(root, normalized)) && fs.statSync(path.join(root, normalized)).isFile()) {
      refs.push(normalized)
    }
  }
  return refs
}

function assertionEstimate(file) {
  if (!/\.(cs|ts|mjs|js)$/.test(file)) return 0
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  if (file.endsWith('.cs')) {
    return (text.match(/\[(Fact|Theory)\b/g) ?? []).length
  }
  return (text.match(/\b(?:it|test)\s*\(/g) ?? []).length
}

function buildTextReferenceIndex(files) {
  const index = new Map()
  const supportTargets = files.filter((file) => (
    file.includes('/support/')
    || file.includes('/fixtures/')
    || file.includes('/Fixtures/')
    || file.endsWith('/_legacy.sh')
  ))

  for (const source of files) {
    if (!/\.(cs|ts|mjs|js|sh|json|jsonc)$/.test(source)) continue
    const text = fs.readFileSync(path.join(root, source), 'utf8')
    for (const target of supportTargets) {
      if (source === target) continue
      const basename = path.basename(target)
      if (!text.includes(target) && !text.includes(basename)) continue
      addMapSet(index, target, source)
    }
  }

  return index
}

function retentionClassForTier(tier) {
  if (retentionClasses.has(tier.retentionClass)) return tier.retentionClass
  return tier.requiredFor === 'release-final' || tier.risk === 'critical' ? 'must-keep' : 'conditional'
}

function buildAudit() {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const coverageRegistry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
  const fileToCoverage = new Map()
  const fileToTiers = new Map()
  const fileToTierRetention = new Map()
  const fileToCommandTiers = new Map()
  const auditedFiles = [...new Set([
    ...walk(path.join(root, 'tests')),
    ...walk(path.join(root, 'tools'))
  ])].filter(isAuditedTestFile).sort()
  const fileToTextReferences = buildTextReferenceIndex(auditedFiles)

  for (const entry of coverageRegistry.entries ?? []) {
    for (const evidencePath of entry.evidencePaths ?? []) {
      if (evidencePath.includes('*') || evidencePath.startsWith('.tmp/')) continue
      addMapSet(fileToCoverage, evidencePath, entry.id)
    }
  }

  for (const tier of matrix.tiers) {
    const tierRetention = retentionClassForTier(tier)
    for (const ref of commandReferencedFiles(tier.command)) {
      addMapSet(fileToCommandTiers, ref, tier.id)
    }
    for (const evidencePath of [...(tier.evidence ?? []), ...(tier.artifacts ?? [])]) {
      if (String(evidencePath).startsWith('.tmp/')) continue
      for (const file of auditedFiles) {
        if (!pathMatchesPattern(file, evidencePath)) continue
        addMapSet(fileToTiers, file, tier.id)
        addMapSet(fileToTierRetention, file, tierRetention)
      }
    }
  }

  const files = auditedFiles.map((file) => {
    const coverageIds = [...(fileToCoverage.get(file) ?? [])].sort()
    const tierIds = [...new Set([...(fileToTiers.get(file) ?? []), ...(fileToCommandTiers.get(file) ?? [])])].sort()
    const tierRetention = [...(fileToTierRetention.get(file) ?? [])].sort()
    const textReferences = [...(fileToTextReferences.get(file) ?? [])].sort()
    const reasons = []

    if (coverageIds.length > 0) reasons.push('coverage-registry-evidence')
    if ((fileToCommandTiers.get(file)?.size ?? 0) > 0) reasons.push('matrix-command-entrypoint')
    if (textReferences.length > 0) reasons.push('test-support-referenced')
    if (tierRetention.includes('must-keep')) reasons.push('must-keep-tier-evidence')
    if (tierRetention.includes('conditional')) reasons.push('conditional-tier-evidence')
    if (/(Contract|Governance|Security|Auth|Aeds|Binary|Protocol|Policy|Release|QualityGate|Matrix|Coverage|Endpoint|Permission|Po[wW]|Passkey|Privacy|Anonymous|Concurrency|Hydration|Public|Upload|Session)/.test(file)) {
      reasons.push('risk-contract-keyword')
    }
    if (/tests\/frontend\/(e2e|checks\/(perf|resilience|security|runtime)|benchmarks)\//.test(file) || /tools\/test\/lanes\/(backend-qps|load|resilience|visual|acceptance|cross-browser|production|release)/.test(file)) {
      reasons.push('conditional-heavy-lane-surface')
    }
    if (/obsolete/i.test(file) && coverageIds.length === 0 && tierIds.length === 0 && textReferences.length === 0) {
      reasons.push('name-only-obsolete-candidate')
    }

    let retentionClass = 'review-candidate'
    if (reasons.includes('name-only-obsolete-candidate')) {
      retentionClass = 'obsolete-candidate'
    }
    if (reasons.includes('conditional-heavy-lane-surface') || reasons.includes('conditional-tier-evidence')) {
      retentionClass = 'conditional'
    }
    if (coverageIds.length > 0 || reasons.includes('matrix-command-entrypoint') || reasons.includes('test-support-referenced') || reasons.includes('must-keep-tier-evidence') || reasons.includes('risk-contract-keyword')) {
      retentionClass = 'must-keep'
    }

    return {
      path: file,
      retentionClass,
      reasons: reasons.sort(),
      coverageIds,
      tierIds,
      referencedBy: textReferences,
      assertionEstimate: assertionEstimate(file)
    }
  })

  const counts = files.reduce((acc, file) => {
    acc[file.retentionClass] = (acc[file.retentionClass] ?? 0) + 1
    acc.assertionEstimate += file.assertionEstimate
    return acc
  }, { totalFiles: files.length, assertionEstimate: 0 })

  return {
    schema: 'fsusblog.test-retention-audit.v1',
    generatedAt: new Date().toISOString(),
    policy: {
      automaticDeletion: false,
      deletionRule: 'Only obsolete-candidate files with no coverage ids, no matrix tier references, and a human-reviewed replacement may be deleted.',
      ordinaryPr: 'Run must-keep and PR-default lanes; conditionally select heavy lanes by trigger metadata; record skipped lanes in PR smart gate evidence.',
      releaseFinal: 'Run the full matrix and require release-final evidence before tagging or publishing.'
    },
    counts,
    files,
    reviewCandidates: files.filter((file) => file.retentionClass === 'review-candidate').map((file) => file.path),
    obsoleteCandidates: files.filter((file) => file.retentionClass === 'obsolete-candidate').map((file) => file.path)
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  const audit = buildAudit()
  if (audit.counts.totalFiles === 0) {
    throw new Error('no test files were scanned')
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true })
  fs.writeFileSync(options.out, `${JSON.stringify(audit, null, 2)}\n`)
  console.log(`[test-retention] ok files=${audit.counts.totalFiles} assertions=${audit.counts.assertionEstimate} mustKeep=${audit.counts['must-keep'] ?? 0} conditional=${audit.counts.conditional ?? 0} review=${audit.counts['review-candidate'] ?? 0} obsolete=${audit.counts['obsolete-candidate'] ?? 0}`)
} catch (error) {
  console.error(`[test-retention] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
