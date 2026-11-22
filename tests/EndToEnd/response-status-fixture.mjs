import assert from 'node:assert/strict'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { FrameType } from '../../src/Contracts/wire.generated.ts'

export function assertStatus(response, expected, ...message) {
  assert.equal(response.status(), expected, ...message)
}

export async function assertEmpty(response) {
  assertStatus(response, 200)
  decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
}
