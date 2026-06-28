import { usePow } from '@/composables/usePow'
import { getBrowserFp } from '@/utils/fingerprint'
import { AppError, AppErrorCode, appErrorFromStatus, createAppError, err, ok, type AppResult, unwrapResult } from '@/utils/appError'
import { decode } from '@wasm/aeds'
import { FrameType } from '@wasm/protocol/frame'
import { readFixedUtf8, readInt32, readInt64Number } from '@/adapters/binary/reader'
import { applyBinaryRequestHeaders, FSUS_HEADERS, withBinaryAccept } from './contracts'
import { encodeBinaryPowProofHeader } from '@/services/powProofCodec'

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

function createAbortError(): DOMException | Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

type InFlightPowHeaders = {
  controller: AbortController
  promise: Promise<Record<string, string>>
  waiters: Set<symbol>
}

const DEFAULT_POW_SCOPE = 'mutation'
const inFlightPowHeaders = new Map<string, InFlightPowHeaders>()

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
  const { nonce } = await calculate(salt, fp, difficulty, undefined, signal)
  throwIfAborted(signal)

    return {
      [FSUS_HEADERS.deviceFingerprint]: fp,
      [FSUS_HEADERS.powProof]: encodeBinaryPowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp: fp })
  }
}

function waitForInFlightPowHeaders(entry: InFlightPowHeaders, signal?: AbortSignal): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const waiter = Symbol('pow-waiter')
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
      (headers) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(headers)
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

export async function buildBinaryPowHeaders(signal?: AbortSignal, powScope: string = DEFAULT_POW_SCOPE): Promise<Record<string, string>> {
  throwIfAborted(signal)

  const fp = getBrowserFp()
  const inFlightKey = `${powScope}:${fp}`
  let entry = inFlightPowHeaders.get(inFlightKey)

  if (!entry) {
    const controller = new AbortController()
    const promise = buildBinaryPowHeadersFresh(fp, controller.signal).finally(() => {
      inFlightPowHeaders.delete(inFlightKey)
    })
    entry = {
      controller,
      promise,
      waiters: new Set()
    }
    inFlightPowHeaders.set(inFlightKey, entry)
  }

  return await waitForInFlightPowHeaders(entry, signal)
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

  return await buildBinaryPowHeaders(options.signal, derivePowScope(url, options))
}

function isStateChangingRequest(options?: BinaryRequestOptions): boolean {
  const method = (options?.method ?? 'GET').toUpperCase()
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
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

async function binaryRequestResult(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>> {
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

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer> {
  return unwrapResult(await binaryRequestResult(url, options));
}
