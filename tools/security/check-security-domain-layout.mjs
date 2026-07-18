#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evidenceClassificationErrors } from '../operations/evidence-classification.mjs'

const toolFile = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(toolFile), '..', '..')
const defaultCatalog = 'security/catalog/security-domain.json'
const expectedDomains = new Set(['matrices', 'policies', 'zk-contracts', 'zk-provenance', 'evidence-contracts'])
const legacyPaths = [
  /security\/(?:backend-source-policy\.json|zap-warn-policy\.yml|(?:asvs-v5\.0\.0|wstg-v4\.2|webauthn|risk-control-test|perception-v2-test|privacy-zk-comment)-matrix\.yml)/u,
  /security\/privacy\/comment-privacy-credential-vault\.release-plan\.json/u,
  /security\/zk\/(?:artifact-ownership|comment-v2-(?:circuit|feasibility|local-review|tamper-cases|trusted-setup)|comment-v5-(?:circuit|tamper-cases|trusted-setup))\.manifest\.json/u
]
const ignoredRoots = new Set(['.git', '.tmp', 'bin', 'build', 'coverage', 'dist', 'node_modules', 'obj'])
const legacyReferenceFixtures = new Set([
  'tests/test-retention-before.json',
  'tests/tools/issue-1170-security-domain-layout.test.mjs',
  'tests/tools/issue-1170-security-matrix-catalog.test.mjs'
])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function repoPath(value) {
  return value.replaceAll(path.sep, '/')
}

function readJson(root, relative, errors, label = relative) {
  const absolute = resolveFile(root, relative, errors, label)
  if (!absolute) return null
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    errors.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function resolveFile(root, relative, errors, label = relative) {
  if (!text(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
    errors.push(`${label} must be a repository-relative path`)
    return ''
  }
  const absolute = path.resolve(root, relative)
  const boundary = path.relative(path.resolve(root), absolute)
  if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    errors.push(`${label} escapes the repository root`)
    return ''
  }
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    errors.push(`${label} is missing or is not a regular file`)
    return ''
  }
  return absolute
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(root, relative, errors, { skipIgnored = false } = {}) {
  const files = []
  const visit = (current) => {
    const absolute = path.join(root, current)
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (skipIgnored && ignoredRoots.has(entry.name)) continue
      const child = repoPath(path.join(current, entry.name))
      const stat = fs.lstatSync(path.join(root, child))
      if (stat.isSymbolicLink()) {
        errors.push(`security domain must not contain symlink: ${child}`)
      } else if (stat.isDirectory()) {
        visit(child)
      } else if (stat.isFile()) {
        files.push(child)
      } else {
        errors.push(`security domain contains unsupported entry: ${child}`)
      }
    }
  }
  if (fs.existsSync(path.join(root, relative))) visit(relative)
  else errors.push(`missing directory: ${relative}`)
  return files.sort()
}

function validateCatalog(root, catalog, securityFiles, errors) {
  if (catalog?.schema !== 'fsusblog.security-domain.v1') errors.push('security domain schema must be fsusblog.security-domain.v1')
  if (!/^\d+\.\d+\.\d+$/u.test(text(catalog?.version))) errors.push('security domain version must be semver')
  if (catalog?.owner !== 'ServerContractAgent') errors.push('security domain owner must be ServerContractAgent')
  if (catalog?.failClosed !== true) errors.push('security domain must declare failClosed=true')

  const allowed = array(catalog?.allowedTopLevelDirectories)
  if (new Set(allowed).size !== allowed.length || allowed.some(entry => !text(entry) || entry.includes('/'))) {
    errors.push('allowedTopLevelDirectories must contain unique path segments')
  }
  const actualTop = new Set(securityFiles.map(file => file.split('/')[1]).filter(Boolean))
  for (const entry of actualTop) if (!allowed.includes(entry)) errors.push(`flat or undeclared security root entry: security/${entry}`)
  for (const file of securityFiles.filter(file => file.split('/').length === 2)) {
    errors.push(`security root files are forbidden: ${file}`)
  }

  const domains = array(catalog?.domains)
  const ids = domains.map(domain => text(domain?.id))
  if (domains.length !== expectedDomains.size || new Set(ids).size !== ids.length) {
    errors.push('security domain catalog must declare five unique domains')
  }
  for (const id of expectedDomains) if (!ids.includes(id)) errors.push(`security domain catalog is missing ${id}`)
  for (const domain of domains) {
    if (domain.owner !== 'ServerContractAgent') errors.push(`${domain.id || '<missing>'} owner must be ServerContractAgent`)
    const domainRoot = text(domain.root)
    if (!domainRoot.startsWith('security/') || domainRoot.includes('..')) errors.push(`${domain.id || '<missing>'} has invalid root`)
    for (const checker of [...array(domain.checkers), text(domain.checker)].filter(Boolean)) {
      resolveFile(root, checker, errors, `${domain.id} checker`)
    }
    if (domain.id === 'matrices') {
      const matrixCatalog = readJson(root, domain.catalog, errors, 'security matrix catalog')
      if (matrixCatalog && matrixCatalog.schema !== 'fsusblog.security-matrix-catalog.v1') {
        errors.push('security matrix catalog schema must be fsusblog.security-matrix-catalog.v1')
      }
      continue
    }
    const declared = array(domain.documents).map(text).sort()
    const actual = securityFiles.filter(file => file.startsWith(`${domainRoot}/`)).sort()
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      errors.push(`${domain.id} document inventory must exactly match ${domainRoot}`)
    }
    for (const document of declared) resolveFile(root, document, errors, `${domain.id} document`)
  }
}

