import type { Component } from 'vue'

// Temporary compatibility shim for the lockfile package.
// Cleanup condition: remove this declaration after @ozwasyd/element-plus is
// updated to a package build whose root .d.ts exports ElEmptyState directly.
declare module '@ozwasyd/element-plus' {
  export const ElEmptyState: Component
  export const ElSiteHeader: Component
  export const FsusPerceptionChallenge: Component
  export const FsusTextTaskChallenge: Component

  export type PerceptionChallengeKind = 'text-task' | 'localization' | 'micro-interaction'
  export type PerceptionChallengeState =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'error'
    | 'verifying'
    | 'submitting'
    | 'failed'
    | 'verified'
    | 'expired'

  export type PerceptionChallengePoint = {
    x: number
    y: number
  }

  export type PerceptionChallengeRenderPayload =
    | {
        kind: 'image-url'
        src: string
        width: number
        height: number
        alt?: string
      }
    | {
        kind: 'bitmap'
        bitmap: ImageBitmap
        width: number
        height: number
        alt?: string
      }
    | {
        kind: 'rgba-raster'
        pixels: Uint8ClampedArray
        width: number
        height: number
        alt?: string
      }

  export type PerceptionChallengeAssignment = {
    challengeId?: string
    kind: PerceptionChallengeKind
    prompt?: string
    description?: string
    gridWidth?: number
    gridHeight?: number
    expiresAtUnixMs?: number
    renderPayload?: PerceptionChallengeRenderPayload | null
    microInteractionEnabled?: boolean
    meta?: Record<string, unknown>
  }

  export type PerceptionChallengeSubmitPayload =
    | {
        kind: 'text-task'
        value: string
        challengeId?: string
      }
    | {
        kind: 'localization'
        x: number
        y: number
        challengeId?: string
      }
    | {
        kind: 'micro-interaction'
        steps: string[]
        challengeId?: string
      }

  export type PerceptionChallengeVerifyResult = {
    verified: boolean
    proofToken?: string
    reason?: string
    retryAfterMs?: number
  }

  export type PerceptionChallengeExpiredPayload = {
    challengeId?: string
    reason: 'state' | 'proofExpired' | 'expiresAtUnixMs'
  }

  export type PerceptionChallengeClient = {
    refresh?: () => PerceptionChallengeAssignment | null | Promise<PerceptionChallengeAssignment | null>
    verify?: (payload: PerceptionChallengeSubmitPayload) => PerceptionChallengeVerifyResult | Promise<PerceptionChallengeVerifyResult>
  }

  export type PerceptionChallengeRenderer = {
    render: (challenge: PerceptionChallengeAssignment) =>
      | PerceptionChallengeRenderPayload
      | null
      | Promise<PerceptionChallengeRenderPayload | null>
  }
}
