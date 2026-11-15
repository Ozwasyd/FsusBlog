import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError } from './binary.ts';
import { FrameType, WireLimits } from './wire.generated.ts';

export type ArticleSummaryCommand = Readonly<{
  id: number;
  expectedRevision: bigint;
  idempotencyKey: string;
  text: string;
}>;

export type ArticleSummary = Readonly<{ id: number; revision: bigint; text: string }>;

export function encodeArticleSummaryCommand(value: ArticleSummaryCommand): Uint8Array<ArrayBuffer> {
  validateSummary(value.id, value.expectedRevision, value.text, WireLimits.ArticleSummaryEditChars);
  if (value.idempotencyKey === '00000000-0000-0000-0000-000000000000')
    throw new ProtocolError('Invalid private article summary');

  const writer = new PodWriter();
  writer.i32(value.id);
  writer.i64(value.expectedRevision);
  writer.uuid(value.idempotencyKey);
  writer.text(value.text, WireLimits.ArticleSummaryEditBytes);
  return encodeFrame(FrameType.ArticleSummaryCommand, writer.finish());
}

export function decodeArticleSummary(payload: Uint8Array): ArticleSummary {
  const reader = new PodReader(payload);
  const id = reader.i32();
  const revision = reader.i64();
  const text = reader.text(WireLimits.ArticleSummaryReadBytes);
  reader.finish();
  validateSummary(id, revision, text, WireLimits.ArticleSummaryReadChars);
  return { id, revision, text };
}

function validateSummary(id: number, revision: bigint, text: string, maxChars: number): void {
  if (id <= 0 || revision <= 0n || text.length > maxChars || text.includes('\0'))
    throw new ProtocolError('Invalid private article summary');
}