function validatePolicies(root, errors) {
  const policy = readJson(root, 'security/policies/backend-source-policy.json', errors)
  if (policy) {
    if (policy.schema !== 'fsusblog.backend-security-source-policy.v2' || policy.policyId !== 'backend-security-source'
      || !/^\d+\.\d+\.\d+$/u.test(text(policy.version)) || !text(policy.owner)
      || policy.analyzer?.failClosed !== true || array(policy.documentation).length < 2) {
      errors.push('backend source policy identity, ownership, documentation and fail-closed metadata are incomplete')
    }
    const ids = new Set()
    for (const rule of array(policy.rules)) {
      const id = text(rule?.id)
      if (!id || ids.has(id)) errors.push(`backend source policy has duplicate or missing rule id ${id || '<missing>'}`)
      ids.add(id)
      if (rule?.severity !== 'error' || !text(rule?.rationale)
        || rule?.pathScope !== 'repository-relative-include-globs' || array(rule?.include).length === 0
        || array(rule?.include).some(scope => !text(scope).startsWith('src/backend/') || text(scope).includes('..'))) {
        errors.push(`backend source policy rule ${id || '<missing>'} lacks severity, rationale, or safe path scope`)
      }
    }
  }

  const zapPath = resolveFile(root, 'security/policies/zap-warn-policy.yml', errors)
  if (zapPath) {
    const zap = fs.readFileSync(zapPath, 'utf8')
    for (const token of [
      'schema: fsusblog.zap-warn-policy.v2',
      'policyId: zap-warn-exceptions',
      'failClosed: true',
      'kind: passive-warning-exception',
      'severity: warning',
      'rationale:',
      'pathScope:'
    ]) if (!zap.includes(token)) errors.push(`ZAP policy is missing ${token}`)
  }
}

function validateZk(root, securityFiles, errors) {
  const zkRootFiles = securityFiles.filter(file => file.startsWith('security/zk/') && file.split('/').length === 3)
  for (const file of zkRootFiles) errors.push(`ZK root files are forbidden: ${file}`)
  const manifests = securityFiles.filter(file => file.startsWith('security/zk/') && file.endsWith('.json'))
  for (const relative of manifests) {
    const document = readJson(root, relative, errors)
    if (!document) continue
    if (!text(document.artifact_class) || !text(document.lifecycle) || typeof document.production_usable !== 'boolean'
      || !text(document.circuit_id) || !Number.isInteger(document.public_input_layout_version)
      || document.public_input_layout_version <= 0) {
      errors.push(`${relative} must declare artifact_class, lifecycle, production_usable, circuit_id and public_input_layout_version`)
    }
    if (relative.startsWith('security/zk/contracts/') && !text(document.artifact_class).endsWith('contract')) {
      errors.push(`${relative} artifact_class must identify a contract`)
    }
    if (relative.startsWith('security/zk/provenance/') && !text(document.artifact_class).includes('provenance')) {
      errors.push(`${relative} artifact_class must identify provenance`)
    }
  }

  const setup = readJson(root, 'security/zk/provenance/comment-v2-trusted-setup.manifest.json', errors)
  const circuitPath = 'security/zk/contracts/comment-v2-circuit.manifest.json'
  const circuitFile = resolveFile(root, circuitPath, errors)
  if (setup && circuitFile) {
    if (setup.circuit_manifest_path !== circuitPath) errors.push('v2 trusted setup must bind the contract circuit path')
    if (setup.circuit_manifest_sha256 !== sha256(circuitFile)) errors.push('v2 trusted setup circuit manifest SHA-256 drift')
  }
  const review = readJson(root, 'security/zk/provenance/comment-v2-local-review.manifest.json', errors)
  for (const [name, binding] of Object.entries(object(review?.artifact_bindings))) {
    const bound = resolveFile(root, binding?.path, errors, `local review binding ${name}`)
    if (bound && binding.sha256 !== sha256(bound)) errors.push(`local review binding ${name} SHA-256 drift`)
  }
}

