import { argon2idAsync } from '@noble/hashes/argon2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export const POSPACE_ALGORITHM = 'fsu.pospace/argon2id@v1'

const MIN_MEMORY_KIB = 1024
const MAX_MEMORY_KIB = 65_536
const MOBILE_MAX_MEMORY_KIB = 8192
const LOW_MEMORY_MAX_MEMORY_KIB = 8192
const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 6
const MIN_LANES = 1
const MAX_LANES = 4
const MIN_TARGET_DURATION_MS = 100
const MAX_TARGET_DURATION_MS = 5000
const NONCE_BYTES = 16
const PROOF_BYTES = 32

export interface PoSpaceProviderPayload {
  algorithm: string
  saltHex: string
  memoryKib: number
  iterations: number
  lanes: number
  targetDurationMs: number
}

export interface PoSpaceAssignmentContext {
  challengeId: string
  action: string
  routeKey: string
  subjectHash: string
  clientIpHash: string
  deviceFpHash: string
  policyVersion: string
}

export type PoSpaceMemoryTier = 'unknown' | 'low' | 'standard' | 'high'

export interface PoSpaceCapabilitySnapshot {
  supported: boolean
  reason: string
  memoryTier: PoSpaceMemoryTier
  hardwareConcurrency: number
  mobileHint: boolean
  maxAllowedMemoryKib: number
  requestedMemoryKib: number
  workerAvailable: boolean
}

export interface PoSpaceEnvironmentHints {
  workerAvailable?: boolean
  hardwareConcurrency?: number
  deviceMemoryGb?: number
  userAgent?: string
  mobileHint?: boolean
  forceSlowDevice?: boolean
}

export interface PoSpaceSolveOptions extends PoSpaceEnvironmentHints {
  nonceHex?: string
}

export type PoSpaceSolveResult =
  | {
      ok: true
      nonceHex: string
      proofHex: string
      durationMs: number
      capability: PoSpaceCapabilitySnapshot
    }
  | {
      ok: false
      unsupported: true
      reason: string
      capability: PoSpaceCapabilitySnapshot
    }

export function parsePoSpacePayload(raw: Record<string, unknown>): PoSpaceProviderPayload {
  const payload: PoSpaceProviderPayload = {
    algorithm: requireString(raw.algorithm, 'algorithm'),
    saltHex: requireHex(raw.saltHex, 16, 'saltHex'),
    memoryKib: requireInteger(raw.memoryKib, 'memoryKib'),
    iterations: requireInteger(raw.iterations, 'iterations'),
    lanes: requireInteger(raw.lanes, 'lanes'),
    targetDurationMs: requireInteger(raw.targetDurationMs, 'targetDurationMs')
  }

  if (payload.algorithm !== POSPACE_ALGORITHM) {
    throw new Error('pospace_algorithm_unsupported')
  }
  if (!isValidParameters(payload)) {
    throw new Error('pospace_parameters_invalid')
  }
  return payload
}

export function parsePoSpaceAssignment(raw: Record<string, unknown>): PoSpaceAssignmentContext {
  return {
    challengeId: requireString(raw.challengeId, 'challengeId'),
    action: requireString(raw.action, 'action'),
    routeKey: requireString(raw.routeKey, 'routeKey'),
    subjectHash: requireHex(raw.subjectHash, 32, 'subjectHash'),
    clientIpHash: requireHex(raw.clientIpHash, 32, 'clientIpHash'),
    deviceFpHash: requireHex(raw.deviceFpHash, 32, 'deviceFpHash'),
    policyVersion: requireString(raw.policyVersion, 'policyVersion')
  }
}

export function detectPoSpaceCapability(
  payload: PoSpaceProviderPayload,
  hints: PoSpaceEnvironmentHints = {}
): PoSpaceCapabilitySnapshot {
  const workerAvailable = hints.workerAvailable ?? typeof Worker !== 'undefined'
  const nav = typeof navigator === 'undefined'
    ? undefined
    : navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } }
  const hardwareConcurrency = hints.hardwareConcurrency ?? nav?.hardwareConcurrency ?? 1
  const hintedUserAgent = hints.userAgent
  const userAgent = hintedUserAgent ?? nav?.userAgent ?? ''
  const mobileHint = hints.mobileHint
    ?? (hintedUserAgent ? isMobileUserAgent(hintedUserAgent) : nav?.userAgentData?.mobile ?? isMobileUserAgent(userAgent))
  const deviceMemoryGb = hints.deviceMemoryGb ?? nav?.deviceMemory
  const memoryTier = resolveMemoryTier(deviceMemoryGb)
  const maxAllowedMemoryKib = mobileHint
    ? MOBILE_MAX_MEMORY_KIB
    : memoryTier === 'low'
      ? LOW_MEMORY_MAX_MEMORY_KIB
      : MAX_MEMORY_KIB

  let supported = true
  let reason = 'supported'
  if (!workerAvailable) {
    supported = false
    reason = 'worker_unavailable'
  } else if (hints.forceSlowDevice || hardwareConcurrency <= 1) {
    supported = false
    reason = 'slow_device'
  } else if (payload.memoryKib > maxAllowedMemoryKib) {
    supported = false
    reason = mobileHint ? 'mobile_memory_cap' : 'memory_tier_cap'
  }

  return {
    supported,
    reason,
    memoryTier,
    hardwareConcurrency,
    mobileHint,
    maxAllowedMemoryKib,
    requestedMemoryKib: payload.memoryKib,
    workerAvailable
  }
}

