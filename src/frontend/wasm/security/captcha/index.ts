const CAPTCHA_ALGORITHM = 'fsu.captcha/chebyshev-noise@v1'
const CAPTCHA_ALPHABET = ['A', 'E', 'F', 'H', 'K', 'M', 'R', 'T', 'Y', '2', '3', '4'] as const
const MASK_64 = (1n << 64n) - 1n
const encoder = new TextEncoder()

export type CaptchaRendererKind = 'offscreen-canvas' | 'canvas-fallback'
export type CaptchaEngineKind = 'wasm'

export interface CaptchaIssuePayload {
  algorithm: string
  polynomialSeedHex: string
  noiseSeedHex: string
  seedPayloadBase64: string
  signatureHex: string
  gridWidth: number
  gridHeight: number
  distortionLevel: number
  powDifficultyBits: number
  issuedAtUnixMs: number
  expiresAtUnixMs: number
}

export interface CaptchaProofResult {
  nonceHex: string
  responseTokenHex: string
  durationMs: number
}

export interface CaptchaRaster {
  width: number
  height: number
  pixels: Uint8ClampedArray
  renderer: CaptchaRendererKind
  engine: CaptchaEngineKind
}

export interface CaptchaRuntimeLoadOptions {
  forceFailure?: boolean
}

export interface CaptchaRasterOptions {
  scale?: number
  forceCanvasFallback?: boolean
}

export const captchaAlgorithm = CAPTCHA_ALGORITHM

export async function loadCaptchaRuntime(options: CaptchaRuntimeLoadOptions = {}): Promise<{ engine: CaptchaEngineKind }> {
  if (options.forceFailure || typeof WebAssembly === 'undefined') {
    throw new Error('captcha_wasm_load_failed')
  }

  try {
    await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    return { engine: 'wasm' }
  } catch {
    throw new Error('captcha_wasm_load_failed')
  }
}

export function parseCaptchaIssuePayload(payload: Record<string, unknown>): CaptchaIssuePayload {
  const parsed = {
    algorithm: requiredString(payload, 'algorithm'),
    polynomialSeedHex: normalizeHex(requiredString(payload, 'polynomialSeedHex'), 64, 'polynomialSeedHex'),
    noiseSeedHex: normalizeHex(requiredString(payload, 'noiseSeedHex'), 64, 'noiseSeedHex'),
    seedPayloadBase64: requiredString(payload, 'seedPayloadBase64'),
    signatureHex: normalizeHex(requiredString(payload, 'signatureHex'), 64, 'signatureHex'),
    gridWidth: requiredInt(payload, 'gridWidth'),
    gridHeight: requiredInt(payload, 'gridHeight'),
    distortionLevel: requiredInt(payload, 'distortionLevel'),
    powDifficultyBits: requiredInt(payload, 'powDifficultyBits'),
    issuedAtUnixMs: requiredInt(payload, 'issuedAtUnixMs'),
    expiresAtUnixMs: requiredInt(payload, 'expiresAtUnixMs')
  }

  if (parsed.algorithm !== CAPTCHA_ALGORITHM) {
    throw new Error('captcha_algorithm_unsupported')
  }
  if (parsed.gridWidth < 1 || parsed.gridWidth > 256 || parsed.gridHeight < 1 || parsed.gridHeight > 64) {
    throw new Error('captcha_grid_invalid')
  }
  if (parsed.distortionLevel < 0 || parsed.distortionLevel > 100 || parsed.powDifficultyBits < 1 || parsed.powDifficultyBits > 24) {
    throw new Error('captcha_difficulty_invalid')
  }
  if (parsed.expiresAtUnixMs <= parsed.issuedAtUnixMs) {
    throw new Error('captcha_expiry_invalid')
  }

  return parsed
}

export function deriveCaptchaAnswer(payload: CaptchaIssuePayload): string {
  const spec = createSpec(payload)
  const state = makeSeedState(spec)
  let answer = ''
  for (let i = 0; i < 4; i += 1) {
    answer += CAPTCHA_ALPHABET[Number(xoshiroNext(state) % BigInt(CAPTCHA_ALPHABET.length))]
  }

  return answer
}

