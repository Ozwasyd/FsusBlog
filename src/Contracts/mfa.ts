import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { api, request } from './client.ts';
import { FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

export const mfaAction = { setup: 'mfa_setup', disable: 'mfa_disable', login: 'login' } as const;
const encoder = new TextEncoder();
const invalid = () => new ProtocolError('Invalid MFA AEDS payload.');

export type Factor = { code: string; recovery?: never } | { recovery: string; code?: never };
export type MfaSetup = { seed: string; uri: string; issuer: string; account: string };

export function mfaStartData(action: string) {
  return encoded(FrameType.MfaChallengeStartRequest, [action]);
}

export function readMfaProof(payload: Uint8Array, action: string, verified: boolean): string {
  return challengeResult(payload, action, verified, false);
}

export async function mfaProfile(signal?: AbortSignal) {
  return request(WireRoutes.MfaProfile, FrameType.MfaProfile, payload => {
    if (payload.length !== WireLayouts.MfaProfileBytes || payload[8] > 1 || payload[9] !== payload[8] ||
        payload[10] !== 0 || payload[11] !== 0) throw invalid();
    const time = view(payload).getBigInt64(0, true);
    if (payload[8] === 0 && time !== 0n) throw invalid();
    const checked = new Date(Number(time));
    if (payload[8] === 1 && (time <= 0n || Number.isNaN(checked.valueOf()))) throw invalid();
    return { verifiedAt: payload[8] ? checked : null };
  }, signal);
}

export function beginMfaSetup(proof: string, signal?: AbortSignal) {
  return request(WireRoutes.MfaSetupStart, FrameType.MfaSetupStart, payload => {
    if (payload.length < WireLayouts.MfaSetupStartBytes + 4 || payload.subarray(0, 4).some(Boolean)) throw invalid();
    const [seed, uri, issuer, account] = fields(payload, 4, [32, 512, 64, 64]);
    if (!/^[A-Z2-7]{32}$/.test(seed)) throw invalid();
    return { seed, uri, issuer, account };
  }, signal, 'POST', undefined, { [WireHeaders.MfaProof]: proof });
}

export function completeMfaSetup(code: string, signal?: AbortSignal): Promise<string[]> {
  return request(WireRoutes.MfaSetupVerify, FrameType.MfaSetupVerify, payload => {
    const count = WireLimits.MfaCodeCount;
    if (payload.length !== WireLayouts.MfaSetupVerifyBytes + count * WireLayouts.MfaFixedCodeBytes ||
        payload[0] !== 1 || payload.subarray(1, 4).some(Boolean) || view(payload).getInt32(4, true) !== count)
      throw invalid();
    const codes: string[] = [];
    for (let index = 0; index < count; index++) {
      const offset = WireLayouts.MfaSetupVerifyBytes + index * WireLayouts.MfaFixedCodeBytes;
      const code = fixed(payload.subarray(offset, offset + WireLayouts.MfaFixedCodeBytes));
      if (!/^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/.test(code) || codes.includes(code)) throw invalid();
      codes.push(code);
    }
    return codes;
  }, signal, 'POST', encoded(FrameType.MfaSetupVerifyRequest, [code]));
}

export async function completeMfaLogin(token: string, factor: Factor, signal?: AbortSignal) {
  await request(WireRoutes.MfaChallengeVerify, FrameType.MfaChallengeResult, payload => {
    challengeResult(payload, mfaAction.login, true, true);
  }, signal, 'POST', attempt(token, mfaAction.login, factor));
  return api.session(signal);
}

export async function disableMfa(factor: Factor, signal?: AbortSignal) {
  const token = await request(WireRoutes.MfaChallengeStart, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, mfaAction.disable, false), signal, 'POST', mfaStartData(mfaAction.disable));
  const proof = await request(WireRoutes.MfaChallengeVerify, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, mfaAction.disable, true), signal, 'POST', attempt(token, mfaAction.disable, factor));
  await request(WireRoutes.MfaDisable, FrameType.EmptySuccess, decodeSuccess, signal,
    'POST', undefined, { [WireHeaders.MfaProof]: proof });
}

export function validMfaFactor(text: string): Factor | null {
  const value = text.trim();
  if (/^[0-9]{6}$/.test(value)) return { code: value };
  if (/^(?:[A-Fa-f0-9]{4}-){7}[A-Fa-f0-9]{4}$/.test(value)) return { recovery: value };
  return null;
}

function challengeResult(payload: Uint8Array, action: string, verified: boolean, withUser: boolean): string {
  const id = payload.length >= 4 ? view(payload).getInt32(0, true) : 0;
  if (payload.length !== WireLayouts.MfaChallengeResultBytes || payload[4] !== Number(verified) ||
      payload[5] !== Number(!withUser) || payload[6] !== Number(withUser) || payload[7] !== Number(withUser) ||
      (withUser ? id <= 0 : id !== 0) || payload.subarray(72, 104).some(Boolean) ||
      fixed(payload.subarray(8, 72)) !== (withUser ? 'anonymous_account' : '') ||
      fixed(payload.subarray(WireLayouts.MfaChallengeActionOffset, WireLayouts.MfaChallengeProofOffset)) !== action)
    throw invalid();
  const token = fixed(payload.subarray(WireLayouts.MfaChallengeProofOffset));
  if (withUser ? token.length !== 0 : !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  return token;
}

function attempt(token: string, action: string, factor: Factor) {
  return encoded(FrameType.MfaChallengeVerifyRequest, [token, action, factor.code ?? '', factor.recovery ?? '']);
}

function encoded(type: FrameType, values: string[]) {
  const parts = values.map(value => encoder.encode(value));
  const header = 8 * parts.length;
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const payload = new Uint8Array(header + 4 + size);
  const writer = view(payload);
  writer.setInt32(header, size, true);
  let offset = 0;
  parts.forEach((value, i) => {
    writer.setInt32(i * 8, offset, true);
    writer.setInt32(i * 8 + 4, value.length, true);
    payload.set(value, header + 4 + offset);
    offset += value.length;
  });
  return encodeFrame(type, payload);
}

function fields(payload: Uint8Array, start: number, limits: number[]): string[] {
  const reader = view(payload);
  const header = start + 8 * limits.length;
  if (reader.getInt32(header, true) !== payload.length - header - 4) throw invalid();
  let position = 0;
  const blob = payload.subarray(header + 4);
  const values = limits.map((limit, index) => {
    const offset = reader.getInt32(start + index * 8, true);
    const length = reader.getInt32(start + index * 8 + 4, true);
    if (offset !== position || length < 1 || length > limit || length > blob.length - position) throw invalid();
    position += length;
    return decodeUtf8(blob.subarray(offset, position));
  });
  if (position !== blob.length) throw invalid();
  return values;
}

function fixed(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  if (end < 0 || bytes.subarray(end).some(Boolean)) throw invalid();
  return decodeUtf8(bytes.subarray(0, end));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
