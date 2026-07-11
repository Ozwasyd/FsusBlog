#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  ASSET_COMPATIBILITY_EVIDENCE_SCHEMA,
  ASSET_COMPATIBILITY_SCENARIO_SCHEMA,
  normalizeAssetCompatibilityScenario,
  verifyAssetBrowserEvidenceBinding
} from './release-asset-compatibility-probe.mjs'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const REQUIRED_KINDS = Object.freeze(['javascript', 'stylesheet', 'wasm', 'font'])
const REQUIRED_SCENARIOS = Object.freeze([
  'delayedOldAssets', 'oldFrontendToNewBackend', 'newFrontendToOldBackend',
  'oldServiceWorkerCache', 'retentionWindowAfterGc'
])

try {
  const options = parseArgs(process.argv.slice(2))
  const report = verify(options)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.status !== 'pass') process.exitCode = 1
} catch (error) {
  process.stderr.write(`[release-asset-compatibility-evidence-verify] fatal: ${message(error)}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument near ${name ?? '<end>'}`)
    }
    const key = name.slice(2)
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument --${key}`)
    values[key] = value
  }
  for (const name of ['evidence', 'scenario', 'binding-key-file', 'rollout-id']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(values['rollout-id'])) throw new Error('--rollout-id is invalid')
  return {
    evidence: canonicalRegularFile(values.evidence, 'evidence'),
    scenario: canonicalRegularFile(values.scenario, 'scenario'),
    bindingKeyFile: canonicalPrivateFile(values['binding-key-file'], 'binding key file'),
    rolloutId: values['rollout-id']
  }
}

function verify(options) {
  const errors = []
  const evidence = readJson(options.evidence, 'asset compatibility evidence')
  const scenarioBytes = fs.readFileSync(options.scenario)
  const scenarioRaw = JSON.parse(scenarioBytes.toString('utf8'))
  if (scenarioRaw.schema !== ASSET_COMPATIBILITY_SCENARIO_SCHEMA || scenarioRaw.browser?.required !== true) {
    errors.push('scenario must require controlled browser evidence')
  }
  const scenario = normalizeAssetCompatibilityScenario(scenarioRaw)
  const key = fs.readFileSync(options.bindingKeyFile)
  if (key.length < 32 || key.length > 4096) errors.push('binding key must contain 32..4096 bytes')

  if (evidence.schema !== ASSET_COMPATIBILITY_EVIDENCE_SCHEMA || evidence.status !== 'pass') {
    errors.push('asset compatibility evidence schema/status is invalid')
  }
  if (evidence.rolloutId !== options.rolloutId) errors.push('rolloutId mismatch')
  if (evidence.sourceReleaseId !== scenario.oldReleaseId || evidence.targetReleaseId !== scenario.newReleaseId) {
    errors.push('source/target release identity mismatch')
  }
  if (!Array.isArray(evidence.errors) || evidence.errors.length !== 0) errors.push('asset compatibility errors must be empty')
  for (const field of ['notFoundCount', 'hashMismatchCount', 'connectionErrorCount']) {
    if (Number(evidence[field]) !== 0) errors.push(`${field} must be zero`)
  }
  for (const name of REQUIRED_SCENARIOS) {
    if (evidence.scenarios?.[name] !== 'pass') errors.push(`scenario missing or failed: ${name}`)
  }

  const browser = evidence.browser
  if (browser?.schema !== 'fsusblog.release-asset-browser-evidence.v1' || browser?.status !== 'pass') {
    errors.push('controlled browser evidence is missing or failed')
  }
  if (!browser?.browser?.name || !browser?.browser?.version
    || !path.isAbsolute(String(browser?.browser?.executablePath ?? ''))
    || !SHA256.test(String(browser?.browser?.executableSha256 ?? ''))) {
    errors.push('browser binary/version evidence is invalid')
  }
  if (browser?.bindings?.rolloutId !== options.rolloutId
    || browser?.bindings?.sourceReleaseId !== scenario.oldReleaseId
    || browser?.bindings?.targetReleaseId !== scenario.newReleaseId
    || browser?.bindings?.scenarioSha256 !== sha256(scenarioBytes)
    || !SHA256.test(String(browser?.bindings?.manifestSha256 ?? ''))
    || !SHA256.test(String(browser?.bindings?.gcEvidenceSha256 ?? ''))) {
    errors.push('browser input bindings are invalid')
  }
  if (browser?.beforeSwitch?.status !== 'pass'
    || browser?.beforeSwitch?.serviceWorker?.controller?.state !== 'activated') {
    errors.push('old page/service worker was not controlled before switch')
  }
  const delayed = Array.isArray(browser?.delayed?.resources) ? browser.delayed.resources : []
  for (const kind of REQUIRED_KINDS) {
    if (!delayed.some(resource => resource?.kind === kind && resource?.hashMatches === true)) {
      errors.push(`delayed browser resource is missing or failed: ${kind}`)
    }
  }
  if (browser?.afterSwitch?.status !== 'pass'
    || browser?.compatibility?.oldFrontendToNewBackend?.status !== 'pass'
    || browser?.compatibility?.newFrontendToOldBackend?.status !== 'pass') {
    errors.push('browser cross-switch/backend compatibility is incomplete')
  }
  const cacheReads = Array.isArray(browser?.afterGc?.cacheReads) ? browser.afterGc.cacheReads : []
  if (browser?.afterGc?.status !== 'pass' || cacheReads.length === 0
    || cacheReads.some(read => read?.cacheHit !== true || read?.hashMatches === false)) {
    errors.push('GC-after old page/SW/cache evidence is incomplete')
  }
  if (!Array.isArray(browser?.pageErrors) || browser.pageErrors.length !== 0
    || !Array.isArray(browser?.network?.failures)) {
    errors.push('browser error/network ledger is invalid')
  }

  const bindingVerification = verifyAssetBrowserEvidenceBinding(evidence, key)
  if (bindingVerification.status !== 'pass') errors.push(...bindingVerification.errors)
  key.fill(0)
  return {
    schema: 'fsusblog.release-asset-compatibility-evidence-verification.v1',
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: options.rolloutId,
    evidenceSha256: sha256(fs.readFileSync(options.evidence)),
    scenarioSha256: sha256(scenarioBytes),
    errors
  }
}

function canonicalRegularFile(file, label) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return fs.realpathSync(resolved)
}

function canonicalPrivateFile(file, label) {
  const resolved = canonicalRegularFile(file, label)
  const mode = fs.statSync(resolved).mode & 0o777
  if (![0o400, 0o600].includes(mode)) throw new Error(`${label} must have mode 0400 or 0600`)
  return resolved
}

function readJson(file, label) {
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error(`${label}: ${message(error)}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`)
  return value
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