export async function solvePoSpaceProof(
  assignment: PoSpaceAssignmentContext,
  payload: PoSpaceProviderPayload,
  options: PoSpaceSolveOptions = {}
): Promise<PoSpaceSolveResult> {
  const capability = detectPoSpaceCapability(payload, {
    ...options,
    workerAvailable: options.workerAvailable ?? true
  })
  if (!capability.supported) {
    return {
      ok: false,
      unsupported: true,
      reason: capability.reason,
      capability
    }
  }

  const nonceHex = options.nonceHex ? requireHex(options.nonceHex, NONCE_BYTES, 'nonceHex') : createNonceHex()
  const startedAt = nowMs()
  const proofBytes = await argon2idAsync(createMaterial(assignment, payload, nonceHex), hexToBytes(payload.saltHex), {
    t: payload.iterations,
    m: payload.memoryKib,
    p: payload.lanes,
    dkLen: PROOF_BYTES,
    asyncTick: 10,
    maxmem: payload.memoryKib * 1024 + 1024 * 1024
  })
  return {
    ok: true,
    nonceHex,
    proofHex: bytesToHex(proofBytes),
    durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
    capability
  }
}

export function createPoSpaceVerifyPayload(
  issuePayload: Record<string, unknown>,
  nonceHex: string,
  proofHex: string
): Record<string, string> {
  const parsed = parsePoSpacePayload(issuePayload)
  return {
    algorithm: parsed.algorithm,
    saltHex: parsed.saltHex,
    memoryKib: parsed.memoryKib.toString(),
    iterations: parsed.iterations.toString(),
    lanes: parsed.lanes.toString(),
    targetDurationMs: parsed.targetDurationMs.toString(),
    nonceHex: requireHex(nonceHex, NONCE_BYTES, 'nonceHex'),
    proofHex: requireHex(proofHex, PROOF_BYTES, 'proofHex')
  }
}

function createMaterial(assignment: PoSpaceAssignmentContext, payload: PoSpaceProviderPayload, nonceHex: string): Uint8Array {
  return utf8ToBytes([
    'fsu.pospace.argon2id.v1',
    assignment.challengeId,
    assignment.action,
    assignment.routeKey,
    assignment.subjectHash,
    assignment.clientIpHash,
    assignment.deviceFpHash,
    assignment.policyVersion,
    nonceHex,
    payload.targetDurationMs.toString()
  ].join('\n'))
}

function isValidParameters(payload: PoSpaceProviderPayload): boolean {
  return payload.memoryKib >= MIN_MEMORY_KIB && payload.memoryKib <= MAX_MEMORY_KIB
    && payload.iterations >= MIN_ITERATIONS && payload.iterations <= MAX_ITERATIONS
    && payload.lanes >= MIN_LANES && payload.lanes <= MAX_LANES
    && payload.targetDurationMs >= MIN_TARGET_DURATION_MS && payload.targetDurationMs <= MAX_TARGET_DURATION_MS
}

function resolveMemoryTier(deviceMemoryGb?: number): PoSpaceMemoryTier {
  if (typeof deviceMemoryGb !== 'number' || !Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0) {
    return 'unknown'
  }
  if (deviceMemoryGb < 4) {
    return 'low'
  }
  return deviceMemoryGb >= 8 ? 'high' : 'standard'
}

function createNonceHex(): string {
  const nonce = new Uint8Array(NONCE_BYTES)
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('pospace_crypto_unavailable')
  }
  crypto.getRandomValues(nonce)
  return bytesToHex(nonce)
}

function requireString(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim()
  if (normalized.length === 0) {
    throw new Error(`pospace_${field}_missing`)
  }
  return normalized
}

function requireInteger(value: unknown, field: string): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`pospace_${field}_invalid`)
  }
  return parsed
}

function requireHex(value: unknown, bytes: number, field: string): string {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized.length !== bytes * 2 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`pospace_${field}_invalid`)
  }
  return normalized
}

function isMobileUserAgent(userAgent: string): boolean {
  return /android|iphone|ipad|mobile/i.test(userAgent)
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