export async function solveCaptchaProof(payload: CaptchaIssuePayload, answerText: string): Promise<CaptchaProofResult> {
  const started = now()
  const spec = createSpec(payload)
  const specMaterial = buildSpecMaterial(spec)
  const answerBytes = encoder.encode(answerText.trim().toUpperCase())
  const buffer = new Uint8Array(specMaterial.byteLength + answerBytes.byteLength + 4)
  buffer.set(specMaterial, 0)
  buffer.set(answerBytes, specMaterial.byteLength)
  const nonceOffset = specMaterial.byteLength + answerBytes.byteLength

  for (let nonce = 0; nonce < 4_000_000; nonce += 1) {
    writeUInt32LittleEndian(buffer, nonceOffset, nonce)
    const digest = await sha256(buffer)
    if (leadingZeroBits(bytesToHex(digest)) >= payload.powDifficultyBits) {
      return {
        nonceHex: nonceToHex(nonce),
        responseTokenHex: bytesToHex(digest),
        durationMs: Math.max(0, Math.round(now() - started))
      }
    }
  }

  throw new Error('captcha_nonce_unavailable')
}

export async function createCaptchaVerifyPayload(
  issuePayload: Record<string, unknown>,
  answerText: string,
  solveDurationMs: number
): Promise<Record<string, string>> {
  const parsed = parseCaptchaIssuePayload(issuePayload)
  const normalizedAnswer = answerText.trim().toUpperCase()
  const proof = await solveCaptchaProof(parsed, normalizedAnswer)
  return {
    algorithm: parsed.algorithm,
    polynomialSeedHex: parsed.polynomialSeedHex,
    noiseSeedHex: parsed.noiseSeedHex,
    seedPayloadBase64: parsed.seedPayloadBase64,
    signatureHex: parsed.signatureHex,
    gridWidth: String(parsed.gridWidth),
    gridHeight: String(parsed.gridHeight),
    distortionLevel: String(parsed.distortionLevel),
    powDifficultyBits: String(parsed.powDifficultyBits),
    issuedAtUnixMs: String(parsed.issuedAtUnixMs),
    expiresAtUnixMs: String(parsed.expiresAtUnixMs),
    answerText: normalizedAnswer,
    responseTokenHex: proof.responseTokenHex,
    nonceHex: proof.nonceHex,
    solveDurationMs: String(Math.max(0, Math.round(solveDurationMs)))
  }
}

export function renderCaptchaRaster(payload: CaptchaIssuePayload, options: CaptchaRasterOptions = {}): CaptchaRaster {
  const scale = Math.max(2, Math.min(6, Math.round(options.scale ?? 4)))
  const width = payload.gridWidth * scale
  const height = payload.gridHeight * scale
  const pixels = new Uint8ClampedArray(width * height * 4)
  const spec = createSpec(payload)
  const state = makeSeedState(spec)
  const answer = deriveCaptchaAnswer(payload)
  const renderer: CaptchaRendererKind =
    options.forceCanvasFallback || typeof OffscreenCanvas === 'undefined'
      ? 'canvas-fallback'
      : 'offscreen-canvas'

  fillPaper(pixels, width, height, state)
  paintNoise(pixels, width, height, state, payload.distortionLevel)
  paintAnswer(pixels, width, height, answer, state, scale, payload.distortionLevel)
  paintRuleLines(pixels, width, height, state, payload.distortionLevel)

  return { width, height, pixels, renderer, engine: 'wasm' }
}

export function leadingZeroBits(hexDigest: string): number {
  const normalized = normalizeHex(hexDigest, 64, 'digest')
  let zeros = 0
  for (let i = 0; i < normalized.length; i += 2) {
    const value = Number.parseInt(normalized.slice(i, i + 2), 16)
    if (value === 0) {
      zeros += 8
      continue
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if (((value >> bit) & 1) === 0) {
        zeros += 1
      } else {
        return zeros
      }
    }
  }
  return zeros
}

interface CaptchaSpec {
  polynomialSeed: Uint8Array
  noiseSeed: Uint8Array
  gridWidth: number
  gridHeight: number
  distortionLevel: number
  powDifficultyBits: number
}

interface XoshiroState {
  s0: bigint
  s1: bigint
  s2: bigint
  s3: bigint
}

function createSpec(payload: CaptchaIssuePayload): CaptchaSpec {
  return {
    polynomialSeed: hexToBytes(payload.polynomialSeedHex),
    noiseSeed: hexToBytes(payload.noiseSeedHex),
    gridWidth: payload.gridWidth,
    gridHeight: payload.gridHeight,
    distortionLevel: payload.distortionLevel,
    powDifficultyBits: payload.powDifficultyBits
  }
}

