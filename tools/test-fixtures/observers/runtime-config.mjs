import { digestCanonical, freezeDeep, plainObject } from '../receipt/canonical.mjs'
import {
  createProtectedFingerprint,
  normalizeSemantic,
  requireDigest,
  requireSafeId,
  requireText
} from '../../test-runtime/contract.mjs'
import {
  assertOwnedHandle,
  assertReadonlyPort,
  normalizedObserverResult,
  observeDeclaredAbsence,
  readObserverSideEffects,
  sideEffectDelta,
  stableRecords
} from './common.mjs'

function normalizedConfig(document, context) {
  if (!plainObject(document)) throw new Error('runtime resolved config is missing')
  const keys = [...(document.requiredKeys ?? [])].sort()
  if (new Set(keys).size !== keys.length || JSON.stringify(Object.keys(document.values ?? {}).sort()) !== JSON.stringify(keys)) {
    throw new Error('runtime config required keys are missing, extra or implicit defaults')
  }
  const sources = Object.entries(document.sources ?? {}).map(([key, owner]) => ({
    key,
    owner: requireSafeId(owner, `runtime config source ${key}`)
  }))
  if (sources.length !== keys.length || new Set(sources.map((entry) => entry.key)).size !== keys.length) {
    throw new Error('runtime config source ownership is missing or ambiguous')
  }
  const endpoints = stableRecords((document.endpoints ?? []).map((endpoint) => ({
    role: requireSafeId(endpoint.role, 'runtime endpoint role'),
    protocol: requireSafeId(endpoint.protocol, 'runtime endpoint protocol'),
    hostAuthority: requireSafeId(endpoint.hostAuthority, 'runtime endpoint host authority')
  })), ['role'], 'runtime endpoints')
  const secrets = stableRecords((document.secrets ?? []).map((secret) => {
    const secretClass = requireSafeId(secret.secretClass, 'runtime secret class')
    let value
    if (plainObject(secret.protectedValue)) {
      value = {
        secretClass,
        present: secret.protectedValue.present === true,
        lengthClass: requireSafeId(secret.protectedValue.lengthClass, 'runtime secret length class'),
        fingerprint: secret.protectedValue.fingerprint == null
          ? null
          : requireText(secret.protectedValue.fingerprint, 'runtime protected secret fingerprint')
      }
      if (value.present !== (value.fingerprint != null)
        || (value.fingerprint != null && !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.fingerprint))) {
        throw new Error(`runtime protected secret ${secretClass} is malformed`)
      }
    } else {
      value = secret.present === true ? createProtectedFingerprint({
        key: context.protectedFingerprintKey,
        scopeId: context.fingerprintScopeId,
        secretClass,
        value: secret.value
      }) : { secretClass, present: false, lengthClass: 'empty', fingerprint: null }
    }
    return {
      secretClass,
      sourceOwner: requireSafeId(secret.sourceOwner, 'runtime secret source owner'),
      value
    }
  }), ['secretClass'], 'runtime secrets')
  return freezeDeep({
    schema: requireText(document.schema, 'runtime config schema'),
    namespace: requireSafeId(document.namespace, 'runtime config namespace'),
    requiredKeys: keys,
    values: normalizeSemantic(document.values, 'runtime config values'),
    sources: stableRecords(sources, ['key'], 'runtime config sources'),
    featuresDigest: requireDigest(document.featuresDigest, 'runtime featuresDigest'),
    policyDigest: requireDigest(document.policyDigest, 'runtime policyDigest'),
    endpoints,
    secrets
  })
}

export async function observeRuntimeConfig({ domain, identity, context, signal }) {
  if (domain !== 'fixture.runtime-config') throw new Error(`runtime-config observer cannot own ${domain}`)
  const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'runtime config handle')
  const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'runtime-config', handle })
  if (absent) return absent
  const port = assertReadonlyPort(context?.ports?.runtimeConfig, ['readResolvedConfig', 'readSideEffectCounters'], 'runtime-config observer port')
  if (!(context.protectedFingerprintKey instanceof Uint8Array) || !context.fingerprintScopeId) throw new Error('runtime config observer requires protected secret fingerprinting')
  const before = await readObserverSideEffects(port)
  const actualDocument = await port.readResolvedConfig({ handle, signal })
  if (actualDocument?.readonly !== true || actualDocument?.envelopeDigest !== identity.envelopeDigest
    || actualDocument?.namespace !== handle.namespace) {
    throw new Error('runtime actual config is not bound to the sealed envelope/session namespace')
  }
  const planned = normalizedConfig(handle.plannedConfig, context)
  const actual = normalizedConfig(actualDocument, context)
  if (digestCanonical(actual) !== digestCanonical(planned)) {
    const plannedKeys = new Set(planned.requiredKeys)
    const actualKeys = new Set(actual.requiredKeys)
    const mismatch = [...new Set([...plannedKeys, ...actualKeys])].sort().find((key) =>
      JSON.stringify(planned.values[key]) !== JSON.stringify(actual.values[key])
      || planned.sources.find((entry) => entry.key === key)?.owner !== actual.sources.find((entry) => entry.key === key)?.owner)
    throw new Error(`runtime planned/actual config mismatch at ${mismatch ?? 'namespace/policy/features/endpoints/secrets'}`)
  }
  const after = await readObserverSideEffects(port)
  return normalizedObserverResult({ kind: 'runtime-config', ...actual }, {
    envelopeDigest: identity.envelopeDigest,
    configReceiptDigest: requireDigest(handle.configReceiptDigest, 'runtime config receipt digest'),
    secretPlaintextOccurrences: 0,
    ambientEnvironmentReads: 0
  }, sideEffectDelta(before, after))
}

export function createRuntimeConfigObserver() {
  return Object.freeze({ observerId: 'runtime-config', version: 'v1', observe: observeRuntimeConfig })
}
