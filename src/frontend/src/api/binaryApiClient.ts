import { usePow } from '@/composables/usePow'
import { getBrowserFp } from '@/utils/fingerprint'
import { AppError, AppErrorCode, appErrorFromStatus, createAppError, err, ok, type AppResult, unwrapResult } from '@/utils/appError'
import { decode } from '@wasm/aeds'
import { FrameType } from '@wasm/protocol/frame'
import { readFixedUtf8, readInt32, readInt64Number } from '@/adapters/binary/reader'
import { applyBinaryRequestHeaders, FSUS_HEADERS, withBinaryAccept } from './contracts'
import { encodeBinaryPowProofHeader } from '@/services/powProofCodec'
import { emitRumMetric } from '@/services/telemetryBus'

export interface BinaryRequestOptions extends RequestInit {
  requiresPow?: boolean
  powScope?: string
}

export class BinaryRequestError extends AppError {
  readonly status: number;
  readonly buffer: ArrayBuffer;
  readonly headers: Headers;
  readonly retryAfter: string | null;

  constructor(status: number, message: string, buffer: ArrayBuffer, code?: AppErrorCode, headers?: HeadersInit) {
    super(code ?? appErrorFromStatus(status, message).code, message, { status });
    this.name = 'BinaryRequestError';
    this.status = status;
    this.buffer = buffer;
    this.headers = new Headers(headers);
    this.retryAfter = this.headers.get('retry-after');
  }
}

const ABORT_ERROR: DOMException | Error = Object.freeze(createAbortErrorInstance())

function createAbortErrorInstance(): DOMException | Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function createAbortError(): DOMException | Error {
  return ABORT_ERROR
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

type InFlightBinaryRequest = {
  controller: AbortController
  promise: Promise<AppResult<ArrayBuffer>>
  waiters: Set<symbol>
}

const DEFAULT_POW_SCOPE = 'mutation'
const DEFAULT_POW_TIMEOUT_MS = 60_000
const inFlightBinaryRequests = new Map<string, InFlightBinaryRequest>()

async function buildBinaryPowHeadersFresh(fp: string, signal?: AbortSignal): Promise<Record<string, string>> {
  throwIfAborted(signal)

  const { calculate } = usePow()
  const challengeResponse = await fetch('/api/binary/auth/pow-challenge?_t=' + Date.now(), {
    credentials: 'include',
    headers: withBinaryAccept(),
    signal
  })
  throwIfAborted(signal)

  const challengeBuffer = await challengeResponse.arrayBuffer()
  throwIfAborted(signal)

  if (!challengeResponse.ok) {
    throw new BinaryRequestError(challengeResponse.status, `Binary request failed: ${challengeResponse.status}`, challengeBuffer, undefined, challengeResponse.headers)
  }

  const raw = decodePowChallenge(challengeBuffer)
  const { salt, difficulty, timestamp, signature } = raw
  if (!salt || !signature) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PARSE_FAILED')
  }

  throwIfAborted(signal)
  const { nonce } = await calculate(salt, fp, difficulty, DEFAULT_POW_TIMEOUT_MS, signal)
  throwIfAborted(signal)

  return {
    [FSUS_HEADERS.deviceFingerprint]: fp,
    [FSUS_HEADERS.powProof]: encodeBinaryPowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp: fp })
  }
}

export async function buildBinaryPowHeaders(signal?: AbortSignal, powScope: string = DEFAULT_POW_SCOPE): Promise<Record<string, string>> {
  throwIfAborted(signal)

  const fp = getBrowserFp()
  void powScope
  return await buildBinaryPowHeadersFresh(fp, signal)
}

function derivePowScope(url: string, options?: BinaryRequestOptions): string {
  if (options?.powScope) {
    return options.powScope
  }

  const method = (options?.method ?? 'GET').toUpperCase()
  return `${method}:${url}`
}

async function buildPowHeadersIfNeeded(url: string, options?: BinaryRequestOptions): Promise<Record<string, string>> {
  if (!options?.requiresPow || url.includes('pow-challenge')) {
    return {}
  }

  return await buildBinaryPowHeaders(options.signal ?? undefined, derivePowScope(url, options))
}

function isStateChangingRequest(options?: BinaryRequestOptions): boolean {
  const method = (options?.method ?? 'GET').toUpperCase()
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function hashRequestBody(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return 'no-body'
  }

  if (typeof body === 'string') {
    return `text:${body}`
  }

  if (body instanceof URLSearchParams) {
    return `search:${body.toString()}`
  }

  if (body instanceof ArrayBuffer) {
    return hashBytes(new Uint8Array(body))
  }

  if (ArrayBuffer.isView(body)) {
    return hashBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }

  return `object:${Object.prototype.toString.call(body)}`
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 2166136261
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }

  return `bytes:${bytes.byteLength}:${hash >>> 0}`
}

