import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader } from './binary.ts';
import { request } from './client.ts';
import { readMfaProof } from './mfa.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { decodeAdminAppearanceFontDetail, decodeAdminAppearanceState, encodeAdminAppearanceCommand, FrameType, WireHeaders, WireLimits, WireRoutes,
  type AdminAppearanceCommand } from './wire.generated.ts';

const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const selection = (value: string) => value.length === 0 || digest(value);

export type AdminAppearanceChange = Readonly<{
  revision: bigint;
  happenedUnixMs: bigint;
  actor: string;
  rollback: boolean;
  previousTheme: string;
  previousFont: string;
  theme: string;
  font: string;
}>;

export type AdminAppearanceHistoryPage = Readonly<{
  nextBefore: bigint | null;
  items: readonly AdminAppearanceChange[];
}>;

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

export function readAppearanceFontDetail(archive: string, signal: AbortSignal) {
  if (!digest(archive)) throw new ProtocolError('Invalid font archive digest');
  return request(`${WireRoutes.AdminAppearanceFontDetail}?digest=${archive}`, FrameType.AdminAppearanceFontDetail, payload => {
    const detail = decodeAdminAppearanceFontDetail(payload);
    if (detail.archiveDigest !== archive || !digest(detail.faceDigest) || !detail.id || !detail.version ||
        !['OFL-1.1', 'Apache-2.0'].includes(detail.licenseName) || !detail.licenseText ||
        detail.faceWeight !== 400 || detail.faceStyle !== 'normal' || detail.faceBytes < 1 ||
        detail.faceBytes > WireLimits.AdminAppearanceFontAssetBytes)
      throw new ProtocolError('Invalid appearance font detail');
    const source = [detail.name, detail.family, detail.sourcePackage, detail.sourceVersion, detail.sourceUpstream];
    if (detail.sourceKind === '' ? [...source, detail.unicodeRange].some(value => value !== '')
      : !['local-vendored', 'npm-fontsource'].includes(detail.sourceKind) || source.some(value => value === ''))
      throw new ProtocolError('Invalid appearance font source');
    return detail;
  }, signal);
}

export function readAppearanceHistory(before: bigint | undefined, signal: AbortSignal) {
  if (before !== undefined && (before <= 0n || before > 9223372036854775807n))
    throw new ProtocolError('Invalid appearance history revision');
  const path = WireRoutes.AdminAppearanceHistory + (before === undefined ? '' : `?before=${before}`);
  return request(path, FrameType.AdminAppearanceHistory, payload => decodeAppearanceHistory(payload, before), signal);
}

export function decodeAppearanceHistory(payload: Uint8Array, before?: bigint,
  limit: number = WireLimits.AdminAppearanceHistoryPageSize): AdminAppearanceHistoryPage {
  const input = new PodReader(payload);
  const nextBefore = input.i64(), count = input.i32();
  if (!Number.isInteger(limit) || limit < 1 || limit > WireLimits.AdminAppearanceHistoryMaximumItems || count < 0 || count > limit ||
      nextBefore < 0n || nextBefore > 0n && count !== limit)
    throw new ProtocolError('Invalid appearance history page');

  const items: AdminAppearanceChange[] = [];
  let previous = before;
  for (let index = 0; index < count; index++) {
    const change = {
      revision: input.i64(), happenedUnixMs: input.i64(), actor: input.text(WireLimits.NameBytes), rollback: input.bool(),
      previousTheme: input.text(WireLimits.AdminAppearanceDigestBytes), previousFont: input.text(WireLimits.AdminAppearanceDigestBytes),
      theme: input.text(WireLimits.AdminAppearanceDigestBytes), font: input.text(WireLimits.AdminAppearanceDigestBytes),
    };
    if (change.revision <= 0n || previous !== undefined && change.revision >= previous ||
        change.happenedUnixMs <= 0n || change.happenedUnixMs > 253402300799999n ||
        change.actor !== change.actor.trim() || !/^[a-z][a-z0-9_.-]{0,63}$/.test(change.actor) ||
        ![change.previousTheme, change.previousFont, change.theme, change.font].every(selection) ||
        change.previousTheme === change.theme && change.previousFont === change.font)
      throw new ProtocolError('Invalid appearance history item');
    items.push(change);
    previous = change.revision;
  }
  input.finish();
  if (nextBefore > 0n && nextBefore !== previous) throw new ProtocolError('Invalid next appearance history revision');
  return { nextBefore: nextBefore || null, items };
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
