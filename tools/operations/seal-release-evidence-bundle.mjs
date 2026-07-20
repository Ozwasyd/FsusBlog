#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertReleaseIdentity } from '../release/release-id.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..', '..')
const storageContractPath = 'security/evidence-contracts/release-bundle-storage.json'
const indexFileName = 'release-index.json'
const manifestFileName = 'manifest.json'

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function listBundleFiles(bundleDirectory) {
  const files = []
  const visit = (relativeDirectory = '') => {
    const absoluteDirectory = path.join(bundleDirectory, relativeDirectory)
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name).replaceAll('\\', '/')
      if (relative === manifestFileName || relative === indexFileName) continue
      const absolute = path.join(bundleDirectory, relative)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${relative}`)
      if (stat.isDirectory()) visit(relative)
      else if (stat.isFile()) files.push({ relative, absolute, stat })
      else throw new Error(`bundle contains an unsupported filesystem entry: ${relative}`)
    }
  }
  visit()
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function artifactName(contract, releaseId) {
  return contract.authority.artifactNameTemplate
    .replace('{releaseId}', releaseId)
}

function buildStorage(contract, manifest, environment) {
  const releaseId = String(manifest.releaseIdentity?.releaseId ?? environment.FSUSBLOG_RELEASE_ID ?? '')
  const name = artifactName(contract, releaseId || 'unbound')
  const workflowRunId = String(environment.GITHUB_RUN_ID ?? manifest.workflowRun?.id ?? 'unknown')
  const repository = String(environment.GITHUB_REPOSITORY ?? 'Ozwasyd/FsusBlog')
  const derivedReference = /^\d+$/u.test(workflowRunId)
    ? `github-actions://${repository}/actions/runs/${workflowRunId}/artifacts/${name}`
    : null
  const storageReference = environment.FSUSBLOG_RELEASE_EVIDENCE_STORAGE_REFERENCE ?? derivedReference
  return {
    schema: 'fsusblog.release-evidence-storage-binding.v1',
    authority: contract.authority.type,
    contractPath: storageContractPath,
    workflow: contract.authority.workflow,
    workflowRunId,
    artifactName: name,
    storageReference,
    immutable: contract.authority.immutableWithinWorkflowRun,
    overwriteAllowed: contract.authority.overwriteAllowed,
    retention: structuredClone(contract.retention),
    publicationState: 'pending-immutable-upload'
  }
}

