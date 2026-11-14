import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader } from './binary.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { decodeAdminAppearanceState, encodeAdminAppearanceCommand, FrameType, WireHeaders, WireLimits, WireRoutes,
  type AdminAppearanceCommand } from './wire.generated.ts';

const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const selection = (value: string) => value.length === 0 || digest(value);

export function readAdminAppearance(signal: AbortSignal) {
  return request(WireRoutes.AdminAppearanceState, FrameType.AdminAppearanceState, payload => {
    const state = decodeAdminAppearanceState(payload);
    const { revision, theme, font, previousTheme, previousFont } = state;
    if (revision < 0n || ![theme, font, previousTheme, previousFont].every(selection) ||
        (revision === 0n && (state.canRollback || previousTheme || previousFont)))
      throw new ProtocolError('Invalid appearance activation state');
    return state;
  }, signal);
}

export function readAppearanceCatalog(signal: AbortSignal) {
  return request(WireRoutes.AdminAppearanceCatalog, FrameType.AdminAppearanceCatalog, payload => {
    const input = new PodReader(payload);
    const count = input.i32();
    if (count < 0 || count > WireLimits.AdminAppearanceMaximumItems) throw new ProtocolError('Invalid appearance catalog size');
    const entries = Array.from({ length: count }, () => {
      const id = input.text(WireLimits.AdminAppearanceIdBytes);
      const version = input.text(WireLimits.AdminAppearanceVersionBytes);
      const archive = input.text(WireLimits.AdminAppearanceDigestBytes);
      const font = input.bool();
      if (!id || !version || !digest(archive)) throw new ProtocolError('Invalid appearance catalog entry');
      return { id, version, archive, font };
    });
    input.finish();
    return entries;
  }, signal);
}

export async function applyAppearance(input: AdminAppearanceCommand, signal: AbortSignal) {
  const frame = encodeFrame(FrameType.AdminAppearanceCommand, encodeAdminAppearanceCommand(input));
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminAppearanceStepUpBegin, signal, frame, true);
  const proof = await request(WireRoutes.AdminAppearanceStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, 'admin-sensitive', true), signal, 'POST', assertion);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), part => part.toString(16).padStart(2, '0')).join('');
  const challenge = await request(WireRoutes.AdminAppearancePow, FrameType.PowChallenge, decodePowChallenge,
    signal, 'POST', frame, { [WireHeaders.PowClientNonce]: nonce });
  const work = await solveScopedPow(challenge, nonce, signal);
  await request(WireRoutes.AdminAppearanceApply, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', frame,
    { [WireHeaders.MfaProof]: proof, [WireHeaders.PowProof]: encodePowProof(challenge, work, nonce) });
}
