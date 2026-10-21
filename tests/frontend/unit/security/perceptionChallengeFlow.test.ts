import { describe, expect, it, vi } from 'vitest'
import {
  SecurityChallengeKind,
  type SecurityChallengeAssignment,
  type SecurityChallengeProviderPayload,
  type VerifySecurityChallengeRequest
} from '@/api/security'
import {
  buildPerceptionVerifyProviderPayload,
  createPerceptionChallengeRuntime,
  mapPerceptionChallengeAssignment,
  mapPerceptionVerifyResult
} from '@/services/securityPerceptionChallengeFlow'
import type { PerceptionV2WorkerClient } from '@/services/securityPerceptionV2Client'

const assignment: SecurityChallengeAssignment = {
  challengeId: 'perception-1',
  traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
  tenantId: 'tenant-main',
  kind: SecurityChallengeKind.PerceptionLocalizationV2,
  escalationLevel: 2,
  action: 'comment.create',
  routeKey: 'article:42',
  subjectHash: 'a'.repeat(64),
  clientIpHash: 'b'.repeat(64),
  deviceFpHash: 'c'.repeat(64),
  issuedAtUnixMs: 1_770_000_000_000,
  expiresAtUnixMs: 1_770_000_300_000
}

const recipeJson = JSON.stringify({
  schema: 'fsus.challenge.render-recipe@v2',
  taskKind: 'localization',
  layers: [{
    opacity: 0.9,
    strokeSegments: [{
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.5, y: 0.4 }
      ],
      width: 0.035,
      colorRgba: '#172033ff'
    }]
  }],
  presentationHints: {
    canvasWidth: '320',
    canvasHeight: '180'
  }
})

const providerPayload: SecurityChallengeProviderPayload = {
  challengeId: assignment.challengeId,
  payload: {
    algorithm: 'fsu.challenge/perception-sealed@v2',
    keyVersion: 'v1',
    taskKind: 'localization',
    recipeJson,
    recipeHashHex: 'd'.repeat(64),
    sealedToken: 'sealed-token',
    signatureHex: 'e'.repeat(64),
    issuedAtUnixMs: String(assignment.issuedAtUnixMs),
    expiresAtUnixMs: String(assignment.expiresAtUnixMs)
  }
}

describe('perception v2 business challenge flow', () => {
  it('maps backend assignments into the FsusUI perception challenge contract', () => {
    const challenge = mapPerceptionChallengeAssignment(assignment, providerPayload)

    expect(challenge).toMatchObject({
      challengeId: 'perception-1',
      kind: 'localization',
      gridWidth: 320,
      gridHeight: 180,
      expiresAtUnixMs: assignment.expiresAtUnixMs
    })
    expect(challenge.meta).toMatchObject({
      action: 'comment.create',
      routeKey: 'article:42',
      recipeHashHex: 'd'.repeat(64),
      recipeJson
    })
  })

  it('renders through the worker and verifies with sealed provider payload', async () => {
    let now = 1_770_000_001_000
    const verifyRequests: VerifySecurityChallengeRequest[] = []
    const workerClient: PerceptionV2WorkerClient = {
      render: vi.fn().mockResolvedValue({
        ok: true,
        renderer: 'canvas-fallback',
        result: {
          kind: 'rgba-raster',
          width: 320,
          height: 180,
          pixels: new Uint8ClampedArray([1, 2, 3, 255])
        }
      }),
      dispose: vi.fn()
    }
    const runtime = createPerceptionChallengeRuntime({
      envelopeId: assignment.challengeId,
      assignment,
      providerPayload,
      workerClient,
      now: () => now,
      verifyChallenge: async (request) => {
        verifyRequests.push(request)
        return {
          verified: true,
          envelopeId: request.envelopeId,
          completedCount: 1,
          memberCount: 1,
          envelopeCompleted: true,
          expiresAtUnixMs: assignment.expiresAtUnixMs,
          challengeId: request.challengeId,
          kind: request.kind,
          policyVersion: 'risk-v1',
          proofToken: 'proof-perception',
          reason: '',
          retryAfterMs: 0
        }
      }
    })

    await expect(runtime.renderer.render(runtime.challenge)).resolves.toMatchObject({
      kind: 'rgba-raster',
      width: 320,
      height: 180
    })

    now += 2_400
    await expect(runtime.client.verify?.({
      kind: 'localization',
      x: 192,
      y: 99,
      challengeId: assignment.challengeId
    })).resolves.toMatchObject({
      verified: true,
      proofToken: 'proof-perception'
    })

    expect(verifyRequests).toHaveLength(1)
    expect(verifyRequests[0]).toMatchObject({
      challengeId: assignment.challengeId,
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      action: 'comment.create',
      routeKey: 'article:42',
      providerPayload: expect.objectContaining({
        algorithm: 'fsu.challenge/perception-sealed@v2',
        keyVersion: 'v1',
        recipeHashHex: 'd'.repeat(64),
        sealedToken: 'sealed-token',
        signatureHex: 'e'.repeat(64),
        x: '192',
        y: '99'
      })
    })
    expect(Number(verifyRequests[0].providerPayload!.solveDurationMs)).toBeGreaterThanOrEqual(750)
  })

  it('does not expose detailed perception failure reasons to the host', () => {
    expect(mapPerceptionVerifyResult({
      verified: false,
      envelopeId: assignment.challengeId,
      completedCount: 0,
      memberCount: 1,
      envelopeCompleted: false,
      expiresAtUnixMs: 0,
      challengeId: assignment.challengeId,
      kind: assignment.kind,
      policyVersion: 'risk-v1',
      proofToken: '',
      reason: 'perception_localization_invalid',
      retryAfterMs: 1500
    })).toEqual({
      verified: false,
      reason: '验证未通过，请重试。',
      retryAfterMs: 1500
    })
  })

  it('builds localization and micro-interaction verify payloads without semantic recipe fields', () => {
    expect(buildPerceptionVerifyProviderPayload(providerPayload.payload, {
      kind: 'localization',
      x: 192,
      y: 99
    }, 2400)).toMatchObject({
      x: '192',
      y: '99',
      solveDurationMs: '2400',
      sealedToken: 'sealed-token'
    })

    expect(buildPerceptionVerifyProviderPayload(providerPayload.payload, {
      kind: 'micro-interaction',
      steps: ['drag:confirm:0.70,0.24']
    }, 2400)).toMatchObject({
      stepSummary: 'drag:confirm:0.70,0.24',
      x: '0.7',
      y: '0.24'
    })
  })
})
