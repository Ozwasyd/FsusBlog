#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const files = {
  auditLog: 'src/frontend/src/views/admin/AuditLog.vue',
  actionLabels: 'src/frontend/src/view-contracts/auditActionLabels.ts',
  moderationAudit: 'src/frontend/src/views/admin/moderation/ModerationAudit.vue',
  statusMatrix: 'src/frontend/src/components/admin/AdminStatusMatrix.vue',
  packageJson: 'src/frontend/package.json'
}

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const fail = (relativePath, message) => failures.push(`${relativePath}: ${message}`)

const expectIncludes = (relativePath, token, message) => {
  if (!read(relativePath).includes(token)) {
    fail(relativePath, message)
  }
}

const expectNotIncludes = (relativePath, token, message) => {
  if (read(relativePath).includes(token)) {
    fail(relativePath, message)
  }
}

expectNotIncludes(files.auditLog, '动作代码：', 'AuditLog must not render the legacy action-code prefix; use formatAuditAction/AuditActionLabel')
expectNotIncludes(files.actionLabels, '动作代码：', 'auditActionLabels fallback must not include the legacy action-code prefix')
expectIncludes(files.actionLabels, 'auditActionLabels', 'shared audit action label map must be exported')
expectIncludes(files.actionLabels, 'formatAuditAction', 'shared audit action formatter must be exported')

expectIncludes(files.auditLog, 'audit-facet-grid', 'AuditLog must render grouped facet sections instead of one flat tag row')
expectIncludes(files.auditLog, 'actionFacets', 'AuditLog must compute action facets for the matrix')
expectIncludes(files.auditLog, "selectFacet('action'", 'AuditLog action facets must toggle URL filters')
expectIncludes(files.auditLog, "selectFacet('outcome'", 'AuditLog outcome facets must toggle URL filters')
expectIncludes(files.auditLog, "selectFacet('severity'", 'AuditLog severity facets must toggle URL filters')
expectNotIncludes(files.auditLog, '<el-tag v-for="facet in summary?.actions', 'AuditLog must not regress to a flat action tag list')

expectNotIncludes(files.moderationAudit, "label: '词库已载入'", 'ModerationAudit must not keep a duplicate audit label map')
expectIncludes(files.moderationAudit, 'AuditActionLabel', 'ModerationAudit must consume the shared audit action label renderer')

expectIncludes(files.statusMatrix, 'bar?: { percent: number }', 'AdminStatusMatrixItem must support compact percent bars')
expectIncludes(files.statusMatrix, 'displayValue?: string | number', 'AdminStatusMatrixItem must separate active value keys from rendered values')
expectIncludes(files.statusMatrix, 'clickable?: boolean', 'AdminStatusMatrix must support clickable rows')
expectIncludes(files.statusMatrix, 'activeValue?: string | number', 'AdminStatusMatrix must support active row state')
expectIncludes(files.statusMatrix, "'item-click'", 'AdminStatusMatrix must emit item-click')
expectIncludes(files.statusMatrix, 'role="list"', 'AdminStatusMatrix must preserve list semantics')

const packageJson = JSON.parse(read(files.packageJson))
const scripts = packageJson.scripts ?? {}
if (scripts['check:audit-facet-summary'] !== 'node ../../tests/frontend/checks/static/check-audit-facet-summary.mjs') {
  fail(files.packageJson, 'check:audit-facet-summary script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:audit-facet-summary')) {
  fail(files.packageJson, 'check:views-constraints must run check:audit-facet-summary')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[audit-facet-summary] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[audit-facet-summary] ok')
