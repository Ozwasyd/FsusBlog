import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError } from './binary.ts';
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
  const writer = new PodWriter();
  writer.i32(value.articleId);
  writer.i64(value.articleRevision);
  writer.i64(value.schemaRevision);
  writer.i64(value.valueRevision);
  writer.uuid(value.definitionId);
  writer.i64(value.definitionRevision);
  writer.fixedBytes(value.sourceDigest);
  return encodeFrame(FrameType.PropertyTextHitRequest, writer.finish());
}

export function decodePropertyTextHitRequest(payload: Uint8Array): PropertyTextHitRequest {
  if (payload.length !== WireLimits.PropertyTextHitRequestFrameBytes - WireHeader.HeaderSize)
    throw new ProtocolError('Invalid saved text property match request');

  const reader = new PodReader(payload);
  const value = {
    articleId: reader.i32(),
    articleRevision: reader.i64(),
    schemaRevision: reader.i64(),
    valueRevision: reader.i64(),
    definitionId: reader.uuid(),
    definitionRevision: reader.i64(),
    sourceDigest: reader.fixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes),
  };
  reader.finish();
  validatePropertyTextHitRequest(value);
  return value;
}

function validatePropertyTextHitRequest(value: PropertyTextHitRequest): void {
  if (value.articleId <= 0 || value.articleRevision <= 0n || value.schemaRevision <= 0n || value.valueRevision < 0n ||
      value.definitionId === '00000000-0000-0000-0000-000000000000' || value.definitionRevision <= 0n ||
      value.definitionRevision > value.schemaRevision || value.sourceDigest.length !== WireLimits.AuthorTextSearchSourceDigestBytes)
    throw new ProtocolError('Invalid saved text property match request');
}
