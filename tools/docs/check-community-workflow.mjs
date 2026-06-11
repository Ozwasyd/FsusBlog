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
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'CONTRIBUTING.md',
  'SECURITY.md'
]

const contents = new Map(required.map((path) => [path, read(path)]))

includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Version or commit')
includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Backend logs')
includes('.github/ISSUE_TEMPLATE/bug_report.yml', contents.get('.github/ISSUE_TEMPLATE/bug_report.yml'), 'Frontend console errors')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'AEDS frame contract')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'Database schema')
includes('.github/ISSUE_TEMPLATE/feature_request.yml', contents.get('.github/ISSUE_TEMPLATE/feature_request.yml'), 'FsusUI visual system')
includes('.github/ISSUE_TEMPLATE/performance_report.yml', contents.get('.github/ISSUE_TEMPLATE/performance_report.yml'), 'Kestrel-only')
includes('.github/ISSUE_TEMPLATE/performance_report.yml', contents.get('.github/ISSUE_TEMPLATE/performance_report.yml'), 'Reverse proxy')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'AEDS frame / binary contract')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'Database migration')
includes('.github/PULL_REQUEST_TEMPLATE.md', contents.get('.github/PULL_REQUEST_TEMPLATE.md'), 'Security, auth, moderation, PoW, or privacy')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'docs/development.md')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'Public-Preview Stability Policy')
includes('CONTRIBUTING.md', contents.get('CONTRIBUTING.md'), 'SECURITY.md')
includes('SECURITY.md', contents.get('SECURITY.md'), 'Do not report security vulnerabilities as public GitHub issues')
includes('.github/ISSUE_TEMPLATE/config.yml', contents.get('.github/ISSUE_TEMPLATE/config.yml'), 'security/advisories/new')

for (const [path, source] of contents) {
  if (path.includes('ISSUE_TEMPLATE') && /security vulnerabilities as public issues[\s\S]*title:/i.test(source)) {
    errors.push(`${path} appears to route security reports into a public issue form`)
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[community-workflow] ${error}`)
  }
  process.exit(1)
}

console.log(`[community-workflow] ok files=${required.length}`)
