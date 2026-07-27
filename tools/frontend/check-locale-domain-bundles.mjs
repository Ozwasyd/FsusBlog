#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const repoRoot = resolve(process.cwd(), '../..')
const distRoot = resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT || resolve(repoRoot, 'src/frontend/dist'))
const manifestPath = process.env.FSUSBLOG_VITE_MANIFEST
  ? resolve(repoRoot, process.env.FSUSBLOG_VITE_MANIFEST)
  : resolve(distRoot, '.vite/manifest.json')
const evidencePath = resolve(
  process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? resolve(repoRoot, '.tmp/frontend'),
  'locale-domain-bundles.json')
const catalog = JSON.parse(await readFile(
  resolve(repoRoot, 'src/shared/Contracts/Localization/locale-catalog.json'),
  'utf8'))
const locales = catalog.locales
  .filter((locale) => locale.status === 'enabled')
  .map((locale) => locale.code)
const domainSource = await readFile(
  resolve(repoRoot, 'src/frontend/src/locales/localeDomains.ts'),
  'utf8')
const domainMatch = domainSource.match(
  /export const LOCALE_DOMAINS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u)
if (!domainMatch) fail('cannot locate the locale domain catalog')
const domains = [...domainMatch[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
if (domains.length === 0 || domains.length !== new Set(domains).size) {
  fail('locale domain catalog must be a non-empty exact union')
}
const resolvedInitialScenarios = Object.freeze([
  { name: 'Public Home ja-JP', locale: 'ja-JP', domains: ['common', 'layout', 'public'] },
  { name: 'Public Article de-DE', locale: 'de-DE', domains: ['common', 'layout', 'public', 'article'] },
  { name: 'Login fr-FR', locale: 'fr-FR', domains: ['common', 'layout', 'public', 'auth', 'errors'] },
  { name: 'Account Messages ru-RU', locale: 'ru-RU', domains: ['common', 'layout', 'admin', 'errors', 'messages'] },
  { name: 'Admin Security ko-KR', locale: 'ko-KR', domains: ['common', 'layout', 'admin', 'errors', 'security'] }
])

function fail(message) {
  console.error(`[check-locale-domain-bundles] ${message}`)
  process.exit(1)
}

if (process.env.SKIP_I18N_GATE === '1' || process.env.SKIP_LOCALE_DOMAIN_BUNDLES === '1') {
  fail('skip/bypass environment variables are forbidden')
}

/**
 * Structured initial-graph diagnostic for fixtures and evidence consumers.
 * @param {{ locale: string, domain: string, file?: string }} entry
 */
export function initialGraphDiagnostic(entry) {
  return {
    locale: entry.locale,
    domain: entry.domain,
    key: '',
    file: entry.file ?? `locale-${entry.locale}-${entry.domain}`,
    rule: 'initial-entry-locale-static',
    expected: 'locale domain chunk resolved before render, not static initial',
    actual: 'present in initial entry graph'
  }
}

if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const entries = []
const violations = []
const manifestKeys = Object.keys(manifest)

function requestFilesFor(key) {
  const visited = new Set()
  const files = new Set()
  const visit = (currentKey) => {
    if (visited.has(currentKey)) return
    visited.add(currentKey)
    const current = manifest[currentKey]
    if (!current?.file) return
    files.add(current.file)
    for (const css of current.css ?? []) files.add(css)
    for (const importedKey of current.imports ?? []) visit(importedKey)
  }
  visit(key)
  return files
}

const initialFiles = new Set()
for (const key of manifestKeys.filter((candidate) => manifest[candidate]?.isEntry)) {
  for (const file of requestFilesFor(key)) initialFiles.add(file)
}

for (const locale of locales) {
  for (const domain of domains) {
    const sourceSuffix = `src/locales/${locale}/${domain}.ts`
    const identity = `${locale}/${domain}`
    const sourceKey = manifestKeys.find((candidate) => candidate.endsWith(sourceSuffix))
    const groupedKey = manifestKeys.find((candidate) =>
      candidate.startsWith(`_locale-${locale}-${domain}-`))
    const key = sourceKey ?? groupedKey
    const entry = key ? manifest[key] : null
    if (!key || !entry?.file) {
      violations.push({ locale, domain, reason: 'manifest_entry_missing' })
      continue
    }
    const expectedChunkName = `locale-${locale}-${domain}`
    if (entry.name !== expectedChunkName || !entry.file.includes(expectedChunkName)) {
      violations.push({
        locale,
        domain,
        reason: 'chunk_identity_drift',
        expectedChunkName,
        actualName: entry.name,
        file: entry.file
      })
      continue
    }
    const requestFiles = [...requestFilesFor(key)]
      .filter((file) => !initialFiles.has(file))
      .sort()
    const isInitial = initialFiles.has(entry.file)
    if (isInitial) {
      violations.push({
        ...initialGraphDiagnostic({ locale, domain, file: entry.file }),
        reason: 'locale_domain_must_be_resolved_before_render_not_statically_initial'
      })
    }
    const bytes = await readFile(resolve(distRoot, entry.file))
    entries.push({
      locale,
      domain,
      source: sourceKey ?? key,
      file: entry.file,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
      brotliBytes: brotliCompressSync(bytes).byteLength,
      firstRequestCount: requestFiles.length,
      firstRequestFiles: requestFiles
    })
  }
}

const expectedEntryCount = locales.length * domains.length
if (entries.length !== expectedEntryCount
  || new Set(entries.map((entry) => `${entry.locale}/${entry.domain}`)).size !== expectedEntryCount
  || new Set(entries.map((entry) => entry.file)).size !== expectedEntryCount) {
  violations.push({
    reason: 'locale_domain_entry_identity_not_exact',
    expectedEntryCount,
    actualEntryCount: entries.length,
    uniqueFileCount: new Set(entries.map((entry) => entry.file)).size
  })
}

const forbiddenInitial = entries.filter((entry) =>
  initialFiles.has(entry.file))
if (forbiddenInitial.length > 0) {
  violations.push({
    reason: 'unrequired_locale_domain_in_initial_graph',
    entries: forbiddenInitial.map(({ locale, domain, file }) => ({ locale, domain, file }))
  })
}

const entryByIdentity = new Map(entries.map((entry) => [
  `${entry.locale}/${entry.domain}`,
  entry
]))
const scenarioEvidence = resolvedInitialScenarios.map((scenario) => {
  const scenarioEntries = scenario.domains.map((domain) =>
    entryByIdentity.get(`${scenario.locale}/${domain}`))
  if (scenarioEntries.some((entry) => !entry)) {
    violations.push({
      reason: 'resolved_initial_scenario_entry_missing',
      name: scenario.name
    })
  }
  const requestFiles = new Set(scenarioEntries.flatMap((entry) =>
    entry?.firstRequestFiles ?? []))
  return {
    ...scenario,
    entries: scenarioEntries.filter(Boolean).map(({ locale, domain, file }) => ({
      locale,
      domain,
      file
    })),
    firstRequestCount: requestFiles.size,
    firstRequestFiles: [...requestFiles].sort()
  }
})

const evidence = {
  schema: 'fsusblog.locale-domain-bundles.v2',
  manifestPath,
  entries: entries.sort((left, right) =>
    `${left.locale}/${left.domain}`.localeCompare(`${right.locale}/${right.domain}`)),
  initialGraphLocaleDomains: [],
  resolvedInitialScenarios: scenarioEvidence,
  violations
}
await mkdir(dirname(evidencePath), { recursive: true })
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
if (violations.length > 0) fail(`blocked ${JSON.stringify(violations)}`)
console.log(`[check-locale-domain-bundles] ok entries=${entries.length} evidence=${evidencePath}`)
