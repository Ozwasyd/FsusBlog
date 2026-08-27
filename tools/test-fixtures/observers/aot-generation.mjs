import { digestCanonical, freezeDeep, plainObject } from '../receipt/canonical.mjs'
import { requireDigest, requireSafeId, requireText } from '../../test-runtime/contract.mjs'
import {
  assertOwnedHandle,
  assertReadonlyPort,
  digestReadable,
  normalizedObserverResult,
  observeDeclaredAbsence,
  readObserverSideEffects,
  sideEffectDelta,
  stableRecords
} from './common.mjs'

export async function observeAotGeneration({ domain, identity, context, signal }) {
  if (domain !== 'artifact.public-aot-overlay') throw new Error(`AOT observer cannot own ${domain}`)
  const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'AOT generation handle')
  const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'aot-generation', handle })
  if (absent) return absent
  const port = assertReadonlyPort(context?.ports?.aotGeneration, [
    'readActiveGeneration', 'readManifest', 'openArtifact', 'readSideEffectCounters'
  ], 'AOT generation observer port')
  if (!handle.activeGenerationRef || !handle.manifestRef || !Array.isArray(handle.expectedArtifacts)
    || !plainObject(handle.expectedRoutes)) {
    throw new Error('AOT observer requires sealed generation/manifest/artifact/route refs')
  }
  const before = await readObserverSideEffects(port)
  const active = await port.readActiveGeneration({ handle, signal })
  const manifest = await port.readManifest({ handle, ref: handle.manifestRef, signal })
  if (!plainObject(active) || active.status !== 'active' || !plainObject(manifest)) throw new Error('AOT active generation is missing or ambiguous')
  const generationId = requireSafeId(active.generationId, 'AOT generationId')
  if (generationId !== handle.activeGenerationRef.generationId || generationId !== manifest.generationId
    || active.authorityDigest !== handle.activeGenerationRef.authorityDigest
    || manifest.contentDigest !== handle.manifestRef.contentDigest
    || manifest.sourceCommit !== identity.sourceCommit
    || manifest.buildReceiptDigest !== identity.buildReceiptDigest) {
    throw new Error('AOT generation/pointer/manifest/source identity disagrees')
  }
  requireDigest(active.authorityDigest, 'AOT active authority digest')
  requireDigest(manifest.contentDigest, 'AOT manifest content digest')
  const { contentDigest: _manifestDigest, ...manifestBody } = manifest
  if (digestCanonical(manifestBody) !== manifest.contentDigest) throw new Error('AOT manifest content is tampered')
  const expectedArtifacts = new Map(handle.expectedArtifacts.map((item) => [item.id, item]))
  const actualArtifacts = new Map((manifest.artifacts ?? []).map((item) => [item.id, item]))
  if (expectedArtifacts.size !== handle.expectedArtifacts.length || actualArtifacts.size !== (manifest.artifacts ?? []).length
    || JSON.stringify([...expectedArtifacts.keys()].sort()) !== JSON.stringify([...actualArtifacts.keys()].sort())) {
    throw new Error('AOT manifest artifact set is missing, extra or duplicate')
  }
  const artifacts = []
  for (const [artifactId, expected] of expectedArtifacts) {
    const declared = actualArtifacts.get(artifactId)
    const readable = await port.openArtifact({ handle, generationId, artifactId, ref: declared.ref, signal })
    if (!readable?.[Symbol.asyncIterator]) throw new Error(`AOT artifact ${artifactId} has no streaming reader`)
    const observed = await digestReadable(readable)
    if (observed.contentDigest !== expected.contentDigest || observed.contentDigest !== declared.contentDigest) {
      throw new Error(`AOT artifact content mismatch: ${artifactId}`)
    }
    artifacts.push({ id: requireSafeId(artifactId, 'AOT artifact id'), ...observed })
  }
  const routes = Object.entries(manifest.routes ?? {}).map(([route, artifactId]) => ({ route, artifactId }))
  const expectedRoutes = Object.entries(handle.expectedRoutes).map(([route, artifactId]) => ({ route, artifactId }))
  const normalizeRoutes = (items) => stableRecords(items.map((item) => ({
    route: requireText(item.route, 'AOT route'),
    artifactId: requireSafeId(item.artifactId, 'AOT route artifact')
  })), ['route'], 'AOT routes')
  const normalizedRoutes = normalizeRoutes(routes)
  if (JSON.stringify(normalizedRoutes) !== JSON.stringify(normalizeRoutes(expectedRoutes))) throw new Error('AOT route/output mapping is missing, orphaned or conflicting')
  const after = await readObserverSideEffects(port)
  return normalizedObserverResult({
    kind: 'aot-generation',
    overlayId: requireSafeId(handle.overlayId, 'AOT overlayId'),
    generationId,
    activeAuthorityDigest: active.authorityDigest,
    manifest: {
      schema: requireText(manifest.schema, 'AOT manifest schema'),
      contentDigest: manifest.contentDigest
    },
    artifacts: stableRecords(artifacts, ['id'], 'AOT artifacts'),
    routes: normalizedRoutes,
    sourceCommit: identity.sourceCommit,
    buildReceiptDigest: identity.buildReceiptDigest
  }, {
    physicalRootClass: 'session-owned-overlay',
    artifactCount: artifacts.length
  }, sideEffectDelta(before, after))
}

export function createAotGenerationObserver() {
  return Object.freeze({ observerId: 'aot-generation', version: 'v1', observe: observeAotGeneration })
}
