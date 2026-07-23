// Generated from src/shared/Contracts/Validation/public-representation-coordinate.json; do not edit by hand.

export const PUBLIC_REPRESENTATION_COORDINATE_SCHEMA = 'fsusblog.public-representation-coordinate.v1' as const
export const PUBLIC_REPRESENTATION_COORDINATE_VERSION = 1 as const
export const PUBLIC_REPRESENTATION_INVARIANTS = [
  "routeIdentity",
  "sourceVersion",
  "articleRevision",
  "publication",
  "visibilityVersion",
  "rendererVersion",
  "frontendRelease",
  "frontendAssetVersion",
  "aedsProtocolVersion",
  "aedsSchemaIdentity",
  "documentDigest",
  "seoIdentity",
  "hydrationPageKind"
] as const
export const PUBLIC_REPRESENTATION_TRANSITIONS = [
  "canonical-to-public-aot",
  "public-aot-to-html",
  "hydration-to-sidecar",
  "canonical-to-hot-read",
  "materialize-runtime-entry",
  "artifact-to-browser-hydration",
  "service-worker-navigation"
] as const

export type PublicRepresentationCoordinate = Readonly<{
  routeIdentity: string
  sourceVersion: string
  articleRevision: string
  publication: string
  visibilityVersion: string
  rendererVersion: string
  frontendRelease: string
  frontendAssetVersion: string
  aedsProtocolVersion: number
  aedsSchemaIdentity: string
  documentDigest: string
  hydrationSidecarDigest: string
  seoIdentity: string
  hydrationPageKind: string
}>

export type PublicRepresentationTransition = typeof PUBLIC_REPRESENTATION_TRANSITIONS[number]