function validateEvidenceContracts(root, securityFiles, errors) {
  for (const relative of securityFiles.filter(file => file.startsWith('security/evidence-contracts/'))) {
    if (!relative.endsWith('.json')) {
      errors.push(`evidence contracts must be classified JSON: ${relative}`)
      continue
    }
    const document = readJson(root, relative, errors)
    if (!document) continue
    for (const error of evidenceClassificationErrors(document)) errors.push(`${relative}: ${error}`)
    if (!new Set(['contract', 'implementation-attestation']).has(document.evidenceClass)) {
      errors.push(`${relative} has invalid static evidence class ${String(document.evidenceClass)}`)
    }
  }
}

function validateRuntimeSelections(root, catalog, errors) {
  for (const selection of array(catalog?.runtimeSelections)) {
    const file = resolveFile(root, selection?.path, errors, 'runtime selection')
    if (!file) continue
    const source = fs.readFileSync(file, 'utf8')
    if (!text(selection.circuitManifest).startsWith('security/zk/contracts/') || !source.includes(selection.circuitManifest)) {
      errors.push(`${selection.path} must select a ZK contract manifest`)
    }
    if (!(text(selection.trustedSetupManifest).startsWith('security/zk/provenance/')
      || text(selection.trustedSetupManifest).startsWith('/app/config/zk/'))
      || !source.includes(selection.trustedSetupManifest)) {
      errors.push(`${selection.path} must select trusted setup provenance or its packaged runtime path`)
    }
  }
  const packaging = object(catalog?.runtimePackaging)
  const dockerfile = resolveFile(root, packaging.dockerfile, errors, 'security runtime packaging Dockerfile')
  if (packaging.source !== 'security/zk/contracts/'
    || packaging.containerPath !== '/app/security/zk/contracts/'
    || packaging.trustedSetupMount !== '/app/config/zk/') {
    errors.push('security runtime packaging must separate immutable contracts from mounted trusted-setup provenance')
  }
  if (dockerfile) {
    const source = fs.readFileSync(dockerfile, 'utf8')
    const copy = 'COPY --chown=$APP_UID:$APP_UID security/zk/contracts/ ./security/zk/contracts/'
    if (source.split(copy).length !== 3) errors.push('release and debug images must package the canonical ZK contracts directory')
  }
}

function validateNoLegacyReferences(root, errors) {
  const scanErrors = []
  for (const relative of walk(root, '.', scanErrors, { skipIgnored: true })) {
    if (legacyReferenceFixtures.has(relative)) continue
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute)
    if (stat.size > 1024 * 1024 || (stat.mode & 0o111) !== 0 && relative.startsWith('security/')) {
      if ((stat.mode & 0o111) !== 0 && relative.startsWith('security/')) errors.push(`security document must not be executable: ${relative}`)
      continue
    }
    const bytes = fs.readFileSync(absolute)
    if (bytes.includes(0)) continue
    const source = bytes.toString('utf8')
    for (const pattern of legacyPaths) if (pattern.test(source)) errors.push(`legacy flat security path remains in ${relative}`)
  }
  errors.push(...scanErrors.filter(error => error.startsWith('security domain')))
}

export function checkSecurityDomainLayout({ root = defaultRoot, catalogPath = defaultCatalog } = {}) {
  const errors = []
  const catalog = readJson(root, catalogPath, errors, 'security domain catalog')
  const securityFiles = walk(root, 'security', errors)
  if (catalog) {
    validateCatalog(root, catalog, securityFiles, errors)
    validateRuntimeSelections(root, catalog, errors)
  }
  validatePolicies(root, errors)
  validateZk(root, securityFiles, errors)
  validateEvidenceContracts(root, securityFiles, errors)
  validateNoLegacyReferences(root, errors)
  return [...new Set(errors)].sort()
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') options.root = args[++index]
    else if (args[index].startsWith('--root=')) options.root = args[index].slice('--root='.length)
    else if (args[index] === '--catalog') options.catalogPath = args[++index]
    else if (args[index].startsWith('--catalog=')) options.catalogPath = args[index].slice('--catalog='.length)
    else throw new Error(`unknown option ${args[index]}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile) {
  try {
    const errors = checkSecurityDomainLayout(parseArgs(process.argv.slice(2)))
    if (errors.length > 0) {
      for (const error of errors) console.error(`[security-domain] ${error}`)
      process.exit(1)
    }
    console.log('[security-domain] ok: matrices, policies, ZK contracts, ZK provenance and evidence contracts are isolated')
  } catch (error) {
    console.error(`[security-domain] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
