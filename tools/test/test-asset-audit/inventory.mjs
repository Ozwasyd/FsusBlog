import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { buildGovernancePolicyInventory } from '../governance-suite-plan.mjs'

export { compareAuditSnapshots } from './comparison.mjs'

function startsWithAny(value, prefixes = []) {
  return prefixes.some((prefix) => value.startsWith(prefix))
}

function layerMatches(record, layer) {
  if (!layer.frameworks.includes(record.framework)) return false
  if (layer.pathPrefixes?.length > 0 && !startsWithAny(record.path, layer.pathPrefixes)) return false
  if (startsWithAny(record.path, layer.excludePathPrefixes)) return false
  return true
}

export function assignAuditRecords(records, layers) {
  const assignments = []
  const errors = []
  for (const record of records) {
    const owners = layers.filter((layer) => layerMatches(record, layer)).map((layer) => layer.id)
    if (owners.length !== 1) {
      errors.push(`${record.id} must have exactly one audit layer owner; found ${owners.length}: ${owners.join(', ')}`)
      continue
    }
    assignments.push({
      id: record.id,
      path: record.path,
      framework: record.framework,
      layerId: owners[0],
      invocationCount: record.invocationCount ?? 0,
      tierIds: record.tierIds ?? [],
      assertionTargets: record.assertionTargets ?? [],
      riskTags: record.riskTags ?? [],
      coverageIds: record.coverageIds ?? [],
      uniqueEvidence: record.uniqueEvidence ?? false,
      replacementTestIds: record.replacementTestIds ?? []
    })
  }
  return { assignments, errors }
}

function walkProductionFiles(root, relativeDirectory, files = []) {
  const absoluteDirectory = path.join(root, relativeDirectory)
  if (!fs.existsSync(absoluteDirectory)) return files
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) walkProductionFiles(root, relative, files)
    else if (/\.(?:ts|vue)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(relative)
  }
  return files
}

export function frontendCoverageUniverse(root) {
  const files = walkProductionFiles(root, 'src/frontend/src').sort()
  const configPath = path.join(root, 'src/frontend/vitest.config.ts')
  const digest = createHash('sha256')
    .update(files.join('\n'))
    .update('\0')
    .update(fs.readFileSync(configPath))
    .digest('hex')
  return {
    includePatterns: ['src/**/*.ts', 'src/**/*.vue', 'tests/frontend/support/playwright/testSession.ts'],
    config: 'src/frontend/vitest.config.ts',
    fileCount: files.length,
    files,
    identity: digest
  }
}

export function buildAuditInventory(root, retentionAudit, profile) {
  const { assignments, errors } = assignAuditRecords(retentionAudit.testRecords ?? [], profile.layers)
  const ids = assignments.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) errors.push('audit test ID union contains duplicates')
  return {
    schema: 'fsusblog.test-asset-audit-inventory.v1',
    source: retentionAudit.sourceState,
    counts: retentionAudit.counts,
    testIds: ids.sort(),
    assignments,
    governancePolicyOwners: buildGovernancePolicyInventory(retentionAudit.testRecords ?? []),
    frontendCoverageUniverse: frontendCoverageUniverse(root),
    retention: {
      reviewCandidates: retentionAudit.reviewCandidates ?? [],
      replaceableCandidates: retentionAudit.replaceableCandidates ?? [],
      obsoleteCandidates: retentionAudit.obsoleteCandidates ?? [],
      deletedTests: retentionAudit.deletedTests ?? [],
      tierReplacements: retentionAudit.tierReplacements ?? []
    },
    errors
  }
}
