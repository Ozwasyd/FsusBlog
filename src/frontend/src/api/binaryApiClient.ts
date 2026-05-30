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
}

export class BinaryRequestError extends AppError {
  readonly status: number;
  readonly buffer: ArrayBuffer;

  constructor(status: number, message: string, buffer: ArrayBuffer, code?: AppErrorCode) {
    super(code ?? appErrorFromStatus(status, message).code, message, { status });
    this.name = 'BinaryRequestError';
    this.status = status;
    this.buffer = buffer;
  }
}

async function buildPowHeadersIfNeeded(url: string, options?: BinaryRequestOptions): Promise<Record<string, string>> {
  if (!options?.requiresPow || url.includes('pow-challenge')) {
    return {}
  }

  const { calculate } = usePow()
  const challengeResponse = await fetch('/api/binary/auth/pow-challenge?_t=' + Date.now(), {
    credentials: 'include',
    headers: withBinaryAccept()
  })
  const challengeBuffer = await challengeResponse.arrayBuffer()
  if (!challengeResponse.ok) {
    throw new BinaryRequestError(challengeResponse.status, `Binary request failed: ${challengeResponse.status}`, challengeBuffer)
  }

  const raw = decodePowChallenge(challengeBuffer)
  const { salt, difficulty, timestamp, signature } = raw
  if (!salt || !signature) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PARSE_FAILED')
  }

  const fp = getBrowserFp()
  const { nonce } = await calculate(salt, fp, difficulty)
    return {
      [FSUS_HEADERS.deviceFingerprint]: fp,
      [FSUS_HEADERS.powProof]: encodeBinaryPowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp: fp })
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
  applyBinaryRequestHeaders(headers, options?.body !== undefined)
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
    return err(new BinaryRequestError(response.status, `Binary request failed: ${response.status}`, buffer, appErrorFromStatus(response.status, `Binary request failed: ${response.status}`).code));
  }

  return ok(buffer);
}

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer> {
  return unwrapResult(await binaryRequestResult(url, options));
}
