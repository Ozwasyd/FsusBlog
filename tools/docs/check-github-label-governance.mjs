#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`missing ${path}`)
    return ''
  }
}

function requireIncludes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

function parseInlineLabels(source) {
  const match = source.match(/^labels:\s*\[(?<labels>[^\]]*)\]/m)
  if (!match?.groups?.labels) {
    return []
  }
  return match.groups.labels
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function expectExactLabels(path, expected) {
  const actual = parseInlineLabels(read(path))
  const actualSorted = [...actual].sort()
  const expectedSorted = [...expected].sort()
  if (actualSorted.join('|') !== expectedSorted.join('|')) {
    errors.push(`${path} labels expected [${expectedSorted.join(', ')}] but got [${actualSorted.join(', ')}]`)
  }
}

const labels = [
  'type:bug',
  'type:feature',
  'type:docs',
  'type:performance',
  'type:maintenance',
  'type:security-hardening',
  'area:backend',
  'area:frontend',
  'area:public-site',
  'area:admin',
  'area:auth',
  'area:moderation',
  'area:aeds',
  'area:api',
  'area:contracts',
  'area:database',
  'area:deployment',
  'area:docs',
  'area:ci',
  'area:github',
  'area:tooling',
  'risk:breaking-change',
  'risk:migration',
  'risk:security-sensitive',
  'risk:public-preview-policy',
  'status:triage',
  'status:needs-info',
  'status:accepted',
  'status:blocked',
  'status:duplicate',
  'status:not-planned',
  'evidence:needs-repro',
  'evidence:needs-tests',
  'evidence:needs-docs',
  'evidence:needs-screenshot'
]

const taxonomy = read('docs/repository-labels.md')
for (const label of labels) {
  requireIncludes('docs/repository-labels.md', taxonomy, `\`${label}\``)
}
requireIncludes('docs/repository-labels.md', taxonomy, 'no workflow closes issues solely because of age')
requireIncludes('docs/repository-labels.md', taxonomy, 'Security vulnerabilities must stay out of public issues')

expectExactLabels('.github/ISSUE_TEMPLATE/bug_report.yml', ['type:bug', 'status:triage', 'evidence:needs-repro'])
expectExactLabels('.github/ISSUE_TEMPLATE/feature_request.yml', ['type:feature', 'status:triage'])
expectExactLabels('.github/ISSUE_TEMPLATE/performance_report.yml', ['type:performance', 'status:triage'])
expectExactLabels('.github/ISSUE_TEMPLATE/documentation.yml', ['type:docs', 'area:docs', 'status:triage', 'evidence:needs-docs'])
expectExactLabels('.github/ISSUE_TEMPLATE/deployment_support.yml', ['type:maintenance', 'area:deployment', 'status:triage', 'evidence:needs-repro'])
expectExactLabels('.github/ISSUE_TEMPLATE/accessibility_ui.yml', ['type:bug', 'area:frontend', 'area:public-site', 'status:triage', 'evidence:needs-screenshot'])
expectExactLabels('.github/ISSUE_TEMPLATE/governance_process.yml', ['type:maintenance', 'area:github', 'risk:public-preview-policy', 'status:triage', 'evidence:needs-docs'])

const labeler = read('.github/labeler.yml')
for (const token of [
  '"area:github"',
  '"area:ci"',
  '"area:backend"',
  '"area:frontend"',
  '"area:public-site"',
  '"area:api"',
  '"area:contracts"',
  '"area:aeds"',
  '"area:database"',
  '"area:deployment"',
  '"area:docs"',
  '"area:tooling"',
  '"risk:public-preview-policy"',
  '"risk:security-sensitive"',
  '.github/**',
  'src/backend/**',
  'src/frontend/**',
  'src/frontend/src/components/public/**',
  'src/backend/Modules/Endpoints/**',
  'src/shared/**',
  'docs/**',
  'tools/**',
  'ops/**',
  'config/deployment/**',
  'tools/deployment/**',
  'release-evidence/**'
]) {
  requireIncludes('.github/labeler.yml', labeler, token)
}

const labelerWorkflow = read('.github/workflows/labeler.yml')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'pull_request_target:')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'pull-requests: write')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'contents: read')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'actions/labeler@')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, '# v6')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'configuration-path: .github/labeler.yml')
requireIncludes('.github/workflows/labeler.yml', labelerWorkflow, 'sync-labels: true')

const issueTriage = read('.github/workflows/issue-triage.yml')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, 'issues:')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, 'issues: write')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, 'actions/github-script@')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, '# v8')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, 'status:triage')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, 'status:needs-info')
requireIncludes('.github/workflows/issue-triage.yml', issueTriage, '_No response_')
if (/state:\s*['"]?closed|stale|close-issue|days-before/i.test(issueTriage)) {
  errors.push('.github/workflows/issue-triage.yml must not auto-close or stale public issues')
}

const staticGovernance = read('tools/test/lanes/static-governance.sh')
requireIncludes('tools/test/lanes/static-governance.sh', staticGovernance, 'tools/docs/check-github-label-governance.mjs')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[github-label-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[github-label-governance] ok labels=${labels.length}`)
