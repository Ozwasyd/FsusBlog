import { deepStrictEqual, throws } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { decodeCanvasLinkPlan, encodeCanvasLinkPlan, FrameType } from '../../src/Contracts/wire.generated.ts'

test('Canvas plan matches independently assembled Unicode, UUID and 64-bit coordinates', () => {
  const vector = Uint8Array.from(Buffer.from(
    readFileSync(new URL('./fixtures/canvas-link-plan.hex', import.meta.url), 'utf8').trim(), 'hex'))
  const plan = {
    planId: '76aff0f0-ba5e-4bd3-ab12-a42d29b9131a', canvasRevision: 3n, hostArticleId: 8,
    hostRevision: 12n, targetArticleId: 21, targetRevision: 9n, sourceOffset: 30,
    insertedMarkdown: '\r\n\r\n[规划 🐝](/article/21)', expiresAtUnixSeconds: 1794680000n,
  }
  deepStrictEqual(encodeFrame(FrameType.CanvasLinkPlan, encodeCanvasLinkPlan(plan)), vector)
  deepStrictEqual(decodeCanvasLinkPlan(decodeFrame(vector, FrameType.CanvasLinkPlan).payload), plan)
  throws(() => decodeCanvasLinkPlan(decodeFrame(vector).payload.subarray(0, -1)), ProtocolError)
  throws(() => decodeFrame(vector, FrameType.CanvasConfirm), ProtocolError)
})
