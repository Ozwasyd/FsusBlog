import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader, PodWriter } from './binary.ts';
import { request, validSiteSessionId } from './client.ts';
import { requestPasskeyAssertion } from './passkey.ts';
import { readSitePasskeyRow, type SitePasskey } from './site-passkeys.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

export type SitePasskeyManagedRow = SitePasskey & Readonly<{
  reference: string;
  revision: bigint;
  name: string;
}>;

export function sitePasskeyManagement(expectedSession: string, signal?: AbortSignal): Promise<SitePasskeyManagedRow[]> {
  return request(WireRoutes.SitePasskeyManagement, FrameType.SitePasskeyManagement, decodeSitePasskeyManagement,
    signal, 'GET', undefined, sessionHeader(expectedSession));
}

export async function renameSitePasskey(reference: string, expectedRevision: bigint, name: string, expectedSession: string,
  signal?: AbortSignal): Promise<void> {
  const headers = sessionHeader(expectedSession);
  const intent = encodeSitePasskeyRename(reference, expectedRevision, name);
  const assertion = await requestPasskeyAssertion(WireRoutes.SitePasskeyRenameBegin, signal, intent, true, false, headers);
  await request(WireRoutes.SitePasskeyRenameComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', assertion, headers);
}

export function encodeSitePasskeyRename(reference: string, expectedRevision: bigint, name: string): Uint8Array<ArrayBuffer> {
  if (reference.length !== WireLimits.SitePasskeyReferenceBytes * 2 || !/^[0-9a-f]+$/.test(reference) ||
      expectedRevision < 0n || !validName(name)) throw invalid();
  const writer = new PodWriter();
  writer.fixedBytes(Uint8Array.from({ length: WireLimits.SitePasskeyReferenceBytes }, (_, index) =>
    parseInt(reference.slice(index * 2, index * 2 + 2), 16)));
  writer.i64(expectedRevision);
  writer.text(name, WireLimits.SitePasskeyNameBytes);
  return encodeFrame(FrameType.SitePasskeyRename, writer.finish());
}

export function decodeSitePasskeyManagement(payload: Uint8Array): SitePasskeyManagedRow[] {
  const reader = new PodReader(payload);
  const count = reader.i32();
  if (count < 1 || count > WireLimits.SitePasskeyListSize) throw invalid();
  const rows: SitePasskeyManagedRow[] = [];
  const references = new Set<string>();
  for (let index = 0; index < count; index++) {
    const reference = Array.from(reader.fixedBytes(WireLimits.SitePasskeyReferenceBytes), value =>
      value.toString(16).padStart(2, '0')).join('');
    const revision = reader.i64();
    const name = reader.text(WireLimits.SitePasskeyNameBytes);
    if (references.has(reference) || revision < 0n ||
        (revision === 0n ? name !== '' : !validName(name) || /^\p{White_Space}|\p{White_Space}$|\p{Cc}/u.test(name)))
      throw invalid();
    references.add(reference);
    rows.push({ reference, revision, name, ...readSitePasskeyRow(reader, index === 0) });
  }
  reader.finish();
  return rows;
}

function validName(name: string): boolean {
  return name.length <= WireLimits.SitePasskeyNameChars && /\P{White_Space}/u.test(name);
}

function sessionHeader(session: string) {
  if (!validSiteSessionId(session)) throw invalid();
  return { [WireHeaders.CurrentSession]: session };
}

function invalid() { return new ProtocolError('Invalid site Passkey management data.'); }
