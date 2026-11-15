import { encodeFrame, ProtocolError } from './aeds.ts';
import { PodReader, PodWriter } from './binary.ts';
import { request, siteSessionHeader, type Draft } from './client.ts';
import {
  decodeDraft, FrameType, WireHeader, WireLimits, WireRoutes, type ArticleBodyInsertionCommand,
} from './wire.generated.ts';

export type BodyEdit = Readonly<{ offset: number; removedLength: number; insert: string }>;
export type ArticleBodyEditsCommand = Readonly<Omit<ArticleBodyInsertionCommand, 'offset' | 'length'> & {
  edits: readonly BodyEdit[];
}>;
export type DraftRevisionBodyEditEdge = Readonly<{ sourceDigest: string; digest: string; edits: readonly BodyEdit[] }>;
export type DraftRevisionBodyEditChain = Readonly<{
  id: number; revision: bigint; sourceRevision: bigint; available: boolean; sourceBody: string; body: string;
  edges: readonly DraftRevisionBodyEditEdge[];
}>;

const utf8 = new TextEncoder();
const hexDigest = /^[0-9a-f]{64}$/;

export function encodeArticleBodyEditsCommand(input: ArticleBodyEditsCommand): Uint8Array<ArrayBuffer> {
  validateCommand(input);
  const writer = new PodWriter();
  writer.i32(input.id);
  writer.i64(input.expectedRevision);
  writer.uuid(input.idempotencyKey);
  writer.text(input.title, WireLimits.TitleBytes);
  writer.text(input.body, WireLimits.BodyBytes);
  writer.i32(input.edits.length);
  for (const edit of input.edits) {
    writer.i32(edit.offset);
    writer.i32(edit.removedLength);
    writer.text(edit.insert, WireLimits.BodyBytes);
  }
  return encodeFrame(FrameType.ArticleBodyEditsCommand, writer.finish());
}

export function decodeArticleBodyEditsCommand(payload: Uint8Array): ArticleBodyEditsCommand {
  if (payload.length > WireLimits.MaxArticleBodyEditsCommandFrameBytes - WireHeader.HeaderSize) throw invalid();
  const reader = new PodReader(payload);
  const input = {
    id: reader.i32(), expectedRevision: reader.i64(), idempotencyKey: reader.uuid(),
    title: reader.text(WireLimits.TitleBytes), body: reader.text(WireLimits.BodyBytes), edits: readEdits(reader),
  };
  reader.finish();
  validateCommand(input);
  return input;
}

export function decodeDraftRevisionBodyEditChain(payload: Uint8Array): DraftRevisionBodyEditChain {
  if (payload.length > WireLimits.MaxDraftRevisionBodyEditChainFrameBytes - WireHeader.HeaderSize) throw invalid();
  const reader = new PodReader(payload);
  const id = reader.i32(), revision = reader.i64(), sourceRevision = reader.i64(), available = reader.bool();
  const sourceBody = reader.text(WireLimits.BodyBytes), body = reader.text(WireLimits.BodyBytes), count = reader.i32();
  if (id <= 0 || sourceRevision <= 0n || sourceRevision >= revision || count < 0 || count > WireLimits.ArticleBodyInsertionChainEdges ||
      (available ? BigInt(count) !== revision - sourceRevision : count !== 0 || sourceBody !== '' || body !== '')) throw invalid();

  const edges: DraftRevisionBodyEditEdge[] = [];
  let previousDigest = '';
  let state: BodyEditSize = { length: sourceBody.length, bytesRemaining: WireLimits.BodyBytes };
  for (let index = 0; index < count; index++) {
    const sourceDigest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
    const digest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
    const edits = readEdits(reader);
    if (!hexDigest.test(sourceDigest) || !hexDigest.test(digest) || (index !== 0 && sourceDigest !== previousDigest) ||
        (edits.length === 0 && sourceDigest !== digest)) throw invalid();
    state = sizeAfterEdits(state, edits);
    previousDigest = digest;
    edges.push({ sourceDigest, digest, edits });
  }
  if (state.length !== body.length) throw invalid();
  reader.finish();
  return { id, revision, sourceRevision, available, sourceBody, body, edges };
}

export function saveWithBodyEdits(input: ArticleBodyEditsCommand, session: string, signal: AbortSignal): Promise<Draft> {
  return request(WireRoutes.Save, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n || draft.body !== input.body) throw invalid();
    return draft;
  }, signal, 'POST', encodeArticleBodyEditsCommand(input), siteSessionHeader(session));
}

export function readBodyEditChain(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyEditChain> {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return request(`${path}?revision=${revision}&map=body-edit`, FrameType.DraftRevisionBodyEditChain, payload => {
    const chain = decodeDraftRevisionBodyEditChain(payload);
    if (chain.id !== id || chain.revision !== revision || chain.sourceRevision !== sourceRevision) throw invalid();
    return chain;
  }, signal, 'GET', undefined, siteSessionHeader(session));
}

function readEdits(reader: PodReader): BodyEdit[] {
  const count = reader.i32();
  if (count < 0 || count > WireLimits.ArticleBodyInsertionOperations) throw invalid();
  return Array.from({ length: count }, () => ({ offset: reader.i32(), removedLength: reader.i32(), insert: reader.text(WireLimits.BodyBytes) }));
}

function validateCommand(input: ArticleBodyEditsCommand): void {
  if (input.id <= 0 || input.expectedRevision <= 0n || input.idempotencyKey === '00000000-0000-0000-0000-000000000000' ||
      input.edits.length < 1 || input.edits.length > WireLimits.ArticleBodyInsertionOperations) throw invalid();
  const length = input.body.length + input.edits.reduce((total, edit) => total + edit.removedLength - edit.insert.length, 0);
  if (sizeAfterEdits({ length, bytesRemaining: WireLimits.BodyBytes }, input.edits).length !== input.body.length) throw invalid();
}

type BodyEditSize = { length: number; bytesRemaining: number };
function sizeAfterEdits({ length, bytesRemaining }: BodyEditSize, edits: readonly BodyEdit[]): BodyEditSize {
  if (!Number.isSafeInteger(length) || length < 0 || length > WireLimits.BodyBytes) throw invalid();
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.removedLength) || edit.offset < 0 || edit.offset > length ||
        edit.removedLength < 0 || edit.removedLength > length - edit.offset ||
        (edit.removedLength === 0 && edit.insert.length === 0) || edit.insert.includes('\0')) throw invalid();
    bytesRemaining -= utf8.encode(edit.insert).length;
    length += edit.insert.length - edit.removedLength;
    if (length > WireLimits.BodyBytes || bytesRemaining < 0) throw invalid();
  }
  return { length, bytesRemaining };
}

function invalid(): ProtocolError {
  return new ProtocolError('Invalid saved body edit chain');
}
