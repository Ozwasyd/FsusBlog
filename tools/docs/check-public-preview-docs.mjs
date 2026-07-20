#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

export const ProductPolicyPaths = Object.freeze([
  'ROADMAP.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'docs/architecture/overview.md',
  'docs/api/stability.md',
  'docs/known-limitations.md',
  'docs/open-source-readiness.md',
  'docs/repository-governance.md',
  'docs/repository-labels.md',
  'docs/releases/public-preview-policy.md'
])

const ProductSemVerPattern = /\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/giu
const CanonicalReleaseHeadingPattern = /^## \d{14}-[0-9a-f]{12}$/mu

export function ValidateProductVersionGovernance(contents) {
  const errors = []
  const get = (path) => contents.get(path) ?? ''
  const includes = (path, token) => {
    if (!get(path).includes(token)) {
      errors.push(`${path} missing ${token}`)
    }
  }

  for (const path of ProductPolicyPaths) {
    for (const line of get(path).split(/\r?\n/u)) {
      const matches = [...line.matchAll(ProductSemVerPattern)]
      const historicalContext = /\b(?:historical|legacy|provenance)\b/iu.test(line)
      for (const match of matches) {
        if (!historicalContext) {
          errors.push(`${path} uses product SemVer ${match[0]} in an active policy source`)
        }
      }
    }
  }

  for (const line of get('README.md').split(/\r?\n/u)) {
    const productPromise = /(?:FsusBlog\s+v\d+\.\d+\.\d+|(?:\b(?:before|until|from|during)\b|在|从|直到)[^\n]*\bv\d+\.\d+\.\d+)/iu.test(line)
    const historicalContext = /\b(?:historical|legacy|provenance)\b/iu.test(line)
    if (productPromise && !historicalContext) {
      errors.push('README.md uses product SemVer as a current status or compatibility boundary')
    }
  }

  for (const token of [
    '**Public Preview**',
    'API Stability: Experimental',
    'Deployment: Self-hosting preview',
    'Production SLA: none',
    'canonical ReleaseId',
    'docs/releases/public-preview-policy.md'
  ]) {
    includes('README.md', token)
  }

  for (const token of [
    'Current Public Preview',
    'Localization and Public UX',
    'Distributed Runtime',
    'Plugin, Theme and Font Ecosystem',
    'Completion condition',
    'not product versions or delivery-date promises'
  ]) {
    includes('ROADMAP.md', token)
  }

  for (const token of [
    'Internal / Experimental',
    'Documented Stable Extension Point',
    'Standard External Protocol',
    'Maintainer-Facing Deployment / Operations Contract',
    'dedicated stability document',
    'RSS',
    'Atom',
    'JSON Feed',
    'Sitemap',
    'robots.txt',
    'health probes'
  ]) {
    includes('docs/api/stability.md', token)
  }

  for (const path of [
    '.github/ISSUE_TEMPLATE/accessibility_ui.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/deployment_support.yml',
    '.github/ISSUE_TEMPLATE/performance_report.yml',
    '.github/ISSUE_TEMPLATE/documentation.yml',
    '.github/ISSUE_TEMPLATE/governance_process.yml'
  ]) {
    includes(path, 'Release ID or full commit SHA')
    includes(path, '20260720143025-32a785eabb20')
  }

  if (!CanonicalReleaseHeadingPattern.test(get('CHANGELOG.md'))) {
    errors.push('CHANGELOG.md missing canonical ReleaseId heading example')
  }
  includes('CHANGELOG.md', '## Unreleased')
  includes('CHANGELOG.md', 'Product SemVer is not a release coordinate')
  includes('src/backend/CHANGELOG.md', 'Historical / Legacy Changelog')
  includes('src/backend/CHANGELOG.md', '不补造 ReleaseId')
  includes('src/backend/CHANGELOG.md', '## [1.0.0]')

  includes('docs/releases/public-preview-policy.md', 'current source of truth')
  includes('docs/releases/v1.1.0-public-preview.md', 'Historical / Legacy')
  includes('docs/releases/v1.1.0-public-preview.md', 'not current master policy')
  includes('README.md', 'legacy product-version label')

  const index = get('docs/index.md')
  const currentPolicyLinks = index.match(/\]\(releases\/public-preview-policy\.md\)/gu) ?? []
  if (currentPolicyLinks.length !== 1) {
    errors.push(`docs/index.md must list exactly one current preview policy; found ${currentPolicyLinks.length}`)
  }
  if (!/## Historical[\s\S]*\]\(releases\/v1\.1\.0-public-preview\.md\)/u.test(index)) {
    errors.push('docs/index.md must classify the legacy preview policy as Historical')
  }

  return errors
}

function ReadRepositorySources() {
  const errors = []
  const paths = new Set([
    ...ProductPolicyPaths,
    'README.md',
    'docs/index.md',
    'docs/releases/v1.1.0-public-preview.md',
    'src/backend/CHANGELOG.md',
    '.github/ISSUE_TEMPLATE/accessibility_ui.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/deployment_support.yml',
    '.github/ISSUE_TEMPLATE/performance_report.yml',
    '.github/ISSUE_TEMPLATE/documentation.yml',
    '.github/ISSUE_TEMPLATE/governance_process.yml'
  ])
  const contents = new Map()
  for (const path of paths) {
    try {
      contents.set(path, readFileSync(resolve(root, path), 'utf8'))
    } catch {
      errors.push(`missing ${path}`)
      contents.set(path, '')
    }
  }
  return { contents, errors }
}

function Main() {
  const { contents, errors } = ReadRepositorySources()
  errors.push(...ValidateProductVersionGovernance(contents))
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[public-preview-docs] ${error}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`[public-preview-docs] ok activePolicies=${ProductPolicyPaths.length}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Main()
}