function buildInventory(bundleDirectory) {
  const files = listBundleFiles(bundleDirectory).map(({ relative, absolute, stat }) => ({
    path: relative,
    bytes: stat.size,
    sha256: `sha256:${sha256(fs.readFileSync(absolute))}`
  }))
  return {
    schema: 'fsusblog.release-evidence-artifact-inventory.v1',
    algorithm: 'sha256',
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    artifactSetSha256: `sha256:${sha256(canonicalJson(files))}`,
    files
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function sealReleaseEvidenceBundle(bundleDirectory, options = {}) {
  const bundle = path.resolve(bundleDirectory)
  const manifestPath = path.join(bundle, manifestFileName)
  const indexPath = path.join(bundle, indexFileName)
  fs.rmSync(indexPath, { force: true })
  if (!fs.statSync(bundle, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`bundle directory is missing: ${bundle}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const contract = JSON.parse(fs.readFileSync(path.join(repositoryRoot, storageContractPath), 'utf8'))
  const releaseId = manifest.releaseIdentity?.releaseId ?? null
  let canonicalIdentity = false
  try {
    assertReleaseIdentity({
      releaseId,
      createdAtUtc: manifest.releaseIdentity?.createdAtUtc,
      commitSha: manifest.commitSha
    })
    canonicalIdentity = true
  } catch {}
  const identityOk = canonicalIdentity
    && /^sha256:[0-9a-f]{64}$/u.test(String(manifest.imageDigest ?? ''))
    && manifest.releaseIdentity?.commitSha === manifest.commitSha
    && manifest.releaseIdentity?.imageDigest === manifest.imageDigest
  const closeoutCandidate = options.releaseCloseout === true
    && identityOk
    && manifest.status === 'collected-ok'

  manifest.schema = 'fsusblog.release-evidence-manifest.v2'
  manifest.evidenceClass = closeoutCandidate
    ? 'release-closeout-evidence'
    : 'fresh-run-evidence'
  manifest.freshExecution = true
  manifest.releaseBound = identityOk
  manifest.productionFreshRun = manifest.status === 'collected-ok'
  manifest.generatedFrom = {
    kind: 'release-evidence-collector',
    source: 'tools/operations/collect-release-evidence.sh'
  }
  manifest.targetEnvironment = manifest.targetEnvironment
    ?? (options.environment ?? process.env).FSUSBLOG_RELEASE_ENVIRONMENT
    ?? 'production'
  manifest.targetTopology = {
    releaseSlot: manifest.releaseIdentity?.releaseSlot ?? null,
    runtimeProfileId: manifest.releaseIdentity?.runtimeProfile?.id ?? null
  }
  manifest.releaseId = releaseId
  manifest.releaseNamespace = options.releaseNamespace
    ?? process.env.FSUSBLOG_RELEASE_NAMESPACE
    ?? manifest.releaseStamp
  manifest.storage = buildStorage(contract, manifest, options.environment ?? process.env)
  manifest.artifactInventory = buildInventory(bundle)
  writeJsonAtomic(manifestPath, manifest)
  return { manifestPath, manifest }
}

function bundleDigest(manifestPath, inventory) {
  const manifestSha256 = `sha256:${sha256(fs.readFileSync(manifestPath))}`
  return {
    manifestSha256,
    evidenceBundleSha256: `sha256:${sha256(canonicalJson({ manifestSha256, files: inventory.files }))}`
  }
}

export function writeReleaseIndexAfterRequireOk(bundleDirectory, options = {}) {
  const bundle = path.resolve(bundleDirectory)
  const sealed = sealReleaseEvidenceBundle(bundle, { ...options, releaseCloseout: true })
  const checker = options.checkerPath
    ?? path.join(repositoryRoot, 'tools/operations/check-release-evidence-manifest.mjs')
  const checked = spawnSync(process.execPath, [checker, sealed.manifestPath, '--require-ok'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  if (checked.status !== 0) {
    sealReleaseEvidenceBundle(bundle, { ...options, releaseCloseout: false })
    throw new Error(`release index requires successful --require-ok validation: ${checked.stderr || checked.stdout}`)
  }
  const manifest = JSON.parse(fs.readFileSync(sealed.manifestPath, 'utf8'))
  const digest = bundleDigest(sealed.manifestPath, manifest.artifactInventory)
  const index = {
    schema: 'fsusblog.release-evidence-index.v1',
    releaseId: manifest.releaseId,
    commitSha: manifest.commitSha,
    imageDigest: manifest.imageDigest,
    evidenceBundleSha256: digest.evidenceBundleSha256,
    storageReference: manifest.storage.storageReference,
    status: 'collected-ok',
    generatedAt: manifest.generatedAt,
    retentionDays: manifest.storage.retention.days
  }
  writeJsonAtomic(path.join(bundle, indexFileName), index)
  return { ...sealed, index, ...digest }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === scriptPath) {
  const args = process.argv.slice(2)
  const requireOk = args.includes('--require-ok')
  const bundleArg = args.find(arg => !arg.startsWith('--'))
  if (!bundleArg) {
    console.error('usage: seal-release-evidence-bundle.mjs <bundle-directory> [--require-ok]')
    process.exit(2)
  }
  try {
    const result = requireOk
      ? writeReleaseIndexAfterRequireOk(bundleArg)
      : sealReleaseEvidenceBundle(bundleArg)
    console.log(`[release-evidence-seal] ok files=${result.manifest.artifactInventory.fileCount} index=${requireOk ? 'written' : 'not-requested'}`)
  } catch (error) {
    console.error(`[release-evidence-seal] ${error.message}`)
    process.exit(1)
  }
}
