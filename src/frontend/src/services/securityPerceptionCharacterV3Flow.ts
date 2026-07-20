import {
  PerceptionCharacterV3Representation,
  SecurityChallengeKind,
  type PerceptionCharacterV3IssuePayload,
  type SecurityChallengeAssignment,
  type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi'
import type { VerifySecurityChallengeRequest } from '@/api/security'
import type { FsusUiPerceptionCharacterMedia } from '@/fsusui/perceptionCharacterChallenge'

const ALGORITHM = 'fsu.challenge/perception-character-raster@v3' as const
const VISUAL_WIDTH = 512
const VISUAL_HEIGHT = 192
const VISUAL_BYTES = VISUAL_WIDTH * VISUAL_HEIGHT
const MAX_AUDIO_BYTES = 256 * 1024
const MAX_ANSWER_CHARS = 32

type VerifyChallenge = (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>

export type PerceptionCharacterV3VerifyOutcome =
  | 'verified'
  | 'retryable'
  | 'reissue'
  | 'unavailable'
  | 'rejected'

export interface PerceptionCharacterV3VerifyResult {
  verified: boolean
  outcome: PerceptionCharacterV3VerifyOutcome
  retryable: boolean
  reissueRequired: boolean
  unavailable: boolean
  rejected: boolean
  proofToken?: string
  retryAfterMs: number
}

export interface PerceptionCharacterV3MediaResource {
  readonly media: FsusUiPerceptionCharacterMedia
  dispose(): void
}

export interface PerceptionCharacterV3Flow {
  readonly challengeId: string
  readonly envelopeId: string
  readonly representation: 'visual' | 'audio'
  readonly expiresAtUnixMs: number
  readonly attemptBudget: 2
  createMedia(): PerceptionCharacterV3MediaResource
  verify(answer: string): Promise<PerceptionCharacterV3VerifyResult>
  dispose(): void
}

export interface PerceptionCharacterV3FlowOptions {
  assignment: SecurityChallengeAssignment
  payload: PerceptionCharacterV3IssuePayload
  verifyChallenge: VerifyChallenge
  createObjectUrl?: (blob: Blob) => string
  revokeObjectUrl?: (url: string) => void
}

export function createPerceptionCharacterV3Flow(options: PerceptionCharacterV3FlowOptions): PerceptionCharacterV3Flow {
  assertBinding(options.assignment, options.payload)
  let mediaResource: PerceptionCharacterV3MediaResource | null = null
  let disposed = false
  return {
    challengeId: options.payload.challengeId,
    envelopeId: options.payload.envelopeId,
    representation: options.payload.representation === PerceptionCharacterV3Representation.Visual ? 'visual' : 'audio',
    expiresAtUnixMs: options.payload.expiresAtUnixMs,
    attemptBudget: 2,
    createMedia() {
      if (disposed) throw new TypeError('perception_character_v3_flow_disposed')
      mediaResource?.dispose()
      mediaResource = createPerceptionCharacterV3Media(options.payload, options)
      return mediaResource
    },
    async verify(answer) {
      if (disposed) throw new TypeError('perception_character_v3_flow_disposed')
      if (typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS) {
        throw new TypeError('perception_character_v3_answer_invalid')
      }
      const response = await options.verifyChallenge({
        envelopeId: options.payload.envelopeId,
        challengeId: options.payload.challengeId,
        kind: SecurityChallengeKind.PerceptionCharacterV3,
        action: options.assignment.action,
        routeKey: options.assignment.routeKey,
        perceptionCharacterV3: {
          algorithm: ALGORITHM,
          challengeId: options.payload.challengeId,
          envelopeId: options.payload.envelopeId,
          representation: options.payload.representation,
          answer,
          stateToken: options.payload.stateToken
        }
      })
      return mapPerceptionCharacterV3VerifyResult(response)
    },
    dispose() {
      if (disposed) return
      disposed = true
      mediaResource?.dispose()
      mediaResource = null
      options.payload.mediaBytes.fill(0)
    }
  }
}

export function createPerceptionCharacterV3Media(
  payload: PerceptionCharacterV3IssuePayload,
  options: Pick<PerceptionCharacterV3FlowOptions, 'createObjectUrl' | 'revokeObjectUrl'> = {}
): PerceptionCharacterV3MediaResource {
  if (payload.representation === PerceptionCharacterV3Representation.Visual) {
    if (payload.mediaType !== 'application/x-fsus-gray8' || payload.mediaBytes.byteLength !== VISUAL_BYTES ||
        payload.physicalWidth !== VISUAL_WIDTH || payload.physicalHeight !== VISUAL_HEIGHT ||
        payload.displayWidth !== 320 || payload.displayHeight !== 120) {
      throw new TypeError('perception_character_v3_visual_media_invalid')
    }
    const pixels = new Uint8ClampedArray(VISUAL_BYTES * 4)
    for (let source = 0, target = 0; source < VISUAL_BYTES; source += 1, target += 4) {
      const gray = payload.mediaBytes[source]!
      pixels[target] = gray
      pixels[target + 1] = gray
      pixels[target + 2] = gray
      pixels[target + 3] = 255
    }
    const media: FsusUiPerceptionCharacterMedia = {
      raster: { kind: 'rgba-raster', pixels, width: VISUAL_WIDTH, height: VISUAL_HEIGHT }
    }
    let disposed = false
    return {
      media,
      dispose() {
        if (disposed) return
        disposed = true
        pixels.fill(0)
        media.raster = null
      }
    }
  }

  if (payload.representation !== PerceptionCharacterV3Representation.Audio || payload.mediaType !== 'audio/wav' ||
      payload.mediaBytes.byteLength <= 0 || payload.mediaBytes.byteLength > MAX_AUDIO_BYTES ||
      payload.physicalWidth !== 0 || payload.physicalHeight !== 0 || payload.displayWidth !== 0 || payload.displayHeight !== 0) {
    throw new TypeError('perception_character_v3_audio_media_invalid')
  }
  const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL)
  const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL)
  const objectUrl = createObjectUrl(new Blob([payload.mediaBytes], { type: 'audio/wav' }))
  const media: FsusUiPerceptionCharacterMedia = { audio: { src: objectUrl, type: 'audio/wav' } }
  let disposed = false
  return {
    media,
    dispose() {
      if (disposed) return
      disposed = true
      revokeObjectUrl(objectUrl)
      media.audio = null
    }
  }
}

