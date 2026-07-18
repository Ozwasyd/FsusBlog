#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const outDir = path.resolve(root, process.env.FSUSBLOG_OPEN_SOURCE_READINESS_OUT_DIR ?? '.tmp/open-source-readiness')
const jsonOut = path.join(outDir, 'dependency-license-audit.json')
const mdOut = path.join(outDir, 'dependency-license-audit.md')
const deniedPattern = /\b(?:AGPL|GPL|LGPL|SSPL)\b/iu

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 })
  return result.status === 0 ? result.stdout : ''
}

function npmPackages() {
  const lock = readJson('src/frontend/package-lock.json')
  return Object.entries(lock.packages ?? {})
    .filter(([name]) => name.startsWith('node_modules/'))
    .map(([name, pkg]) => ({
      ecosystem: 'npm',
      name: name.replace(/^node_modules\//u, ''),
      version: pkg.version ?? null,
      license: pkg.license ?? null,
      source: 'src/frontend/package-lock.json'
    }))
}

function nugetPackages() {
  const lockFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', ':(glob)**/packages.lock.json'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((file) => !/(?:^|\/)(?:\.tmp|tmp|docs\/reports\/open-source-readiness)(?:\/|$)/u.test(file))
  const packages = new Map()
  for (const file of lockFiles) {
    const lock = readJson(file)
    for (const target of Object.values(lock.dependencies ?? {})) {
      for (const [name, meta] of Object.entries(target)) {
        const key = `${name}@${meta.resolved ?? meta.requested ?? 'unknown'}`
        packages.set(key, {
          ecosystem: 'nuget',
          name,
          version: meta.resolved ?? meta.requested ?? null,
          license: null,
          source: file,
          type: meta.type ?? null
        })
      }
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function enrichNpmLicense(pkg) {
  if (pkg.license) return pkg
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`)
    if (!response.ok) return pkg
    const data = await response.json()
    return { ...pkg, license: data.license ?? data.versions?.[pkg.version]?.license ?? null }
  } catch {
    return pkg
  }
}

async function enrichNuGetLicense(pkg) {
  if (pkg.name.toLowerCase().startsWith('fsusblog.')) {
    return { ...pkg, license: 'Apache-2.0', projectUrl: 'local-project-reference' }
  }
  try {
    const id = pkg.name.toLowerCase()
    const response = await fetch(`https://api.nuget.org/v3/registration5-gz-semver2/${id}/index.json`)
    if (!response.ok) return pkg
    const data = await response.json()
    const pages = data.items ?? []
    const matchingPages = pages.filter((page) => page.items || versionInRange(pkg.version, page.lower, page.upper))
    const expandedPages = []
    for (const page of matchingPages.length > 0 ? matchingPages : pages) {
      if (page.items) {
        expandedPages.push(page)
        continue
      }
      if (!page['@id']) continue
      const pageResponse = await fetch(page['@id'])
      if (!pageResponse.ok) continue
      expandedPages.push(await pageResponse.json())
    }
    const items = expandedPages.flatMap((page) => page.items ?? [])
    const match = items.find((item) => item.catalogEntry?.version?.toLowerCase() === String(pkg.version ?? '').toLowerCase())
      ?? items.find((item) => item.catalogEntry?.id?.toLowerCase() === id)
    const entry = match?.catalogEntry
    return {
      ...pkg,
      license: entry?.licenseExpression ?? (entry?.licenseUrl ? `licenseUrl:${entry.licenseUrl}` : null),
      projectUrl: entry?.projectUrl ?? null
    }
  } catch {
    return pkg
  }
}

function versionParts(version) {
  return String(version ?? '')
    .split(/[.+-]/u)
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function versionInRange(version, lower, upper) {
  if (!version || !lower || !upper) return false
  return compareVersions(version, lower) >= 0 && compareVersions(version, upper) <= 0
}

function classify(pkg) {
  const license = String(pkg.license ?? '')
  if (!license) return { status: 'unknown', reason: 'license metadata missing' }
  if (deniedPattern.test(license)) return { status: 'denied', reason: license }
  return { status: 'ok', reason: license }
}

function writeEvidence(summary) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
  const lines = [
    '# Dependency License Audit',
    '',
    `Status: ${summary.status}`,
    `Generated at: ${summary.generatedAt}`,
    '',
    '## Policy',
    '',
    '- Repository code license: Apache-2.0.',
    '- Denied dependency license families for public preview: AGPL, GPL, LGPL, SSPL.',
    '- GitHub Dependency Review is configured in `.github/workflows/dependency-review.yml` with the same denied families.',
    '',
    '## Scope',
    '',
    `- npm packages audited: ${summary.counts.npm}`,
    `- NuGet packages audited: ${summary.counts.nuget}`,
    `- Unknown license metadata: ${summary.unknown.length}`,
    `- Denied licenses: ${summary.denied.length}`,
    '',
    '## Unknown Metadata',
    ''
  ]
  if (summary.unknown.length === 0) lines.push('None.')
  else for (const item of summary.unknown) lines.push(`- ${item.ecosystem}:${item.name}@${item.version ?? 'unknown'} (${item.source})`)
  lines.push('', '## Denied Licenses', '')
  if (summary.denied.length === 0) lines.push('None.')
  else for (const item of summary.denied) lines.push(`- ${item.ecosystem}:${item.name}@${item.version ?? 'unknown'} ${item.license}`)
  fs.writeFileSync(mdOut, `${lines.join('\n')}\n`)
}

const npm = []
for (const pkg of npmPackages()) npm.push(await enrichNpmLicense(pkg))
const nuget = []
for (const pkg of nugetPackages()) nuget.push(await enrichNuGetLicense(pkg))
const packages = [...npm, ...nuget].map((pkg) => ({ ...pkg, audit: classify(pkg) }))
const denied = packages.filter((pkg) => pkg.audit.status === 'denied')
const unknown = packages.filter((pkg) => pkg.audit.status === 'unknown')
const summary = {
  schema: 'fsusblog.open-source.dependency-license-audit.v1',
  status: denied.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  policy: {
    repositoryLicense: 'Apache-2.0',
    deniedFamilies: ['AGPL', 'GPL', 'LGPL', 'SSPL']
  },
  counts: {
    npm: npm.length,
    nuget: nuget.length,
    total: packages.length
  },
  denied,
  unknown,
  packages
}
writeEvidence(summary)
console.log(`[open-source-license-audit] ${summary.status} packages=${packages.length} denied=${denied.length} unknown=${unknown.length}`)
if (denied.length > 0) process.exit(1)
