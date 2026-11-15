import { PodReader } from './binary.ts';
import { ProtocolError, request, validSiteSessionId } from './client.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

export type SitePasskey = Readonly<{
  createdAt: Date;
  lastUsedAt: Date | null;
  backupEligible: boolean;
  backedUp: boolean;
  current: boolean;
}>;

const latestTimestamp = 253402300799999n;

export function sitePasskeys(expectedSession: string, signal?: AbortSignal): Promise<SitePasskey[]> {
  if (!validSiteSessionId(expectedSession)) throw invalid();
  return request(WireRoutes.SitePasskeys, FrameType.SitePasskeys, decodeSitePasskeys, signal,
    'GET', undefined, { [WireHeaders.CurrentSession]: expectedSession });
}

export function decodeSitePasskeys(payload: Uint8Array): SitePasskey[] {
  const reader = new PodReader(payload);
  const count = reader.i32();
  if (count < 1 || count > WireLimits.SitePasskeyListSize) throw invalid();
  const rows: SitePasskey[] = [];
  for (let i = 0; i < count; i++) rows.push(readSitePasskeyRow(reader, i === 0));
  reader.finish();
  return rows;
}

export function readSitePasskeyRow(reader: PodReader, currentExpected: boolean): SitePasskey {
  const created = reader.i64();
  const used = reader.i64();
  const backupEligible = reader.bool();
  const backedUp = reader.bool();
  const current = reader.bool();
  if (created <= 0n || created > latestTimestamp || used < 0n || used > latestTimestamp ||
      (backedUp && !backupEligible) || current !== currentExpected) throw invalid();
  return {
    createdAt: new Date(Number(created)),
    lastUsedAt: used === 0n ? null : new Date(Number(used)),
    backupEligible,
    backedUp,
    current,
  };
}

function invalid() { return new ProtocolError('Invalid site Passkey data.'); }
