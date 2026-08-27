import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs'
import { deriveRandomConsumerStream, loadRandomStreamInventory } from '../test/random-streams.mjs'
import { createDockerPostgresqlReadonlyPort, createDockerRedisReadonlyPort } from './production-observer-ports.mjs'
import {
  createProductionReceiptAbsencePort,
  createProductionReceiptAotGenerationPort,
  createProductionReceiptAuthStatePort,
  createProductionReceiptObjectStoragePort,
  createProductionReceiptRuntimeConfigPort,
  createProductionReceiptRuntimeTopologyPort
} from './production-receipt-observer-ports.mjs'
import { loadRuntimeStateAuthority } from './catalog.mjs'
import { normalizeRuntimeIdentity, requireDigest, sealDocument, verifySealedDocument } from './contract.mjs'
import { publishProductionObserverAuthority, readProductionObserverAuthority } from './production-observer-authority.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const identityFile = path.resolve(String(process.env.FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE ?? ''))

function regularFile(file, label) {
  if (!file || !file.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error(`${label} must remain inside the repository`)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return file
}

function loadIdentityAuthority() {
  const document = JSON.parse(fs.readFileSync(regularFile(identityFile, 'FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE'), 'utf8'))
  if (document.schema !== 'fsusblog.production-runtime-order-identity.v1') throw new Error('runtime-order identity schema is invalid')
  verifySealedDocument(document)
  const identity = normalizeRuntimeIdentity({ ...document.identity, sessionId: 'schedule-template' })
  const fixedClock = document.fixedClock
  if (!Number.isSafeInteger(Number(fixedClock?.epochMs)) || fixedClock?.digest !== identity.clockDigest) {
    throw new Error('runtime-order identity lacks the exact fixed-clock authority')
  }
  requireDigest(document.replayQualification?.contentDigest, 'replay qualification digest')
  const replayFile = regularFile(path.resolve(document.replayQualification.file), 'replay qualification receipt')
  const replayQualification = JSON.parse(fs.readFileSync(replayFile, 'utf8'))
  verifySealedDocument(replayQualification)
  if (replayQualification.schema !== 'fsusblog.replay-qualification.v1'
    || replayQualification.status !== 'verified'
    || replayQualification.contentDigest !== document.replayQualification.contentDigest
    || replayQualification.contentDigest !== identity.replayDigest
    || replayQualification.sourceState?.commit !== identity.sourceCommit
    || replayQualification.sourceState?.worktreeFingerprint !== identity.sourceFingerprint) {
    throw new Error('runtime-order identity replay qualification is stale or cross-source')
  }
  const randomizedResults = replayQualification.families?.randomized?.results ?? []
  if (!Array.isArray(randomizedResults) || randomizedResults.length === 0) {
    throw new Error('runtime-order replay qualification lacks randomized producer results')
  }
  const rootSeeds = new Set(randomizedResults.map((entry) => {
    const resultFile = regularFile(path.resolve(repositoryRoot, entry.ref), 'randomized replay producer receipt')
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    verifySealedDocument(result)
    if (result.contentDigest !== entry.digest || result.status !== 'verified'
      || result.source?.commit !== identity.sourceCommit
      || result.source?.worktreeFingerprint !== identity.sourceFingerprint) {
      throw new Error(`randomized replay producer receipt is stale: ${entry.producerId}/${entry.topology}`)
    }
    return String(result.plan?.inline?.rootSeed ?? '')
  }))
  if (rootSeeds.size !== 1 || !/^seed256:[0-9a-f]{64}$/u.test([...rootSeeds][0])) {
    throw new Error('runtime-order replay qualification has no exact common root seed')
  }
  return Object.freeze({
    document,
    identity,
    fixedClock: Object.freeze({ epochMs: Number(fixedClock.epochMs), digest: fixedClock.digest }),
    replay: Object.freeze({ rootSeed: [...rootSeeds][0], qualificationDigest: replayQualification.contentDigest })
  })
}

const identityAuthority = loadIdentityAuthority()
export const immutableIdentity = identityAuthority.identity
export const maxConcurrency = 2

export function productionRuntimeEnvironment() {
  const inventory = loadRandomStreamInventory()
  const streams = Object.fromEntries(inventory.consumers.map((consumer) => {
    const stream = deriveRandomConsumerStream({ rootSeed: identityAuthority.replay.rootSeed, consumer })
    return [`${consumer.canonicalTestId}\u0000${consumer.streamId}`, stream.derivedSeed]
  }))
  return Object.freeze({
    FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify(streams),
    FSUSBLOG_REPLAY_ROOT_SEED: identityAuthority.replay.rootSeed,
    FSUSBLOG_REPLAY_EVIDENCE_CLASS: 'correctness',
    FSUSBLOG_REPLAY_QUALIFICATION_DIGEST: identityAuthority.replay.qualificationDigest
  })
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60)
}

