#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

const requiredStatusChecks = [
  ['image digest', (manifest) => manifest.evidenceSummary?.image?.status === 'present'],
  ['coverage', (manifest) => manifest.evidenceSummary?.coverage?.status === 'ok'],
  ['ZAP DAST', (manifest) => manifest.evidenceSummary?.security?.dastZap === 'ok'],
  ['attack matrix', (manifest) => manifest.evidenceSummary?.security?.attackMatrix === 'ok'],
  ['permission matrix', (manifest) => manifest.evidenceSummary?.security?.permissionMatrix === 'ok'],
  ['supply chain', (manifest) => manifest.evidenceSummary?.security?.supplyChain === 'ok'],
  ['SBOM', (manifest) => manifest.evidenceSummary?.security?.sbom === 'ok'],
  ['post deploy smoke', (manifest) => manifest.evidenceSummary?.operations?.postDeploySmoke === 'ok'],
  ['backup restore drill', (manifest) => manifest.evidenceSummary?.operations?.backupRestoreDrill === 'ok'],
  ['SLO alert replay', (manifest) => manifest.evidenceSummary?.operations?.sloAlerts === 'ok'],
  ['critical SLO alerts', (manifest) => Number(manifest.evidenceSummary?.operations?.sloCriticalFiring ?? 0) === 0],
  ['production status', (manifest) => manifest.evidenceSummary?.externalExposure?.status === 'ok'],
  ['firewall policy', (manifest) => manifest.evidenceSummary?.externalExposure?.firewallPolicy === 'present'],
  ['DNS readiness', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsReadiness === 'ok'],
  ['DNS delegation', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsDelegation === 'ok'],
  ['live exposure', (manifest) => manifest.evidenceSummary?.externalExposure?.liveExposure === 'ok'],
  ['frontend render pressure', (manifest) => manifest.evidenceSummary?.gates?.frontendRenderPressure === 'ok'],
  ['doc sync', (manifest) => manifest.evidenceSummary?.gates?.docSync === 'ok']
]

const requiredArtifacts = [
  'attackMatrix',
  'permissionMatrix',
  'dastZap',
  'supplyChain',
  'sbom',
  'postDeploySmoke',
  'backupRestoreDrill',
  'coverage',
  'uxViewportSummary',
  'frontendRenderPressureSummary',
  'docSyncSummary',
  'domBudgetSummary',
  'routeRenderPressureSummary',
  'markdownRenderBudgetSummary',
  'domDepthStaticSummary',
  'productionExposureStatus',
  'productionExposureLive',
  'firewallPolicy',
  'dnsReadiness',
  'dnsDelegation'
]

function fail(message) {
  console.error(`[release-manifest-check] ${message}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function latestManifest() {
  const baseDir = path.join(rootDir, '.tmp', 'release-evidence')
  if (!fs.existsSync(baseDir)) {
    return null
  }

  const candidates = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, 'manifest.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return candidates[0]?.file ?? null
}

function validateManifest(manifest, options = {}) {
  const errors = []
  if (!['collected-ok', 'collected-blocked'].includes(manifest.status)) {
    errors.push(`invalid status: ${String(manifest.status)}`)
  }

  if (!manifest.commitSha || !/^(unknown|[0-9a-f]{40})$/i.test(manifest.commitSha)) {
    errors.push('commitSha must be a full 40-character SHA or unknown')
  }

  if (!manifest.workflowRun || typeof manifest.workflowRun !== 'object') {
    errors.push('workflowRun object is required')
  }

  for (const key of requiredArtifacts) {
    if (!Object.hasOwn(manifest.artifacts ?? {}, key)) {
      errors.push(`artifacts.${key} is missing`)
    }
  }

  const missingRequired = requiredStatusChecks
    .filter(([, predicate]) => !predicate(manifest))
    .map(([label]) => label)

  if (missingRequired.length > 0 && manifest.status !== 'collected-blocked') {
    errors.push(`manifest must be collected-blocked when required evidence is missing or blocked: ${missingRequired.join(', ')}`)
  }

  if (missingRequired.length === 0 && manifest.status !== 'collected-ok') {
    errors.push('manifest must be collected-ok when every required evidence component is ok')
  }

  if (options.requireOk && manifest.status !== 'collected-ok') {
    errors.push(`release closeout requires collected-ok, got ${manifest.status}`)
  }

  for (const key of ['frontendRenderPressureSummary', 'docSyncSummary', 'domBudgetSummary', 'routeRenderPressureSummary', 'markdownRenderBudgetSummary', 'domDepthStaticSummary']) {
    if (manifest.artifacts?.[key] === null || manifest.artifacts?.[key] === undefined) {
      errors.push(`artifacts.${key} must point to a collected required summary`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    missingRequired
  }
}

function runSelfTest() {
  const base = {
    status: 'collected-ok',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    workflowRun: { id: '123', attempt: '1', workflow: 'Quality Gate' },
    imageDigest: 'sha256:abc',
    artifacts: Object.fromEntries(requiredArtifacts.map((key) => [key, `${key}.json`])),
    evidenceSummary: {
      image: { status: 'present' },
      coverage: { status: 'ok' },
      operations: {
        postDeploySmoke: 'ok',
        backupRestoreDrill: 'ok',
        sloAlerts: 'ok',
        sloCriticalFiring: 0
      },
      security: {
        dastZap: 'ok',
        attackMatrix: 'ok',
        permissionMatrix: 'ok',
        supplyChain: 'ok',
        sbom: 'ok'
      },
      gates: {
        frontendRenderPressure: 'ok',
        docSync: 'ok'
      },
      externalExposure: {
        status: 'ok',
        firewallPolicy: 'present',
        dnsReadiness: 'ok',
        dnsDelegation: 'ok',
        liveExposure: 'ok'
      }
    }
  }

  const ok = validateManifest(base)
  if (!ok.ok) {
    fail(`self-test expected ok manifest to pass: ${ok.errors.join('; ')}`)
  }

  const missingButOk = structuredClone(base)
  missingButOk.evidenceSummary.image.status = 'missing'
  const blockedExpectation = validateManifest(missingButOk)
  if (blockedExpectation.ok || !blockedExpectation.errors.some((error) => error.includes('collected-blocked'))) {
    fail('self-test expected missing image digest to require collected-blocked')
  }

  const blocked = structuredClone(missingButOk)
  blocked.status = 'collected-blocked'
  const blockedResult = validateManifest(blocked)
  if (!blockedResult.ok || !blockedResult.missingRequired.includes('image digest')) {
    fail(`self-test expected blocked missing-image manifest to pass schema: ${blockedResult.errors.join('; ')}`)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-manifest-'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('[release-manifest-check] self-test ok')
}

const args = process.argv.slice(2)
const requireOk = args.includes('--require-ok')
if (args.includes('--self-test')) {
  runSelfTest()
  process.exit(0)
}

const manifestArg = args.find((arg) => !arg.startsWith('--'))
const manifestPath = manifestArg ? path.resolve(manifestArg) : latestManifest()
if (!manifestPath) {
  fail('manifest path is required, or .tmp/release-evidence must contain at least one manifest.json')
}

const manifest = readJson(manifestPath)
const result = validateManifest(manifest, { requireOk })
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[release-manifest-check] violation: ${error}`)
  }
  process.exit(1)
}

console.log(`[release-manifest-check] ok | status=${manifest.status} missing=${result.missingRequired.length} file=${manifestPath}`)