function makeSeedState(spec: CaptchaSpec): XoshiroState {
  const key0 = loadLittleEndian64(spec.polynomialSeed, 0)
  const key1 = loadLittleEndian64(spec.polynomialSeed, 8)
  return normalizeSeedState({
    s0: sipHash24(key0, key1, loadLittleEndian64(spec.noiseSeed, 0), loadLittleEndian64(spec.noiseSeed, 8)),
    s1: sipHash24(key0 ^ 0x9e3779b97f4a7c15n, key1 ^ 0x243f6a8885a308d3n, loadLittleEndian64(spec.noiseSeed, 16), loadLittleEndian64(spec.noiseSeed, 24)),
    s2: sipHash24(key0 ^ 0x13198a2e03707344n, key1 ^ 0xa4093822299f31d0n, loadLittleEndian64(spec.polynomialSeed, 16), loadLittleEndian64(spec.polynomialSeed, 24)),
    s3: sipHash24(
      key0 ^ 0x082efa98ec4e6c89n,
      key1 ^ 0x452821e638d01377n,
      BigInt(spec.gridWidth & 0xffff)
        | (BigInt(spec.gridHeight & 0xffff) << 16n)
        | (BigInt(spec.distortionLevel & 0xff) << 32n)
        | (BigInt(spec.powDifficultyBits & 0xff) << 40n),
      key0 ^ key1
    )
  })
}

function normalizeSeedState(state: XoshiroState): XoshiroState {
  return (state.s0 | state.s1 | state.s2 | state.s3) === 0n
    ? { s0: 0x9e3779b97f4a7c15n, s1: 0x243f6a8885a308d3n, s2: 0x13198a2e03707344n, s3: 0xa4093822299f31d0n }
    : state
}

function sipHash24(key0: bigint, key1: bigint, message0: bigint, message1: bigint): bigint {
  let v0 = 0x736f6d6570736575n ^ key0
  let v1 = 0x646f72616e646f6dn ^ key1
  let v2 = 0x6c7967656e657261n ^ key0
  let v3 = 0x7465646279746573n ^ key1
  const words = [message0, message1, 0x10n << 56n]

  for (const word of words) {
    v3 = mask64(v3 ^ word)
    ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
    ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
    v0 = mask64(v0 ^ word)
  }

  v2 = mask64(v2 ^ 0xffn)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  return mask64(v0 ^ v1 ^ v2 ^ v3)
}

function sipRound(v0: bigint, v1: bigint, v2: bigint, v3: bigint): [bigint, bigint, bigint, bigint] {
  v0 = mask64(v0 + v1)
  v1 = mask64(rotateLeft(v1, 13) ^ v0)
  v0 = rotateLeft(v0, 32)
  v2 = mask64(v2 + v3)
  v3 = mask64(rotateLeft(v3, 16) ^ v2)
  v0 = mask64(v0 + v3)
  v3 = mask64(rotateLeft(v3, 21) ^ v0)
  v2 = mask64(v2 + v1)
  v1 = mask64(rotateLeft(v1, 17) ^ v2)
  v2 = rotateLeft(v2, 32)
  return [v0, v1, v2, v3]
}

function xoshiroNext(state: XoshiroState): bigint {
  const result = mask64(rotateLeft(mask64(state.s0 + state.s3), 23) + state.s0)
  const mix = mask64(state.s1 << 17n)
  state.s2 = mask64(state.s2 ^ state.s0)
  state.s3 = mask64(state.s3 ^ state.s1)
  state.s1 = mask64(state.s1 ^ state.s2)
  state.s0 = mask64(state.s0 ^ state.s3)
  state.s2 = mask64(state.s2 ^ mix)
  state.s3 = rotateLeft(state.s3, 45)
  return result
}

function buildSpecMaterial(spec: CaptchaSpec): Uint8Array {
  const material = new Uint8Array(70)
  material.set(spec.polynomialSeed, 0)
  material.set(spec.noiseSeed, 32)
  material[64] = spec.gridWidth & 0xff
  material[65] = (spec.gridWidth >> 8) & 0xff
  material[66] = spec.gridHeight & 0xff
  material[67] = (spec.gridHeight >> 8) & 0xff
  material[68] = spec.distortionLevel & 0xff
  material[69] = spec.powDifficultyBits & 0xff
  return material
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('captcha_crypto_unavailable')
  }
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer))
}

function fillPaper(pixels: Uint8ClampedArray, width: number, height: number, state: XoshiroState): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const grain = Number(xoshiroNext(state) & 0x07n)
      const value = 244 + grain
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
}