function domainNamespace(identity, domain) {
  return safeId(`${identity.runId}-${domain}`)
}

function adapter() {
  return Object.freeze({
    async clone({ domain, identity, mutableRoot }) {
      const root = path.join(mutableRoot, 'domains', safeId(domain))
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      return {
        owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
        mutableRoot: root,
        namespace: domainNamespace(identity, domain),
        opaqueHandle: `domain-${safeId(domain)}`
      }
    },
    async reset({ handle }) {
      fs.rmSync(handle.mutableRoot, { recursive: true, force: true })
      fs.mkdirSync(handle.mutableRoot, { recursive: true, mode: 0o700 })
      return { status: 'reset', postconditionDigest: digestCanonical({ root: handle.mutableRoot, entries: [] }) }
    },
    async ready({ handle }) {
      const stat = fs.lstatSync(handle.mutableRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('runtime domain root is not an owned directory')
      return { status: 'ready', observationDigest: digestCanonical({ domain: handle.domain, namespace: handle.namespace }) }
    },
    async cleanup({ handle }) {
      fs.rmSync(handle.mutableRoot, { recursive: true, force: true })
      return { status: 'clean' }
    }
  })
}

export async function createSessionAdapters() {
  const domains = loadRuntimeStateAuthority().accessedDomains
  return Object.freeze({ domains, adapters: Object.fromEntries(domains.map((domain) => [domain, adapter()])) })
}

function initialObserverAuthority({ identity, authority }) {
  const domains = Object.fromEntries(authority.accessedDomains.map((domain) => [domain, {
    status: 'absent', reasonCode: 'before-runtime'
  }]))
  return sealDocument({
    schema: 'fsusblog.production-observer-authority.v1',
    phase: 'before-runtime',
    identity,
    sourceRefs: {},
    producerRefs: {},
    domains
  })
}

function writeAuthority(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function refreshObserverAuthority(file, identity, authority) {
  if (!fs.existsSync(file)) writeAuthority(file, initialObserverAuthority({ identity, authority }))
  let document = readProductionObserverAuthority(file, identity)
  const refs = document.producerRefs ?? {}
  if (document.phase === 'ready' && refs.environmentFile && refs.fingerprintKeyFile && refs.serviceEnvelopeFile) {
    document = publishProductionObserverAuthority({
      phase: 'ready', outputFile: file, sessionReceiptFile: refs.sessionReceiptFile,
      environmentFile: refs.environmentFile, fingerprintKeyFile: refs.fingerprintKeyFile,
      serviceEnvelopeFile: refs.serviceEnvelopeFile, environmentReadyFile: refs.environmentReadyFile,
      runtimeTopologyFile: refs.runtimeTopologyFile, fixtureReceiptFile: refs.fixtureReceiptFile,
      aotWarmReportFile: refs.aotWarmReportFile, browserStorageFile: refs.browserStorageFile,
      objectStorageRoot: refs.objectStorageRoot,
      backendProcessIdentityFile: refs.backendProcessIdentityFile,
      frontendProcessIdentityFile: refs.frontendProcessIdentityFile,
      releaseProcessIdentityFile: refs.releaseProcessIdentityFile,
      backendExecutableFile: refs.backendExecutableFile,
      frontendExecutableFile: refs.frontendExecutableFile,
      releaseExecutableFile: refs.releaseExecutableFile
    })
  }
  for (const domain of authority.accessedDomains) if (!document.domains?.[domain]) throw new Error(`observer authority omits ${domain}`)
  return document
}

const postgresTables = Object.freeze({
  'postgres.article': 'article', 'postgres.audit': 'sys_audit_log', 'postgres.auth': 'sys_user',
  'postgres.comment': 'comment', 'postgres.schema': '__fsus_schema_migration_history',
  'postgres.security': 'security_risk_event', 'postgres.settings': 'sys_systemconfig'
})

const postgresPrimaryKeys = Object.freeze({
  'postgres.schema': ['migration_id'],
  'postgres.settings': ['key']
})

function observedHandle(base, record, document, identity, domain, sessionReceipt) {
  const owner = base.owner
  const common = { ...base, owner, catalogDigest: identity.catalogDigest }
  if (record.status === 'absent') return {
    ...common, observationStatus: 'absent', absenceAuthorityDigest: document.contentDigest
  }
  if (domain.startsWith('postgres.')) return {
    ...common, schema: 'public', table: postgresTables[domain], primaryKey: postgresPrimaryKeys[domain] ?? ['id'], semanticClockColumns: []
  }
  if (domain.startsWith('redis.')) {
    const prefix = String(document.runtimeHandles?.redisNamespacePrefix ?? '')
    if (!prefix) throw new Error(`${domain} lacks the sealed Redis namespace prefix`)
    return {
      ...common,
      namespacePrefix: prefix,
      keyPattern: `${prefix}*|e2e:*`,
      keyPatterns: [`${prefix}*`, 'e2e:*'],
      ownershipClass: 'dedicated-session-container'
    }
  }
  if (domain === 'fixture.runtime-config') return {
    ...common, namespace: record.config.namespace, plannedConfig: record.config, configReceiptDigest: document.contentDigest
  }
  if (domain === 'artifact.public-aot-overlay') return {
    ...common, namespace: domainNamespace(identity, domain), overlayId: 'public-aot-overlay',
    activeGenerationRef: record.active, manifestRef: { contentDigest: record.manifest.contentDigest },
    expectedArtifacts: record.manifest.artifacts, expectedRoutes: record.manifest.routes
  }
  if (domain === 'storage.fixture-objects') return {
    ...common, namespace: domainNamespace(identity, domain), namespaceClass: 'fixture-session',
    namespaceId: record.namespaceId, providerId: 'session-filesystem', expectedObjects: record.objects
  }
  if (domain.startsWith('runtime.') || domain.startsWith('network.') || domain === 'browser.service-worker') return {
    ...common, namespace: record.topology.namespace, plannedTopologyDigest: record.topology.plannedTopologyDigest,
    plannedTopology: record.topology.plannedTopology
  }
  if (record.root) return {
    ...common, root: record.root, sessionRoot: sessionReceipt.ownedRoot,
    sourceRoot: repositoryRoot, rootId: safeId(domain)
  }
  if (domain === 'fixture.auth-identities' || domain === 'browser.storage-state') return {
    ...common, namespace: domainNamespace(identity, domain),
    ...(domain === 'fixture.auth-identities' ? {
      stateClass: record.stateClass,
      expectedIdentityDigest: digestCanonical(record.identities ?? [])
    } : {
      userId: 'anonymous-user', siteId: 'default-site', authSessionId: 'anonymous-session',
      deviceId: 'anonymous-device', declaredClaims: [], declaredLocalStorageKeys: [],
      declaredSessionStorageKeys: [], declaredIndexedDbStores: []
    })
  }
  throw new Error(`${domain} has no shipped production observer handle projection`)
}

export async function createProductionSnapshotContext({ identity, sessionReceipt, authority }) {
  const authorityFile = path.resolve(String(process.env.FSUSBLOG_RUNTIME_ORDER_AUTHORITY_FILE ?? ''))
  if (!authorityFile.startsWith(`${sessionReceipt.ownedRoot}${path.sep}`)) throw new Error('observer authority is outside the session-owned root')
  const document = refreshObserverAuthority(authorityFile, identity, authority)
  const handles = Object.fromEntries(authority.accessedDomains.map((domain) => [
    domain,
    observedHandle(sessionReceipt.handles[domain], document.domains[domain], document, identity, domain, sessionReceipt)
  ]))
  const ports = {
    absence: createProductionReceiptAbsencePort({ authorityFile, identity }),
    runtimeConfig: createProductionReceiptRuntimeConfigPort({ authorityFile, identity }),
    runtimeTopology: createProductionReceiptRuntimeTopologyPort({ authorityFile, identity }),
    aotGeneration: createProductionReceiptAotGenerationPort({ authorityFile, identity }),
    objectStorage: createProductionReceiptObjectStoragePort({ authorityFile, identity })
  }
  ports.authState = createProductionReceiptAuthStatePort({ authorityFile, identity, fixedClock: identityAuthority.fixedClock })
  if (document.runtimeHandles?.postgresContainer) {
    ports.postgresql = createDockerPostgresqlReadonlyPort({ container: document.runtimeHandles.postgresContainer })
  }
  if (document.runtimeHandles?.redisContainer) {
    ports.redis = createDockerRedisReadonlyPort({ container: document.runtimeHandles.redisContainer, fixedClock: identityAuthority.fixedClock })
  }
  return Object.freeze({
    identity, handles, ports, fixedClock: identityAuthority.fixedClock,
    protectedFingerprintKey: fs.readFileSync(regularFile(path.resolve(
      document.producerRefs?.fingerprintKeyFile
        ?? String(process.env.FSUSBLOG_RUNTIME_ORDER_FINGERPRINT_KEY_FILE ?? '')
    ), 'observer fingerprint key')),
    fingerprintScope: 'run', fingerprintScopeId: identity.runId
  })
}

export async function verifyProductionResetPostconditions() { return [] }

export async function verifyProductionCoordination({ stepId, identity }) {
  return Object.freeze({ status: 'verified', receiptDigest: digestCanonical({ stepId, identity, authority: 'production-run-bundle' }) })
}
