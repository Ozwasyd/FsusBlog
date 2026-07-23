import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(
  repositoryRoot,
  'src/shared/Contracts/Validation/public-representation-coordinate.json'
)

export const manifest = Object.freeze(JSON.parse(await readFile(manifestPath, 'utf8')))
const fields = new Map(manifest.fields.map((field) => [field.name, field]))
const transitions = new Map(manifest.transitions.map((transition) => [transition.id, transition]))
const invariantNames = Object.freeze([...manifest.invariants])
const sha256Pattern = /^[0-9a-f]{64}$/u

function canonicalText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString(10)
  return String(value)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalDigest(parts) {
  const hash = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(canonicalText(part), 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32LE(bytes.length)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function normalizeUnsigned(value, maximum, name) {
  const normalized = typeof value === 'bigint' ? value : BigInt(value)
  if (normalized < 0n || normalized > maximum) {
    throw new Error(`public_representation_coordinate_invalid:${name}`)
  }
  return normalized.toString(10)
}

function normalizeField(field, value) {
  const actual = value === undefined || value === null ? field.default : value
  if (field.required && (actual === undefined || actual === null || actual === '')) {
    throw new Error(`public_representation_coordinate_missing:${field.name}`)
  }
  if (field.type === 'uint8') return Number(normalizeUnsigned(actual, 255n, field.name))
  if (field.type === 'uint64') return normalizeUnsigned(actual, 18446744073709551615n, field.name)
  const text = canonicalText(actual).trim()
  if (field.type === 'sha256' && text !== '' && !sha256Pattern.test(text)) {
    throw new Error(`public_representation_coordinate_invalid:${field.name}`)
  }
  return text
}

export function normalizeCoordinate(candidate) {
  const coordinate = {}
  for (const field of manifest.fields) {
    coordinate[field.name] = normalizeField(field, candidate?.[field.name])
  }
  return Object.freeze(coordinate)
}

export function coordinateIdentity(coordinate) {
  const normalized = normalizeCoordinate(coordinate)
  return canonicalDigest([
    manifest.schema,
    manifest.coordinateVersion,
    ...manifest.fields.flatMap((field) => [field.name, normalized[field.name]])
  ])
}

export function createCoordinate(candidate, {
  documentBytes,
  hydrationSidecarBytes
} = {}) {
  const enriched = { ...candidate }
  if (documentBytes !== undefined) enriched.documentDigest = sha256(documentBytes)
  if (hydrationSidecarBytes !== undefined) enriched.hydrationSidecarDigest = sha256(hydrationSidecarBytes)
  return normalizeCoordinate(enriched)
}

export function compareInvariants(left, right, names = invariantNames) {
  const expected = normalizeCoordinate(left)
  const actual = normalizeCoordinate(right)
  return names
    .filter((name) => !Object.is(expected[name], actual[name]))
    .map((name) => Object.freeze({
      field: name,
      expected: expected[name],
      actual: actual[name]
    }))
}

export function validateTransition(transitionId, input, output) {
  const transition = transitions.get(transitionId)
  if (!transition) throw new Error(`public_representation_transition_unknown:${transitionId}`)
  const mismatches = compareInvariants(input, output, transition.preserves)
  return Object.freeze({
    ok: mismatches.length === 0,
    transition: transitionId,
    fallback: mismatches.length === 0 ? null : transition.fallback,
    mismatches
  })
}

export function compareClosedLoops(aotCoordinate, hotReadCoordinate) {
  const mismatches = compareInvariants(aotCoordinate, hotReadCoordinate)
  return Object.freeze({
    ok: mismatches.length === 0,
    transition: 'closed-loop',
    fallback: mismatches.length === 0 ? null : 'network-canonical-route',
    mismatches
  })
}

export class PublicRepresentationEvidence {
  #counts = new Map()
  #rebuilds = new Map()

  recordMismatch(layer, transition) {
    this.#assertLayer(layer)
    this.#assertTransition(transition)
    this.#increment(`representationCoordinateMismatch|${layer}|${transition}`)
  }

  recordFallback(layer, transition) {
    this.#assertLayer(layer)
    this.#assertTransition(transition)
    this.#increment(`deterministicFallback|${layer}|${transition}`)
  }

  recordClosedLoopMismatch() {
    this.#increment('closedLoopInvariantMismatch|closed-loop|closed-loop')
  }

  recordRebuild(mutationKind, artifactKind) {
    if (!manifest.rebuildAmplification.mutationKinds.includes(mutationKind)) {
      throw new Error(`public_representation_mutation_unknown:${mutationKind}`)
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(artifactKind)) {
      throw new Error('public_representation_artifact_kind_invalid')
    }
    const key = `${mutationKind}|${artifactKind}`
    this.#rebuilds.set(key, (this.#rebuilds.get(key) ?? 0) + 1)
  }

  snapshot() {
    const amplification = {}
    for (const mutationKind of manifest.rebuildAmplification.mutationKinds) {
      let count = 0
      for (const [key, value] of this.#rebuilds) {
        if (key.startsWith(`${mutationKind}|`)) count += value
      }
      amplification[mutationKind] = count
    }
    return Object.freeze({
      schema: manifest.diagnostics.schema,
      counters: Object.fromEntries([...this.#counts].sort(([a], [b]) => a.localeCompare(b))),
      rebuildAmplification: amplification
    })
  }

  #increment(key) {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
  }

  #assertLayer(layer) {
    if (!manifest.diagnostics.allowedLayers.includes(layer)) {
      throw new Error(`public_representation_layer_unknown:${layer}`)
    }
  }

  #assertTransition(transition) {
    if (!manifest.diagnostics.allowedTransitions.includes(transition)) {
      throw new Error(`public_representation_transition_unknown:${transition}`)
    }
  }
}

export function projectCanonicalState(state, projection) {
  const contentDigest = canonicalDigest([
    state.routeIdentity,
    state.content,
    state.articleRevision ?? 0,
    state.publication ?? 0,
    state.visibilityVersion,
    state.category ?? '',
    ...(state.tags ?? [])
  ])
  return createCoordinate({
    routeIdentity: state.routeIdentity,
    sourceVersion: state.sourceVersion,
    articleRevision: state.articleRevision ?? 0,
    publication: state.publication ?? 0,
    visibilityVersion: state.visibilityVersion,
    rendererVersion: projection.rendererVersion,
    frontendRelease: projection.frontendRelease,
    frontendAssetVersion: projection.frontendAssetVersion,
    aedsProtocolVersion: projection.aedsProtocolVersion,
    aedsSchemaIdentity: projection.aedsSchemaIdentity,
    documentDigest: contentDigest,
    hydrationSidecarDigest: projection.hydrationSidecarDigest ?? '',
    seoIdentity: canonicalDigest([
      state.routeIdentity,
      state.title,
      state.category ?? '',
      ...(state.tags ?? [])
    ]),
    hydrationPageKind: state.hydrationPageKind
  })
}

export const publicRepresentationCoordinatePaths = Object.freeze({
  repositoryRoot,
  manifestPath
})