function paintNoise(pixels: Uint8ClampedArray, width: number, height: number, state: XoshiroState, distortionLevel: number): void {
  const count = Math.max(40, Math.round(width * height * (0.018 + distortionLevel / 5000)))
  for (let i = 0; i < count; i += 1) {
    const x = Number(xoshiroNext(state) % BigInt(width))
    const y = Number(xoshiroNext(state) % BigInt(height))
    const tone = 115 + Number(xoshiroNext(state) % 90n)
    setPixel(pixels, width, height, x, y, tone, tone, tone, 255)
  }
}

function paintRuleLines(pixels: Uint8ClampedArray, width: number, height: number, state: XoshiroState, distortionLevel: number): void {
  const lines = Math.max(2, Math.round(distortionLevel / 8))
  for (let i = 0; i < lines; i += 1) {
    const yBase = Number(xoshiroNext(state) % BigInt(height))
    const amplitude = 2 + Number(xoshiroNext(state) % 5n)
    const tone = 144 + Number(xoshiroNext(state) % 40n)
    for (let x = 0; x < width; x += 1) {
      const y = Math.round(yBase + Math.sin((x + i * 17) / 18) * amplitude)
      setPixel(pixels, width, height, x, y, tone, tone, tone, 150)
    }
  }
}

function paintAnswer(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  answer: string,
  state: XoshiroState,
  scale: number,
  distortionLevel: number
): void {
  const glyphScale = Math.max(2, scale * 2)
  const glyphWidth = 5 * glyphScale
  const spacing = Math.max(4, scale * 2)
  const totalWidth = answer.length * glyphWidth + (answer.length - 1) * spacing
  let cursorX = Math.round((width - totalWidth) / 2)
  const baseY = Math.round((height - 7 * glyphScale) / 2)

  for (const ch of answer) {
    const glyph = GLYPHS[ch] ?? GLYPHS.A
    const ySkew = Number(xoshiroNext(state) % 7n) - 3
    const xSkew = Number(xoshiroNext(state) % 5n) - 2
    paintGlyph(pixels, width, height, glyph, cursorX + xSkew, baseY + ySkew, glyphScale, distortionLevel)
    cursorX += glyphWidth + spacing
  }
}

function paintGlyph(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  glyph: readonly string[],
  startX: number,
  startY: number,
  scale: number,
  distortionLevel: number
): void {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== '1') {
        continue
      }
      for (let yy = 0; yy < scale; yy += 1) {
        for (let xx = 0; xx < scale; xx += 1) {
          const wave = Math.round(Math.sin((row * scale + yy + column * 3) / 5) * (distortionLevel / 18))
          setPixel(
            pixels,
            width,
            height,
            startX + column * scale + xx,
            startY + row * scale + yy + wave,
            15,
            23,
            42,
            235
          )
        }
      }
    }
  }
}

function setPixel(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha: number
): void {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return
  }
  const offset = (y * width + x) * 4
  const mix = alpha / 255
  pixels[offset] = Math.round((pixels[offset] ?? 0) * (1 - mix) + red * mix)
  pixels[offset + 1] = Math.round((pixels[offset + 1] ?? 0) * (1 - mix) + green * mix)
  pixels[offset + 2] = Math.round((pixels[offset + 2] ?? 0) * (1 - mix) + blue * mix)
  pixels[offset + 3] = 255
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`captcha_${key}_missing`)
  }
  const normalized = String(value).trim()
  if (!normalized) {
    throw new Error(`captcha_${key}_missing`)
  }
  return normalized
}

function requiredInt(payload: Record<string, unknown>, key: string): number {
  const value = requiredString(payload, key)
  if (!/^\d+$/.test(value)) {
    throw new Error(`captcha_${key}_invalid`)
  }
  return Number(value)
}

function normalizeHex(value: string, length: number, key: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized.length !== length || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`captcha_${key}_invalid`)
  }
  return normalized
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function loadLittleEndian64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(bytes[offset + i] ?? 0) << BigInt(i * 8)
  }
  return value
}

function rotateLeft(value: bigint, bits: number): bigint {
  return mask64((value << BigInt(bits)) | (value >> BigInt(64 - bits)))
}

function mask64(value: bigint): bigint {
  return value & MASK_64
}

function writeUInt32LittleEndian(destination: Uint8Array, offset: number, value: number): void {
  destination[offset] = value & 0xff
  destination[offset + 1] = (value >> 8) & 0xff
  destination[offset + 2] = (value >> 16) & 0xff
  destination[offset + 3] = (value >> 24) & 0xff
}

function nonceToHex(nonce: number): string {
  return [
    nonce & 0xff,
    (nonce >> 8) & 0xff,
    (nonce >> 16) & 0xff,
    (nonce >> 24) & 0xff
  ].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

const GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010']
}