function shouldDedupeBinaryRequest(url: string, options?: BinaryRequestOptions): boolean {
  if (options?.requiresPow || url.includes('pow-challenge')) {
    return false
  }

  const method = (options?.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

function buildBinaryRequestDedupeKey(url: string, options?: BinaryRequestOptions): string {
  const method = (options?.method ?? 'GET').toUpperCase()
  return `${method}:${url}:${hashRequestBody(options?.body ?? null)}`
}

function emitBinaryDedupMetric(hit: boolean): void {
  emitRumMetric('fsus.frontend.binary.dedup.hit_ratio', {
    value: hit ? 1 : 0,
    hit
  })
}

function waitForInFlightBinaryRequest(entry: InFlightBinaryRequest, signal?: AbortSignal): Promise<AppResult<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const waiter = Symbol('binary-request-waiter')
    let settled = false

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      entry.waiters.delete(waiter)
    }

    const onAbort = () => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(createAbortError())
      if (entry.waiters.size === 0) {
        entry.controller.abort()
      }
    }

    entry.waiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })

    entry.promise.then(
      (result) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(cloneBinaryRequestResult(result))
      },
      (reason) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(reason)
      }
    )

    if (signal?.aborted) {
      onAbort()
    }
  })
}

function cloneBinaryRequestResult(result: AppResult<ArrayBuffer>): AppResult<ArrayBuffer> {
  if (!result.ok) {
    return result
  }

  return ok(result.value.slice(0))
}

function readCookieValue(name: string): string {
  if (typeof document === 'undefined') {
    return ''
  }

  const prefix = `${name}=`
  for (const item of document.cookie.split(';')) {
    const trimmed = item.trim()
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length))
    }
  }

  return ''
}

export function readCsrfToken(): string {
  if (typeof document === 'undefined') {
    return ''
  }

  const metaToken = document.querySelector<HTMLMetaElement>('meta[name="fsus-csrf-token"]')?.content?.trim()
  if (metaToken) {
    return metaToken
  }

  return readCookieValue('XSRF-TOKEN').trim()
}

function applyCsrfHeader(headers: Headers, options?: BinaryRequestOptions): void {
  if (options?.credentials === 'omit' || !isStateChangingRequest(options) || headers.has(FSUS_HEADERS.csrfToken)) {
    return
  }

  const token = readCsrfToken()
  if (token) {
    headers.set(FSUS_HEADERS.csrfToken, token)
  }
}

function decodePowChallenge(buffer: ArrayBuffer): { salt: string; difficulty: number; timestamp: number; signature: string } {
  const frame = decode(buffer)
  if (!frame.ok || frame.frameType !== FrameType.PowChallenge) {
    throw createAppError(AppErrorCode.ProtocolFailure, frame.ok ? 'POW_CHALLENGE_FRAME_UNEXPECTED' : 'POW_CHALLENGE_DECODE_FAILED')
  }

  const payload = frame.payloadView
  if (payload.byteLength !== 204) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PAYLOAD_INVALID')
  }

  return {
    salt: readFixedUtf8(payload, 0, 64),
    difficulty: readInt32(payload, 64),
    timestamp: readInt64Number(payload, 68),
    signature: readFixedUtf8(payload, 76, 128)
  }
}

async function binaryRequestResultFresh(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>> {
  const powHeaders = await buildPowHeadersIfNeeded(url, options)
  const headers = new Headers(options?.headers)
  if (options?.credentials === 'omit') {
    headers.delete('authorization')
    headers.delete('cookie')
  }
  applyBinaryRequestHeaders(headers, options?.body !== undefined)
  applyCsrfHeader(headers, options)
  for (const [key, value] of Object.entries(powHeaders)) {
    headers.set(key, value)
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers
  });

  const buffer = await response.arrayBuffer();

  if (!response.ok) {
    return err(new BinaryRequestError(response.status, `Binary request failed: ${response.status}`, buffer, appErrorFromStatus(response.status, `Binary request failed: ${response.status}`).code, response.headers));
  }

  return ok(buffer);
}

async function binaryRequestResult(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>> {
  throwIfAborted(options?.signal ?? undefined)

  if (!shouldDedupeBinaryRequest(url, options)) {
    return await binaryRequestResultFresh(url, options)
  }

  const inFlightKey = buildBinaryRequestDedupeKey(url, options)
  let entry = inFlightBinaryRequests.get(inFlightKey)

  if (!entry) {
    emitBinaryDedupMetric(false)
    const controller = new AbortController()
    const requestOptions: BinaryRequestOptions = {
      ...(options ?? {}),
      signal: controller.signal
    }
    const promise = binaryRequestResultFresh(url, requestOptions).finally(() => {
      inFlightBinaryRequests.delete(inFlightKey)
    })
    entry = {
      controller,
      promise,
      waiters: new Set()
    }
    inFlightBinaryRequests.set(inFlightKey, entry)
  } else {
    emitBinaryDedupMetric(true)
  }

  return await waitForInFlightBinaryRequest(entry, options?.signal ?? undefined)
}

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer> {
  return unwrapResult(await binaryRequestResult(url, options));
}
