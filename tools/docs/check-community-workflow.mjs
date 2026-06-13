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

function includes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

const required = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/performance_report.yml',
  '.github/ISSUE_TEMPLATE/documentation.yml',
  '.github/ISSUE_TEMPLATE/deployment_support.yml',
  '.github/ISSUE_TEMPLATE/accessibility_ui.yml',
  '.github/ISSUE_TEMPLATE/governance_process.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/workflows/codeql.yml',
  '.github/workflows/scorecard.yml',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'SECURITY.md',
  'docs/open-source-readiness.md',
  'docs/repository-governance.md',
  'release-evidence/open-source-readiness/readiness-checklist.md'
]

const contents = new Map(required.map((path) => [path, read(path)]))
const newIssueForms = new Set([
  '.github/ISSUE_TEMPLATE/documentation.yml',
  '.github/ISSUE_TEMPLATE/deployment_support.yml',
  '.github/ISSUE_TEMPLATE/accessibility_ui.yml',
  '.github/ISSUE_TEMPLATE/governance_process.yml'
])

includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Version or commit')
includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Backend logs')
includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Frontend console errors')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'AEDS frame contract')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'Database schema')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'FsusUI visual system')
includes('.github/ISSUE_TEMPLATE/performance_report.yml', contents.get('.github/ISSUE_TEMPLATE/performance_report.yml'), 'Kestrel-only')
includes('.github/ISSUE_TEMPLATE/performance_report.yml', contents.get('.github/ISSUE_TEMPLATE/performance_report.yml'), 'Reverse proxy')
includes('.github/ISSUE_TEMPLATE/documentation.yml', contents.get('.github/ISSUE_TEMPLATE/documentation.yml'), 'Affected document path or URL')
includes('.github/ISSUE_TEMPLATE/documentation.yml', contents.get('.github/ISSUE_TEMPLATE/documentation.yml'), 'Documentation problem type')
includes('.github/ISSUE_TEMPLATE/documentation.yml', contents.get('.github/ISSUE_TEMPLATE/documentation.yml'), 'Expected correction')
includes('.github/ISSUE_TEMPLATE/documentation.yml', contents.get('.github/ISSUE_TEMPLATE/documentation.yml'), 'public-preview stability or release evidence')
includes('.github/ISSUE_TEMPLATE/deployment_support.yml', contents.get('.github/ISSUE_TEMPLATE/deployment_support.yml'), 'Deployment mode')
includes('.github/ISSUE_TEMPLATE/deployment_support.yml', contents.get('.github/ISSUE_TEMPLATE/deployment_support.yml'), 'PostgreSQL and Redis mode')
includes('.github/ISSUE_TEMPLATE/deployment_support.yml', contents.get('.github/ISSUE_TEMPLATE/deployment_support.yml'), 'Relevant environment variables')
includes('.github/ISSUE_TEMPLATE/deployment_support.yml', contents.get('.github/ISSUE_TEMPLATE/deployment_support.yml'), 'Reproduces on fresh demo seed data')
includes('.github/ISSUE_TEMPLATE/accessibility_ui.yml', contents.get('.github/ISSUE_TEMPLATE/accessibility_ui.yml'), 'Route, page, or component')
includes('.github/ISSUE_TEMPLATE/accessibility_ui.yml', contents.get('.github/ISSUE_TEMPLATE/accessibility_ui.yml'), 'Keyboard-only behavior')
includes('.github/ISSUE_TEMPLATE/accessibility_ui.yml', contents.get('.github/ISSUE_TEMPLATE/accessibility_ui.yml'), 'Screen reader or browser accessibility evidence')
includes('.github/ISSUE_TEMPLATE/accessibility_ui.yml', contents.get('.github/ISSUE_TEMPLATE/accessibility_ui.yml'), 'Reduced-motion behavior')
includes('.github/ISSUE_TEMPLATE/governance_process.yml', contents.get('.github/ISSUE_TEMPLATE/governance_process.yml'), 'Public-preview policy gap')
includes('.github/ISSUE_TEMPLATE/governance_process.yml', contents.get('.github/ISSUE_TEMPLATE/governance_process.yml'), 'Test gate or quality gate drift')
includes('.github/ISSUE_TEMPLATE/governance_process.yml', contents.get('.github/ISSUE_TEMPLATE/governance_process.yml'), 'Security-report routing process issue without vulnerability details')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'AEDS frame / binary contract')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'Database migration')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'Security, auth, moderation, PoW, or privacy')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'CODEOWNERS')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'github/codeql-action/init@v4')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'github/codeql-action/analyze@v4')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'security-events: write')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'actions: read')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'language: csharp')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'language: javascript-typescript')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/backend/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/frontend/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/shared/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), '/p:PublishClientAssets=false')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'ossf/scorecard-action@v2.4.3')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'github/codeql-action/upload-sarif@v4')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'security-events: write')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'id-token: write')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'publish_results: true')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'results_format: sarif')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'schedule:')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), '* @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), '.github/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'src/backend/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'src/frontend/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'docs/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'tools/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'release-evidence/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'SECURITY.md @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'src/backend/Infrastructure/Auth/ @Ozwasyd')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'docs/development.md')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'documentation reports')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'deployment/self-hosting reports')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'accessibility/UI reports')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'governance/process reports')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'SUPPORT.md')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'CODEOWNERS')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'docs/repository-governance.md')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'Public-Preview Stability Policy')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'SECURITY.md')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'no production SLA')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'SECURITY.md')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'Deployment / self-hosting report')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'tokens, API keys, passwords, session IDs, cookies')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'production domains')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'real IP addresses')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'real email addresses')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'production logs')
includes('SUPPORT.md', contents.get('SUPPORT.md'), 'database exports')
includes('SECURITY.md', contents.get('SECURITY.md'), 'Do not report security vulnerabilities as public GitHub issues')
includes('.github/ISSUE_TEMPLATE/config.yml', contents.get('.github/ISSUE_TEMPLATE/config.yml'), 'security/advisories/new')
includes('.github/ISSUE_TEMPLATE/config.yml', contents.get('.github/ISSUE_TEMPLATE/config.yml'), 'SUPPORT.md')
includes('.github/ISSUE_TEMPLATE/config.yml', contents.get('.github/ISSUE_TEMPLATE/config.yml'), 'blank_issues_enabled: false')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'Issue form taxonomy')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'Support routing')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'Repository governance')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'CodeQL code scanning')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'OpenSSF Scorecard posture scan')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'Workflow permissions default to `contents: read`')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Require a pull request before merge')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Quality Gate / Production Summary')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Dependency Review / Dependency Review')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'CodeQL / Analyze (csharp)')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'OpenSSF Scorecard / Scorecard')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Do not use repository write tokens in workflows that execute code from fork pull requests')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'No checks are ignored')
includes('release-evidence/open-source-readiness/readiness-checklist.md', contents.get('release-evidence/open-source-readiness/readiness-checklist.md'), 'CodeQL code scanning')
includes('release-evidence/open-source-readiness/readiness-checklist.md', contents.get('release-evidence/open-source-readiness/readiness-checklist.md'), 'OpenSSF Scorecard posture scan')
includes('release-evidence/open-source-readiness/readiness-checklist.md', contents.get('release-evidence/open-source-readiness/readiness-checklist.md'), 'Branch protection expectations')
includes('release-evidence/open-source-readiness/readiness-checklist.md', contents.get('release-evidence/open-source-readiness/readiness-checklist.md'), 'Workflow permissions policy')

for (const [path, source] of contents) {
  if (path.includes('ISSUE_TEMPLATE') && /security vulnerabilities as public issues[\s\S]*title:/i.test(source)) {
    errors.push(`${path} appears to route security reports into a public issue form`)
  }
  if (newIssueForms.has(path)) {
    includes(path, source, 'This is not a security vulnerability report')
    includes(path, source, 'I removed secrets')
  }
}

if (!/pull_request:\n/.test(contents.get('.github/workflows/codeql.yml'))) {
  errors.push('.github/workflows/codeql.yml must run on pull_request')
}

if (/pull_request/.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must not run on pull_request')
}

if (/secrets\./.test(contents.get('.github/workflows/codeql.yml'))) {
  errors.push('.github/workflows/codeql.yml must not read repository secrets')
}

if (/secrets\./.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must not read repository secrets')
}

contents.get('.github/CODEOWNERS').split('\n').forEach((line, index) => {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2 || !parts.slice(1).every((owner) => owner.startsWith('@'))) {
    errors.push(`.github/CODEOWNERS:${index + 1} invalid CODEOWNERS rule`)
  }
})

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[community-workflow] ${error}`)
  }
  process.exit(1)
}

console.log(`[community-workflow] ok files=${required.length}`)
