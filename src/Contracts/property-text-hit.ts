import { encodePod } from './aeds.ts';
import { decodePod, ProtocolError, ZERO_UUID } from './binary.ts';
import { FrameType, WireHeader, WireLimits } from './wire.generated.ts';

export type PropertyTextHitRequest = Readonly<{
  articleId: number;
  articleRevision: bigint;
  schemaRevision: bigint;
  valueRevision: bigint;
  definitionId: string;
  definitionRevision: bigint;
  sourceDigest: Uint8Array;
}>;

export function encodePropertyTextHitRequest(value: PropertyTextHitRequest): Uint8Array<ArrayBuffer> {
  validatePropertyTextHitRequest(value);
  return encodePod(FrameType.PropertyTextHitRequest, w => w.i32(value.articleId).i64(value.articleRevision)
    .i64(value.schemaRevision).i64(value.valueRevision).uuid(value.definitionId).i64(value.definitionRevision)
    .fixedBytes(value.sourceDigest));
}

export function decodePropertyTextHitRequest(payload: Uint8Array): PropertyTextHitRequest {
  if (payload.length !== WireLimits.PropertyTextHitRequestFrameBytes - WireHeader.HeaderSize)
    throw new ProtocolError('Invalid saved text property match request');
  const value = decodePod(payload, r => ({
    articleId: r.i32(), articleRevision: r.i64(), schemaRevision: r.i64(), valueRevision: r.i64(),
    definitionId: r.uuid(), definitionRevision: r.i64(),
    sourceDigest: r.fixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes),
  }));
  validatePropertyTextHitRequest(value);
  return value;
}

function validatePropertyTextHitRequest(value: PropertyTextHitRequest): void {
  if (value.articleId <= 0 || value.articleRevision <= 0n || value.schemaRevision <= 0n || value.valueRevision < 0n ||
      value.definitionId === ZERO_UUID || value.definitionRevision <= 0n ||
      value.definitionRevision > value.schemaRevision || value.sourceDigest.length !== WireLimits.AuthorTextSearchSourceDigestBytes)
    throw new ProtocolError('Invalid saved text property match request');
}
