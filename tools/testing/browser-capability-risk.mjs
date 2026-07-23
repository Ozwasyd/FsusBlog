#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogFile = path.join(root, 'tests/browser-capability-risk/catalog.json')
const knownProfiles = new Set([
  'browser-primary-correctness',
  'browser-capability-delta',
  'browser-full-matrix'
])

export function readBrowserCapabilityRiskCatalog(file = catalogFile) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function matchesPath(file, pattern) {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (pattern.endsWith('/**')) return normalized.startsWith(pattern.slice(0, -2))
  return normalized === pattern
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

export function validateBrowserCapabilityRiskCatalog(catalog, {
  matrixSource = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'),
  playwrightSource = [
    fs.readFileSync(path.join(root, 'src/frontend/playwright.config.ts'), 'utf8'),
    fs.readFileSync(path.join(root, 'src/frontend/playwright.diagnostics.config.ts'), 'utf8')
  ].join('\n'),
  testSources
} = {}) {
  const errors = []
  if (catalog.schema !== 'fsusblog.browser-capability-risk-catalog' || catalog.version !== 1) {
    errors.push('catalog schema/version must be fsusblog.browser-capability-risk-catalog v1')
  }
  const engines = new Set(catalog.engines ?? [])
  if (engines.size === 0) errors.push('catalog must declare engines')
  for (const engine of engines) {
    if (!new RegExp(`['"]${engine}['"]`, 'u').test(playwrightSource)) {
      errors.push(`catalog engine is missing from Playwright projects: ${engine}`)
    }
  }
  const profileNames = Object.keys(catalog.profiles ?? {})
  for (const profile of knownProfiles) {
    if (!profileNames.includes(profile)) errors.push(`missing required profile: ${profile}`)
  }
  for (const profile of profileNames) {
    if (!knownProfiles.has(profile)) errors.push(`unknown profile: ${profile}`)
  }
  if (!new RegExp(`- id: ${catalog.matrixTierId}\\b`, 'u').test(matrixSource)) {
    errors.push(`matrix tier is missing: ${catalog.matrixTierId}`)
  }
  const scenarios = new Map()
  const testIds = new Set()
  for (const scenario of catalog.scenarios ?? []) {
    if (!scenario.id || scenarios.has(scenario.id)) errors.push(`duplicate/empty scenario id: ${scenario.id}`)
    scenarios.set(scenario.id, scenario)
    if (!scenario.testId || testIds.has(scenario.testId)) errors.push(`duplicate/empty test id: ${scenario.testId}`)
    testIds.add(scenario.testId)
    if (!scenario.file || !fs.existsSync(path.join(root, scenario.file))) {
      errors.push(`scenario file is missing: ${scenario.id}/${scenario.file}`)
    }
    for (const engine of scenario.requiredEngines ?? []) {
      if (!engines.has(engine)) errors.push(`scenario uses unknown engine: ${scenario.id}/${engine}`)
    }
    for (const profile of scenario.profiles ?? []) {
      if (!knownProfiles.has(profile)) errors.push(`scenario uses unknown profile: ${scenario.id}/${profile}`)
    }
    const source = testSources?.[scenario.file]
      ?? (scenario.file && fs.existsSync(path.join(root, scenario.file))
        ? fs.readFileSync(path.join(root, scenario.file), 'utf8')
        : '')
    if (!source.includes(scenario.testId)) errors.push(`scenario test id is not executable: ${scenario.id}/${scenario.testId}`)
  }
  const riskIds = new Set()
  for (const risk of catalog.risks ?? []) {
    if (!risk.id || riskIds.has(risk.id)) errors.push(`duplicate/empty risk id: ${risk.id}`)
    riskIds.add(risk.id)
    if (!risk.triggers?.length) errors.push(`risk has no trigger closure: ${risk.id}`)
    if (!risk.requiredEngines?.length) errors.push(`risk has no required engine: ${risk.id}`)
    if (!risk.scenarioIds?.length) errors.push(`risk has no canonical scenario: ${risk.id}`)
    if (!risk.fallbackSemantics) errors.push(`risk has no fallback semantics: ${risk.id}`)
    if (!knownProfiles.has(risk.profileOwner)) errors.push(`risk has unknown profile owner: ${risk.id}`)
    for (const engine of risk.requiredEngines ?? []) {
      if (!engines.has(engine)) errors.push(`risk uses unknown engine: ${risk.id}/${engine}`)
    }
    for (const scenarioId of risk.scenarioIds ?? []) {
      const scenario = scenarios.get(scenarioId)
      if (!scenario) {
        errors.push(`risk references unknown scenario: ${risk.id}/${scenarioId}`)
        continue
      }
      const missing = risk.requiredEngines.filter((engine) => !scenario.requiredEngines.includes(engine))
      if (missing.length) errors.push(`scenario misses required engines: ${risk.id}/${scenarioId}/${missing.join(',')}`)
    }
    for (const evidenceId of risk.chromiumCanonicalEvidence ?? []) {
      if (!testIds.has(evidenceId)) errors.push(`risk references unknown Chromium evidence: ${risk.id}/${evidenceId}`)
    }
  }
  const referencedScenarios = new Set((catalog.risks ?? []).flatMap((risk) => risk.scenarioIds))
  for (const scenario of scenarios.values()) {
    if (!referencedScenarios.has(scenario.id)
      && !scenario.profiles.includes('browser-primary-correctness')) {
      errors.push(`orphan scenario: ${scenario.id}`)
    }
  }
  if (errors.length) throw new Error(`browser capability risk catalog is invalid:\n${errors.join('\n')}`)
  return catalog
}

export function selectBrowserCapabilityRisk({
  changedPaths = [],
  requestedProfile = null,
  catalog = readBrowserCapabilityRiskCatalog()
} = {}) {
  validateBrowserCapabilityRiskCatalog(catalog)
  const paths = uniqueSorted(changedPaths.map((value) => value.replaceAll('\\', '/').replace(/^\.\//u, '')))
  if (requestedProfile && !knownProfiles.has(requestedProfile)) {
    throw new Error(`unknown browser capability profile: ${requestedProfile}`)
  }
  const fullTriggered = paths.some((file) =>
    catalog.fullMatrixTriggers.some((pattern) => matchesPath(file, pattern)))
  const affectedRisks = catalog.risks.filter((risk) =>
    paths.some((file) => risk.triggers.some((pattern) => matchesPath(file, pattern))))
  const profile = requestedProfile
    ?? (fullTriggered
      ? 'browser-full-matrix'
      : affectedRisks.length > 0
        ? 'browser-capability-delta'
        : 'browser-primary-correctness')
  const selectedRisks = profile === 'browser-full-matrix'
    ? catalog.risks
    : profile === 'browser-capability-delta'
      ? requestedProfile
        ? catalog.risks
        : affectedRisks
      : []
  const selectedScenarioIds = profile === 'browser-primary-correctness'
    ? catalog.scenarios.filter((scenario) => scenario.profiles.includes(profile)).map((scenario) => scenario.id)
    : profile === 'browser-full-matrix'
      ? catalog.scenarios.filter((scenario) => scenario.profiles.includes(profile)).map((scenario) => scenario.id)
      : uniqueSorted(selectedRisks.flatMap((risk) => risk.scenarioIds))
  const selectedScenarios = catalog.scenarios.filter((scenario) => selectedScenarioIds.includes(scenario.id))
  const selectedEngines = uniqueSorted(selectedScenarios.flatMap((scenario) => scenario.requiredEngines))
  const coveredRiskIds = selectedRisks.map((risk) => risk.id).sort()
  for (const risk of selectedRisks) {
    const missingEngines = risk.requiredEngines.filter((engine) => !selectedEngines.includes(engine))
    if (missingEngines.length) {
      throw new Error(`coverage proof is incomplete for ${risk.id}: missing ${missingEngines.join(',')}`)
    }
  }
  return {
    schema: 'fsusblog.browser-capability-risk-proof',
    version: 1,
    catalogVersion: catalog.version,
    changedPaths: paths,
    selectionReason: requestedProfile
      ? `explicit-profile:${requestedProfile}`
      : fullTriggered
        ? 'catalog-or-playwright-governance-change'
        : affectedRisks.length
          ? 'capability-risk-trigger-closure'
          : 'no-engine-specific-risk-primary-correctness',
    profile,
    affectedRiskIds: coveredRiskIds,
    engines: selectedEngines,
    scenarios: selectedScenarios.map((scenario) => ({
      id: scenario.id,
      testId: scenario.testId,
      file: scenario.file,
      engines: scenario.requiredEngines
    })),
    excluded: catalog.scenarios
      .filter((scenario) => !selectedScenarioIds.includes(scenario.id))
      .map((scenario) => ({
        id: scenario.id,
        reason: profile === 'browser-primary-correctness'
          ? 'engine-specific risk closure not affected; Chromium canonical evidence is sufficient'
          : 'scenario is outside the selected capability-risk closure'
      }))
  }
}

function parseArgs(argv) {
  const options = { changedPaths: [], requestedProfile: null, output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--path') options.changedPaths.push(argv[++index])
    else if (value === '--paths-file') {
      options.changedPaths.push(...fs.readFileSync(argv[++index], 'utf8').split(/\r?\n/u).filter(Boolean))
    } else if (value === '--profile') options.requestedProfile = argv[++index]
    else if (value === '--output') options.output = argv[++index]
    else if (value === 'validate' || value === 'select') continue
    else throw new Error(`unknown browser capability risk argument: ${value}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'validate'
  const catalog = validateBrowserCapabilityRiskCatalog(readBrowserCapabilityRiskCatalog())
  if (command === 'validate') {
    process.stdout.write(`browser capability risk catalog v${catalog.version} valid\n`)
  } else if (command === 'select') {
    const options = parseArgs(process.argv.slice(2))
    const proof = selectBrowserCapabilityRisk(options)
    const serialized = `${JSON.stringify(proof, null, 2)}\n`
    if (options.output) {
      const output = path.resolve(root, options.output)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, serialized)
    }
    process.stdout.write(serialized)
  } else {
    throw new Error(`unknown command: ${command}`)
  }
}