export function mapPerceptionCharacterV3VerifyResult(response: SecurityChallengeVerifyResponse): PerceptionCharacterV3VerifyResult {
  const outcome = response.verified
    ? 'verified'
    : response.reason === 'retryable'
      ? 'retryable'
      : response.reason === 'reissueRequired'
        ? 'reissue'
        : response.reason === 'unavailable'
          ? 'unavailable'
          : 'rejected'
  return {
    verified: outcome === 'verified',
    outcome,
    retryable: outcome === 'retryable',
    reissueRequired: outcome === 'reissue',
    unavailable: outcome === 'unavailable',
    rejected: outcome === 'rejected',
    ...(outcome === 'verified' && response.proofToken ? { proofToken: response.proofToken } : {}),
    retryAfterMs: Math.max(0, response.retryAfterMs)
  }
}

function assertBinding(assignment: SecurityChallengeAssignment, payload: PerceptionCharacterV3IssuePayload): void {
  if (assignment.kind !== SecurityChallengeKind.PerceptionCharacterV3 || assignment.challengeId !== payload.challengeId ||
      assignment.issuedAtUnixMs !== payload.issuedAtUnixMs || assignment.expiresAtUnixMs !== payload.expiresAtUnixMs ||
      payload.algorithm !== ALGORITHM) {
    throw new TypeError('perception_character_v3_assignment_mismatch')
  }
}
