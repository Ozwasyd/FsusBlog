import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { digestCanonical, freezeDeep, plainObject } from '../test-fixtures/receipt/canonical.mjs'
import {
  normalizeRuntimeIdentity,
  requireDigest,
  requireSafeId,
  requireText,
  sealDocument,
  sortedUniqueStrings,
  verifySealedDocument
} from './contract.mjs'

export const runtimeExecutionSessionSchema = 'fsusblog.runtime-execution-session.v1'
export const runtimeExecutionSessionEventSchema = 'fsusblog.runtime-execution-session-event.v1'

function ensureWithin(parent, candidate, label) {
  const root = path.resolve(parent)
  const target = path.resolve(candidate)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes its session-owned root`)
  return target
}

function normalizeImmutableInputs(value) {
  if (!plainObject(value)) throw new Error('immutableInputs must be an object')
  const source = {
    sourceCommit: requireText(value.sourceCommit, 'immutableInputs.sourceCommit'),
    sourceFingerprint: requireDigest(value.sourceFingerprint, 'immutableInputs.sourceFingerprint'),
    buildReceiptDigest: requireDigest(value.buildReceiptDigest, 'immutableInputs.buildReceiptDigest'),
    fixtureDigest: requireDigest(value.fixtureDigest, 'immutableInputs.fixtureDigest'),
    envelopeDigest: requireDigest(value.envelopeDigest, 'immutableInputs.envelopeDigest'),
    clockDigest: requireDigest(value.clockDigest, 'immutableInputs.clockDigest'),
    replayDigest: requireDigest(value.replayDigest, 'immutableInputs.replayDigest'),
    catalogDigest: requireDigest(value.catalogDigest, 'immutableInputs.catalogDigest'),
    domainSources: freezeDeep(value.domainSources ?? {})
  }
  if (!/^[0-9a-f]{40}$/u.test(source.sourceCommit)) throw new Error('immutableInputs.sourceCommit must be a full SHA')
  return freezeDeep(source)
}

function normalizeAdapterMap(adapters, domains) {
  const map = adapters instanceof Map ? new Map(adapters) : new Map(Object.entries(adapters ?? {}))
  const missing = domains.filter((domain) => !map.has(domain))
  const unknown = [...map.keys()].filter((domain) => !domains.includes(domain))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`session domain adapters must be exact; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`)
  }
  for (const [domain, adapter] of map) {
    for (const operation of ['clone', 'reset', 'ready', 'cleanup']) {
      if (typeof adapter?.[operation] !== 'function') throw new Error(`${domain} adapter requires ${operation}()`)
    }
  }
  return map
}

function normalizeHandle(domain, value, identity, ownedRoot) {
  if (!plainObject(value)) throw new Error(`${domain} clone returned no handle`)
  const owner = value.owner
  if (!plainObject(owner)
    || owner.runId !== identity.runId
    || owner.attemptId !== identity.attemptId
    || owner.sessionId !== identity.sessionId
    || owner.domain !== domain) {
    throw new Error(`${domain} handle is shared, stale or cross-session`)
  }
  const mutableRoot = value.mutableRoot == null ? null : ensureWithin(ownedRoot, value.mutableRoot, `${domain} mutableRoot`)
  const namespace = value.namespace == null ? null : requireSafeId(value.namespace, `${domain} namespace`)
  if (!mutableRoot && !namespace && !value.opaqueHandle) throw new Error(`${domain} handle has no owned root, namespace or opaque handle`)
  return freezeDeep({
    domain,
    owner: freezeDeep({ ...owner }),
    mutableRoot,
    namespace,
    opaqueHandle: value.opaqueHandle == null ? null : requireText(value.opaqueHandle, `${domain} opaqueHandle`),
    serviceIdentity: value.serviceIdentity == null ? null : freezeDeep(value.serviceIdentity),
    topologyIdentity: value.topologyIdentity == null ? null : freezeDeep(value.topologyIdentity),
    contentDigest: value.contentDigest == null ? null : requireDigest(value.contentDigest, `${domain} contentDigest`)
  })
}

function assertDistinctHandles(handles) {
  const ownershipKeys = new Map()
  for (const handle of handles.values()) {
    for (const key of [handle.mutableRoot, handle.namespace, handle.opaqueHandle].filter(Boolean)) {
      if (ownershipKeys.has(key)) throw new Error(`session domains share mutable ownership ${key}`)
      ownershipKeys.set(key, handle.domain)
    }
  }
}

export class RuntimeExecutionSession {
  #adapters
  #journalFile
  #sequence = 0
  #terminal = false
  #postflightComplete = false

  constructor({ identity, immutableInputs, domains, ownedRoot, handles, adapters, journalFile }) {
    this.schema = runtimeExecutionSessionSchema
    this.identity = identity
    this.immutableInputs = immutableInputs
    this.domains = domains
    this.ownedRoot = ownedRoot
    this.handles = handles
    this.#adapters = adapters
    this.#journalFile = journalFile
    Object.freeze(this.domains)
  }

  static async create({
    sessionRoot,
    runId,
    attemptId,
    sessionId = randomUUID(),
    immutableInputs,
    domains,
    adapters,
    signal
  }) {
    const immutable = normalizeImmutableInputs(immutableInputs)
    const identity = normalizeRuntimeIdentity({
      runId,
      attemptId,
      sessionId: requireSafeId(sessionId, 'sessionId'),
      ...immutable
    })
    const requiredDomains = sortedUniqueStrings(domains, 'session domains', { allowEmpty: false })
    const adapterMap = normalizeAdapterMap(adapters, requiredDomains)
    const root = path.resolve(requireText(sessionRoot, 'sessionRoot'))
    const ownedRoot = ensureWithin(root, path.join(root, identity.runId, identity.attemptId, identity.sessionId), 'session root')
    if (fs.existsSync(ownedRoot)) throw new Error('session mutable root already exists and cannot be reused')
    fs.mkdirSync(path.join(ownedRoot, 'mutable'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(ownedRoot, 'evidence'), { recursive: true, mode: 0o700 })
    const journalFile = path.join(ownedRoot, 'evidence', 'lifecycle.jsonl')
    fs.writeFileSync(journalFile, '', { flag: 'wx', mode: 0o600 })
    const session = new RuntimeExecutionSession({
      identity,
      immutableInputs: immutable,
      domains: requiredDomains,
      ownedRoot,
      handles: new Map(),
      adapters: adapterMap,
      journalFile
    })
    session.#append('creating', { domains: requiredDomains, immutableDigest: digestCanonical(immutable) })
    try {
      for (const domain of requiredDomains) {
        if (signal?.aborted) throw signal.reason ?? new Error('session creation cancelled')
        let raw = null
        try {
          raw = await adapterMap.get(domain).clone({
            domain,
            identity,
            immutableInputs: immutable,
            sourceHandle: immutable.domainSources[domain] ?? null,
            mutableRoot: path.join(ownedRoot, 'mutable'),
            signal
          })
          session.handles.set(domain, normalizeHandle(domain, raw, identity, ownedRoot))
        } catch (error) {
          if (raw != null) {
            try {
              await adapterMap.get(domain).cleanup({
                domain,
                identity,
                handle: raw,
                immutableInputs: immutable,
                reason: 'invalid-clone-handle',
                signal: undefined,
                cancellationReason: signal?.aborted ? signal.reason ?? 'cancelled' : null
              })
            } catch (cleanupError) {
              error.cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }
          }
          throw error
        }
      }
      assertDistinctHandles(session.handles)
      await session.#assertReady('created', signal)
      session.#append('ready', { handleDigest: digestCanonical(Object.fromEntries(session.handles)) })
      return session
    } catch (error) {
      session.#append('create-failed', { reason: error instanceof Error ? error.message : String(error) })
      await session.#cleanupAdapters('create-failed', signal)
      session.#terminal = true
      throw error
    }
  }

  #append(event, details) {
    const record = sealDocument({
      schema: runtimeExecutionSessionEventSchema,
      sequence: ++this.#sequence,
      event,
      identity: this.identity,
      details: freezeDeep(details ?? {})
    })
    fs.appendFileSync(this.#journalFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    return record
  }

  async #assertReady(phase, signal) {
    for (const domain of this.domains) {
      if (signal?.aborted) throw signal.reason ?? new Error(`session ${phase} readiness cancelled`)
      const result = await this.#adapters.get(domain).ready({
        domain,
        identity: this.identity,
        handle: this.handles.get(domain),
        immutableInputs: this.immutableInputs,
        signal
      })
      if (!plainObject(result) || result.status !== 'ready' || !result.observationDigest) {
        throw new Error(`${domain} is not observably ready after ${phase}`)
      }
      requireDigest(result.observationDigest, `${domain} readiness observationDigest`)
    }
  }

  assertCurrent(identity) {
    const current = normalizeRuntimeIdentity(identity)
    if (digestCanonical(current) !== digestCanonical(this.identity)) throw new Error('runtime session identity is stale or cross-attempt')
    if (this.#terminal) throw new Error('runtime session is terminal')
    return true
  }

  async reset({ reason = 'schedule-reset', signal } = {}) {
    if (this.#terminal) throw new Error('cannot reset a terminal runtime session')
    this.#append('reset-started', { reason })
    const results = []
    try {
      for (const domain of this.domains) {
        if (signal?.aborted) throw signal.reason ?? new Error('runtime session reset cancelled')
        const result = await this.#adapters.get(domain).reset({
          domain,
          identity: this.identity,
          handle: this.handles.get(domain),
          immutableInputs: this.immutableInputs,
          signal
        })
        if (!plainObject(result) || result.status !== 'reset' || !result.postconditionDigest) {
          throw new Error(`${domain} reset did not prove its postcondition`)
        }
        results.push({ domain, postconditionDigest: requireDigest(result.postconditionDigest, `${domain} postconditionDigest`) })
      }
      await this.#assertReady('reset', signal)
      return this.#append('reset-complete', { reason, results })
    } catch (error) {
      this.#append('reset-failed', { reason, failure: error instanceof Error ? error.message : String(error), results })
      throw error
    }
  }

  async #cleanupAdapters(reason, signal) {
    const failures = []
    for (const domain of [...this.domains].reverse()) {
      const handle = this.handles.get(domain)
      if (!handle) continue
      try {
        const result = await this.#adapters.get(domain).cleanup({
          domain,
          identity: this.identity,
          handle,
          immutableInputs: this.immutableInputs,
          reason,
          signal: undefined,
          cancellationReason: signal?.aborted ? signal.reason ?? 'cancelled' : null
        })
        if (!plainObject(result) || result.status !== 'clean') throw new Error('cleanup returned no clean status')
      } catch (error) {
        failures.push({ domain, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return failures
  }

  async postflight({ signal } = {}) {
    if (this.#terminal) throw new Error('cannot postflight a terminal runtime session')
    if (this.#postflightComplete) throw new Error('runtime session postflight cannot be reused')
    this.#append('postflight-started', {})
    try {
      await this.#assertReady('postflight', signal)
      this.#postflightComplete = true
      return this.#append('postflight-complete', {
        handleDigest: digestCanonical(Object.fromEntries(this.handles))
      })
    } catch (error) {
      this.#append('postflight-failed', { reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async cleanup({ reason = 'complete', signal } = {}) {
    if (this.#terminal) throw new Error('runtime session cleanup cannot be reused')
    let postflightFailure = null
    if (!this.#postflightComplete) {
      try {
        await this.postflight({ signal })
      } catch (error) {
        postflightFailure = error
      }
    }
    this.#append('cleanup-started', { reason })
    const failures = await this.#cleanupAdapters(reason, signal)
    this.#terminal = true
    const receipt = this.#append(failures.length === 0 && !postflightFailure ? 'cleanup-complete' : 'cleanup-failed', {
      reason,
      postflightFailure: postflightFailure instanceof Error ? postflightFailure.message : null,
      failures
    })
    if (failures.length > 0 || postflightFailure) {
      throw new AggregateError([
        ...(postflightFailure ? [postflightFailure] : []),
        ...failures.map((failure) => new Error(`${failure.domain}: ${failure.reason}`))
      ], 'runtime session postflight or cleanup incomplete')
    }
    return receipt
  }

  receipt() {
    const handles = Object.fromEntries(this.handles)
    const body = {
      schema: runtimeExecutionSessionSchema,
      status: this.#terminal ? 'terminal' : 'ready',
      identity: this.identity,
      immutableInputsDigest: digestCanonical(this.immutableInputs),
      domains: this.domains,
      ownedRoot: this.ownedRoot,
      handles,
      handleDigest: digestCanonical(handles),
      lifecycleEventCount: this.#sequence
    }
    return sealDocument(body)
  }
}

export async function createRuntimeExecutionSession(options) {
  return RuntimeExecutionSession.create(options)
}

export function validateRuntimeExecutionSessionReceipt(receipt, { identity = null, requireReady = true } = {}) {
  if (receipt?.schema !== runtimeExecutionSessionSchema) throw new Error('runtime execution session receipt schema is invalid')
  verifySealedDocument(receipt)
  if (requireReady && receipt.status !== 'ready') throw new Error('runtime execution session is not ready')
  const actual = normalizeRuntimeIdentity(receipt.identity)
  if (identity && digestCanonical(actual) !== digestCanonical(normalizeRuntimeIdentity(identity))) {
    throw new Error('runtime execution session receipt is stale or cross-attempt')
  }
  requireDigest(receipt.immutableInputsDigest, 'session immutableInputsDigest')
  requireDigest(receipt.handleDigest, 'session handleDigest')
  if (!plainObject(receipt.handles)
    || JSON.stringify(Object.keys(receipt.handles).sort()) !== JSON.stringify([...receipt.domains].sort())
    || digestCanonical(receipt.handles) !== receipt.handleDigest) {
    throw new Error('runtime execution session receipt handles are missing, extra or tampered')
  }
  if (!Array.isArray(receipt.domains) || receipt.domains.length === 0 || new Set(receipt.domains).size !== receipt.domains.length) {
    throw new Error('runtime execution session receipt has incomplete domain ownership')
  }
  return true
}
