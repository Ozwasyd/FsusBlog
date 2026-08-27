import { Readable } from 'node:stream'

import { readProductionObserverAuthority } from './production-observer-authority.mjs'

const noSideEffects = Object.freeze({
  writes: 0,
  networkMutations: 0,
  tokenRefreshes: 0,
  repairs: 0,
  lifecycleTransitions: 0
})

function domainRecord({ authorityFile, identity, domain }) {
  const document = readProductionObserverAuthority(authorityFile, identity)
  const record = document.domains?.[domain]
  if (!record) throw new Error(`production observer authority does not declare ${domain}`)
  return { document, record }
}

export function createProductionReceiptRuntimeConfigPort({ authorityFile, identity }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readResolvedConfig({ handle }) {
      const { document, record } = domainRecord({ authorityFile, identity, domain: 'fixture.runtime-config' })
      if (record.status !== 'observed') throw new Error(`runtime config authority is ${record.status}`)
      return {
        ...record.config,
        readonly: true,
        envelopeDigest: document.identity.envelopeDigest,
        namespace: handle.namespace,
        secrets: record.config.secrets.map((secret) => ({
          secretClass: secret.secretClass,
          sourceOwner: secret.sourceOwner,
          present: secret.present,
          protectedValue: secret.protectedValue
        }))
      }
    }
  })
}

export function createProductionReceiptRuntimeTopologyPort({ authorityFile, identity }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readOwnedTopology({ handle }) {
      const { record } = domainRecord({ authorityFile, identity, domain: handle.owner.domain })
      if (record.status !== 'observed') throw new Error(`${handle.owner.domain} topology authority is ${record.status}`)
      return {
        readonly: true,
        namespace: record.topology.namespace,
        plannedTopologyDigest: record.topology.plannedTopologyDigest,
        services: record.topology.services,
        diagnostics: { pidCount: 0, ephemeralPortCount: 0 }
      }
    }
  })
}

export function createProductionReceiptAotGenerationPort({ authorityFile, identity }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readActiveGeneration() {
      const { record } = domainRecord({ authorityFile, identity, domain: 'artifact.public-aot-overlay' })
      if (record.status !== 'observed') throw new Error(`public AOT authority is ${record.status}`)
      return record.active
    },
    async readManifest() {
      const { record } = domainRecord({ authorityFile, identity, domain: 'artifact.public-aot-overlay' })
      if (record.status !== 'observed') throw new Error(`public AOT authority is ${record.status}`)
      return record.manifest
    },
    async openArtifact({ artifactId, ref }) {
      const { record } = domainRecord({ authorityFile, identity, domain: 'artifact.public-aot-overlay' })
      if (record.status !== 'observed' || record.artifactRefs?.[artifactId] !== ref) {
        throw new Error(`public AOT artifact ref is stale: ${artifactId}`)
      }
      return Readable.from([await import('node:fs').then(({ readFileSync }) => readFileSync(ref))])
    }
  })
}

export function createProductionReceiptObjectStoragePort({ authorityFile, identity }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async *listObjects() {
      const { record } = domainRecord({ authorityFile, identity, domain: 'storage.fixture-objects' })
      if (record.status !== 'observed' || !Array.isArray(record.objects)) throw new Error('object-storage authority is unavailable')
      yield { complete: true, objects: record.objects }
    },
    async openRead() { throw new Error('empty session object-storage catalog has no readable object') }
  })
}

export function createProductionReceiptAuthStatePort({ authorityFile, identity, fixedClock }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readAuthState({ handle, domain }) {
      const { record } = domainRecord({ authorityFile, identity, domain })
      if (record.status !== 'observed') throw new Error(`${domain} auth authority is ${record.status}`)
      if (domain === 'fixture.auth-identities') return {
        ...record, readonly: true, namespace: handle.namespace,
        clockDigest: fixedClock.digest, providerId: 'fixture-receipt', providerVersion: 'v2'
      }
      if (record.stateClass !== 'empty-browser-storage') throw new Error('browser storage authority is unsupported')
      return {
        readonly: true, namespace: handle.namespace, clockDigest: fixedClock.digest,
        userId: handle.userId, siteId: handle.siteId, sessionId: handle.authSessionId,
        deviceId: handle.deviceId, tokenClass: 'anonymous', roles: [], permissions: [], claims: {},
        issuedAtEpochMs: fixedClock.epochMs, expiresAtEpochMs: fixedClock.epochMs,
        serverGeneration: 'empty-browser-storage', token: null, cookies: [],
        localStorage: {}, sessionStorage: {}, indexedDb: {},
        providerId: 'playwright-storage-state', providerVersion: 'v1'
      }
    }
  })
}

/** Fail-closed entry points for producer classes that are not yet materialized. */
export function createProductionReceiptUnavailablePort({ authorityFile, identity, domain, kind }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readAuthority() {
      const { document, record } = domainRecord({ authorityFile, identity, domain })
      if (record.status === 'absent') {
        return Object.freeze({
          status: 'absent',
          reasonCode: record.reasonCode,
          authorityDigest: document.contentDigest,
          kind
        })
      }
      return record
    },
    async readActiveGeneration() { throw new Error(`${domain} requires a materialized AOT producer authority`) },
    async readManifest() { throw new Error(`${domain} requires a materialized AOT producer authority`) },
    async openArtifact() { return Readable.from([]) },
    async readAuthState() { throw new Error(`${domain} requires a materialized auth/storage producer authority`) },
    async *listObjects() { throw new Error(`${domain} requires a materialized object-storage producer authority`) },
    async openRead() { return Readable.from([]) }
  })
}

export function createProductionReceiptAbsencePort({ authorityFile, identity }) {
  return Object.freeze({
    readonly: true,
    async readSideEffectCounters() { return noSideEffects },
    async readDeclaredAbsence({ handle, domain }) {
      const { document, record } = domainRecord({ authorityFile, identity, domain })
      if (record.status !== 'absent' || handle.absenceAuthorityDigest !== document.contentDigest) {
        throw new Error(`${domain} absence producer authority is not current`)
      }
      return {
        status: 'absent',
        domain,
        namespace: handle.namespace,
        reasonCode: record.reasonCode,
        authorityDigest: document.contentDigest,
        producerRef: authorityFile
      }
    }
  })
}
