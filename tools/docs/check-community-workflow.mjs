#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
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
  '.github/workflows/dependency-review.yml',
  '.github/workflows/scorecard.yml',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'SECURITY.md',
  'docs/open-source-readiness.md',
  'docs/repository-governance.md',
  'docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'
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
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'github/codeql-action/init@')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), '# v4')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'github/codeql-action/analyze@')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'actions/upload-artifact@')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), '# v7')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'actions: read')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'upload: false')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'upload-database: false')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), '.tmp/codeql-results/${{ matrix.language }}')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'language: csharp')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'language: javascript-typescript')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/backend/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/frontend/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), 'src/shared/**')
includes('.github/workflows/codeql.yml', contents.get('.github/workflows/codeql.yml'), '/p:PublishClientAssets=false')
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), 'src/frontend/package-lock.json')
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), "'**/*.csproj'")
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), '.github/workflows/**')
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), 'fail-on-severity: high')
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), 'license-check: true')
includes('.github/workflows/dependency-review.yml', contents.get('.github/workflows/dependency-review.yml'), 'deny-licenses: AGPL-1.0, AGPL-3.0, GPL-1.0, GPL-2.0, GPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'ossf/scorecard-action@')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), '# v2.4.3')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'actions: read')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'issues: read')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'pull-requests: read')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'checks: read')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'publish_results: false')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'results_format: sarif')
includes('.github/workflows/scorecard.yml', contents.get('.github/workflows/scorecard.yml'), 'schedule:')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), '* @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), '.github/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'src/backend/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'src/frontend/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'docs/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'tools/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'security/evidence-contracts/ @Ozwasyd')
includes('.github/CODEOWNERS', contents.get('.github/CODEOWNERS'), 'tests/fixtures/evidence/ @Ozwasyd')
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
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'CodeQL scans C# backend/shared/core source')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'OpenSSF Scorecard posture scan')
includes('docs/open-source-readiness.md', contents.get('docs/open-source-readiness.md'), 'Workflow permissions default to `contents: read`')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Require a pull request before merge')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Quality Gate / Production Summary')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Dependency Review / Dependency Review')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'CodeQL / Analyze (csharp)')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'OpenSSF Scorecard / Scorecard')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Do not use repository write tokens in workflows that execute code from fork pull requests')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'No checks are ignored')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'private repositories to evaluate review and branch-protection signals')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'does not upload to Code Scanning while this private repository has code scanning disabled')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'checks: read')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Dependabot version updates are intentionally not configured')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Dependabot alerts')
includes('docs/repository-governance.md', contents.get('docs/repository-governance.md'), 'Dependabot security')
includes('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md', contents.get('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'), 'Historical snapshot — not current master evidence.')
includes('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md', contents.get('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'), 'CodeQL analysis')
includes('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md', contents.get('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'), 'OpenSSF Scorecard posture scan')
includes('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md', contents.get('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'), 'Branch protection expectations')
includes('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md', contents.get('docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md'), 'Workflow permissions policy')

for (const [path, source] of contents) {
  if (path.includes('ISSUE_TEMPLATE') && /security vulnerabilities as public issues[\s\S]*title:/i.test(source)) {
    errors.push(`${path} appears to route security reports into a public issue form`)
  }
  if (newIssueForms.has(path)) {
    includes(path, source, 'This is not a security vulnerability report')
    includes(path, source, 'I removed secrets')
  }
}

if (existsSync(resolve(root, '.github/dependabot.yml'))) {
  errors.push('.github/dependabot.yml must remain absent so routine Dependabot version-update PRs stay disabled')
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

if (/security-events:\s*write/.test(contents.get('.github/workflows/codeql.yml'))) {
  errors.push('.github/workflows/codeql.yml must stay read-only until code scanning is enabled')
}

if (!/upload:\s*false/.test(contents.get('.github/workflows/codeql.yml'))) {
  errors.push('.github/workflows/codeql.yml must keep CodeQL upload disabled while code scanning is unavailable')
}

if (/secrets\./.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must not read repository secrets')
}

if (/github\/codeql-action\/upload-sarif/.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must not upload SARIF until code scanning is enabled')
}

if (/security-events:\s*write/.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must stay read-only except documented metadata reads')
}

if (/id-token:\s*write/.test(contents.get('.github/workflows/scorecard.yml'))) {
  errors.push('.github/workflows/scorecard.yml must not request OIDC unless publish_results is enabled')
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
