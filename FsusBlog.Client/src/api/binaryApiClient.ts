import { usePow } from '@/composables/usePow'
import { getBrowserFp } from '@/utils/fingerprint'
import { AppError, AppErrorCode, appErrorFromStatus, createAppError, err, ok, type AppResult, unwrapResult } from '@/utils/appError'
import { encodeJsonToBase64 } from '@/utils/utf8'
import { decodeBinaryEnvelope } from './binaryEnvelope'

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
  const challengeResponse = await fetch('/api/Auth/pow-challenge?_t=' + Date.now(), {
    credentials: 'include',
    headers: {
      Accept: 'application/octet-stream'
    }
  })
  const challengeBuffer = await challengeResponse.arrayBuffer()
  if (!challengeResponse.ok) {
    throw new BinaryRequestError(challengeResponse.status, `Binary request failed: ${challengeResponse.status}`, challengeBuffer)
  }

  const envelope = decodeBinaryEnvelope(challengeBuffer)
  const raw = (envelope.bodyJson ?? {}) as Record<string, unknown>
  const salt = String(raw.salt ?? raw.Salt ?? '')
  const difficulty = Number(raw.difficulty ?? raw.Difficulty ?? 0)
  const timestamp = Number(raw.timestamp ?? raw.Timestamp ?? 0)
  const signature = String(raw.signature ?? raw.Signature ?? '')
  if (!salt || !signature) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PARSE_FAILED')
  }

  const fp = getBrowserFp()
  const { nonce } = await calculate(salt, fp, difficulty)
    return {
      'X-Fsus-Device-Fp': fp,
      'X-Fsus-Pow-Proof': encodeJsonToBase64({
        powSalt: salt,
        powNonce: nonce,
        powTimestamp: timestamp,
      difficulty,
      powSignature: signature,
      browserFp: fp
    })
  }
}

export async function binaryRequestResult(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>> {
  const powHeaders = await buildPowHeadersIfNeeded(url, options)
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      Accept: 'application/octet-stream',
      ...powHeaders,
      ...(options?.headers ?? {})
    }
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
