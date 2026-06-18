import { describe, expect, it } from 'vitest'
import {
  createCaptchaVerifyPayload,
  deriveCaptchaAnswer,
  leadingZeroBits,
  loadCaptchaRuntime,
  parseCaptchaIssuePayload,
  renderCaptchaRaster,
  solveCaptchaProof
} from '@/../wasm/security/captcha'

const issuePayload = {
  algorithm: 'fsu.captcha/chebyshev-noise@v1',
  polynomialSeedHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  noiseSeedHex: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  seedPayloadBase64: 'dj0xCmNoYWxsZW5nZUlkPTAxOTAwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMA==',
  signatureHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  gridWidth: '64',
  gridHeight: '24',
  distortionLevel: '18',
  powDifficultyBits: '8',
  issuedAtUnixMs: '1770000000000',
  expiresAtUnixMs: '1770000300000'
}

describe('CaptchaV1 frontend runtime', () => {
  it('parses provider payloads and derives a stable answer alphabet', () => {
    const parsed = parseCaptchaIssuePayload(issuePayload)
    const answer = deriveCaptchaAnswer(parsed)

    expect(answer).toBe('3F4H')
    expect(deriveCaptchaAnswer(parsed)).toBe(answer)
  })

  it('computes backend-compatible PoW nonce and verify payload fields off the main component path', async () => {
    const parsed = parseCaptchaIssuePayload(issuePayload)
    const answer = deriveCaptchaAnswer(parsed)

    const proof = await solveCaptchaProof(parsed, answer)
    const verifyPayload = await createCaptchaVerifyPayload(issuePayload, answer.toLowerCase(), 2500)

    expect(proof.nonceHex).toBe('10000000')
    expect(proof.responseTokenHex).toBe('00b00dbcdd558be9b6143868dd3cbd8e90cb77a88a525645b6e06d927f7192a6')
    expect(leadingZeroBits(proof.responseTokenHex)).toBeGreaterThanOrEqual(parsed.powDifficultyBits)
    expect(verifyPayload).toMatchObject({
      answerText: answer,
      nonceHex: proof.nonceHex,
      responseTokenHex: proof.responseTokenHex,
      solveDurationMs: '2500'
    })
  })

  it('renders a deterministic non-empty raster and reports canvas fallback mode', () => {
    const parsed = parseCaptchaIssuePayload(issuePayload)
    const raster = renderCaptchaRaster(parsed, { forceCanvasFallback: true })

    expect(raster.width).toBe(256)
    expect(raster.height).toBe(96)
    expect(raster.renderer).toBe('canvas-fallback')
    expect(raster.pixels.some((value) => value !== 0)).toBe(true)
  })

  it('fails closed when the captcha wasm runtime cannot be loaded', async () => {
    await expect(loadCaptchaRuntime({ forceFailure: true })).rejects.toThrow('captcha_wasm_load_failed')
  })
})
