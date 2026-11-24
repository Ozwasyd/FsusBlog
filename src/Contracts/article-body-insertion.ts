import { encodeFrame, encodePod, ProtocolError } from './aeds.ts';
import { decodePod, PodReader, PodWriter, ZERO_UUID } from './binary.ts';
import { type Draft } from './client.ts';
import { sessionGet, sessionPost } from './internal/http.ts';
import {
  decodeDraft, decodeDraftRevisionBodyInsertion, encodeArticleBodyInsertionCommand,
  FrameType, WireHeader, WireLimits, WireRoutes, type ArticleCommand, type ArticleBodyInsertionCommand, type DraftRevisionBodyInsertion,
} from './wire.generated.ts';

export type BodyInsertion = Readonly<{offset: number; length: number}>;

export function saveWithBodyInsertion(input: ArticleBodyInsertionCommand, session: string,
  signal: AbortSignal): Promise<Draft> {
  const frame = encodeFrame(FrameType.ArticleBodyInsertionCommand, encodeArticleBodyInsertionCommand(input));
  return saveBodyChanges(input, frame, () => new ProtocolError('Invalid saved body insertion coordinates'), session, signal, false);
}

export function readBodyInsertion(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyInsertion> {
  return sessionGet(bodyRevisionPath(id, revision, sourceRevision, 'body-insertion'), FrameType.DraftRevisionBodyInsertion, payload => {
    const map = decodeDraftRevisionBodyInsertion(payload);
    if (map.id !== id || map.revision !== revision || map.sourceRevision !== sourceRevision)
      throw new ProtocolError('Invalid revision body map coordinates');
    if (!map.available && (map.offset !== 0 || map.length !== 0 || map.body || map.sourceBody || map.digest || map.sourceDigest))
      throw new ProtocolError('Invalid missing revision body map');
    return map;
  }, signal, session);
}

export type ArticleBodyInsertionsCommand = Readonly<Omit<ArticleBodyInsertionCommand, 'offset' | 'length'> & {
  insertions: readonly BodyInsertion[];
}>;
export type DraftRevisionBodyInsertionEdge = Readonly<{
  sourceDigest: string;
  digest: string;
  insertions: readonly BodyInsertion[];
}>;
export type DraftRevisionBodyInsertionChain = BodyChain<DraftRevisionBodyInsertionEdge>;

export function encodeArticleBodyInsertionsCommand(value: ArticleBodyInsertionsCommand): Uint8Array<ArrayBuffer> {
  validateInsertionsCommand(value);
  return encodePod(FrameType.ArticleBodyInsertionsCommand, writer => {
    writeArticleBodyCommand(writer, value).i32(value.insertions.length);
    for (const { offset, length } of value.insertions) writer.i32(offset).i32(length);
  });
}

export function decodeArticleBodyInsertionsCommand(payload: Uint8Array): ArticleBodyInsertionsCommand {
  const value = decodePod(payload, reader => ({ ...readArticleBodyCommand(reader), insertions: readInsertions(reader) }),
    WireLimits.MaxArticleBodyInsertionsCommandFrameBytes - WireHeader.HeaderSize, invalidChain);
  validateInsertionsCommand(value);
  return value;
}

export function decodeDraftRevisionBodyInsertionChain(payload: Uint8Array): DraftRevisionBodyInsertionChain {
  return decodeBodyChain(payload, WireLimits.MaxDraftRevisionBodyInsertionChainFrameBytes, invalidChain, readInsertions,
    (sourceDigest, digest, insertions, state) => {
      state.length = lengthAfterInsertions(state.length, insertions);
      return { sourceDigest, digest, insertions };
    });
}

export function saveWithBodyInsertions(input: ArticleBodyInsertionsCommand, session: string, signal: AbortSignal): Promise<Draft> {
  return saveBodyChanges(input, encodeArticleBodyInsertionsCommand(input), invalidChain, session, signal);
}

export function readBodyInsertionChain(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyInsertionChain> {
  return sessionGet(bodyRevisionPath(id, revision, sourceRevision, 'body-chain'), FrameType.DraftRevisionBodyInsertionChain, payload => {
    const chain = decodeDraftRevisionBodyInsertionChain(payload);
    if (chain.id !== id || chain.revision !== revision || chain.sourceRevision !== sourceRevision) throw invalidChain();
    return chain;
  }, signal, session);
}

function readInsertions(reader: PodReader): BodyInsertion[] {
  const count = reader.i32();
  if (count < 0 || count > WireLimits.ArticleBodyInsertionOperations) throw invalidChain();
  return Array.from({ length: count }, () => ({ offset: reader.i32(), length: reader.i32() }));
}

function validateInsertionsCommand(value: ArticleBodyInsertionsCommand): void {
  if (value.id <= 0 || value.expectedRevision <= 0n || value.idempotencyKey === ZERO_UUID ||
      value.insertions.length < 1 || value.insertions.length > WireLimits.ArticleBodyInsertionOperations) throw invalidChain();
  const sourceLength = value.body.length - value.insertions.reduce((total, operation) => total + operation.length, 0);
  if (lengthAfterInsertions(sourceLength, value.insertions) !== value.body.length) throw invalidChain();
}

function lengthAfterInsertions(length: number, insertions: readonly BodyInsertion[]): number {
  if (!Number.isSafeInteger(length) || length < 0 || length > WireLimits.BodyBytes) throw invalidChain();
  for (const insertion of insertions) {
    if (!Number.isSafeInteger(insertion.offset) || !Number.isSafeInteger(insertion.length) || insertion.offset < 0 ||
        insertion.offset > length || insertion.length <= 0 || insertion.length > WireLimits.BodyBytes - length) throw invalidChain();
    length += insertion.length;
  }
  return length;
}

function invalidChain(): ProtocolError {
  return new ProtocolError('Invalid saved body insertion chain');
}

export type BodyEdit = Readonly<{ offset: number; removedLength: number; insert: string }>;
export type ArticleBodyEditsCommand = Readonly<Omit<ArticleBodyInsertionCommand, 'offset' | 'length'> & {
  edits: readonly BodyEdit[];
}>;
export type DraftRevisionBodyEditEdge = Readonly<{ sourceDigest: string; digest: string; edits: readonly BodyEdit[] }>;
export type DraftRevisionBodyEditChain = BodyChain<DraftRevisionBodyEditEdge>;

const utf8 = new TextEncoder();
const hexDigest = /^[0-9a-f]{64}$/;

export function encodeArticleBodyEditsCommand(input: ArticleBodyEditsCommand): Uint8Array<ArrayBuffer> {
  validateEditsCommand(input);
  return encodePod(FrameType.ArticleBodyEditsCommand, writer => {
    writeArticleBodyCommand(writer, input).i32(input.edits.length);
    for (const edit of input.edits) writer.i32(edit.offset).i32(edit.removedLength).text(edit.insert, WireLimits.BodyBytes);
  });
}

export function decodeArticleBodyEditsCommand(payload: Uint8Array): ArticleBodyEditsCommand {
  const input = decodePod(payload, reader => ({ ...readArticleBodyCommand(reader), edits: readEdits(reader) }),
    WireLimits.MaxArticleBodyEditsCommandFrameBytes - WireHeader.HeaderSize, invalidEdits);
  validateEditsCommand(input);
  return input;
}

export function decodeDraftRevisionBodyEditChain(payload: Uint8Array): DraftRevisionBodyEditChain {
  return decodeBodyChain(payload, WireLimits.MaxDraftRevisionBodyEditChainFrameBytes, invalidEdits, readEdits,
    (sourceDigest, digest, edits, state) => {
      applyEdits(state, edits);
      return { sourceDigest, digest, edits };
    });
}

export function saveWithBodyEdits(input: ArticleBodyEditsCommand, session: string, signal: AbortSignal): Promise<Draft> {
  return saveBodyChanges(input, encodeArticleBodyEditsCommand(input), invalidEdits, session, signal);
}

export function readBodyEditChain(id: number, revision: bigint, sourceRevision: bigint, session: string,
  signal: AbortSignal): Promise<DraftRevisionBodyEditChain> {
  return sessionGet(bodyRevisionPath(id, revision, sourceRevision, 'body-edit'), FrameType.DraftRevisionBodyEditChain, payload => {
    const chain = decodeDraftRevisionBodyEditChain(payload);
    if (chain.id !== id || chain.revision !== revision || chain.sourceRevision !== sourceRevision) throw invalidEdits();
    return chain;
  }, signal, session);
}

function readEdits(reader: PodReader): BodyEdit[] {
  const count = reader.i32();
  if (count < 0 || count > WireLimits.ArticleBodyInsertionOperations) throw invalidEdits();
  return Array.from({ length: count }, () => ({ offset: reader.i32(), removedLength: reader.i32(), insert: reader.text(WireLimits.BodyBytes) }));
}

function validateEditsCommand(input: ArticleBodyEditsCommand): void {
  if (input.id <= 0 || input.expectedRevision <= 0n || input.idempotencyKey === ZERO_UUID ||
      input.edits.length < 1 || input.edits.length > WireLimits.ArticleBodyInsertionOperations) throw invalidEdits();
  const length = input.body.length + input.edits.reduce((total, edit) => total + edit.removedLength - edit.insert.length, 0);
  const state: BodySize = { length, bytesRemaining: WireLimits.BodyBytes };
  applyEdits(state, input.edits);
  if (state.length !== input.body.length) throw invalidEdits();
}

function applyEdits(state: BodySize, edits: readonly BodyEdit[]): void {
  let { length, bytesRemaining } = state;
  if (!Number.isSafeInteger(length) || length < 0 || length > WireLimits.BodyBytes) throw invalidEdits();
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.removedLength) || edit.offset < 0 || edit.offset > length ||
        edit.removedLength < 0 || edit.removedLength > length - edit.offset ||
        (edit.removedLength === 0 && edit.insert.length === 0) || edit.insert.includes('\0')) throw invalidEdits();
    bytesRemaining -= utf8.encode(edit.insert).length;
    length += edit.insert.length - edit.removedLength;
    if (length > WireLimits.BodyBytes || bytesRemaining < 0) throw invalidEdits();
  }
  state.length = length;
  state.bytesRemaining = bytesRemaining;
}

function invalidEdits(): ProtocolError {
  return new ProtocolError('Invalid saved body edit chain');
}

type BodyChain<Edge> = Readonly<{
  id: number; revision: bigint; sourceRevision: bigint; available: boolean; sourceBody: string; body: string;
  edges: readonly Edge[];
}>;

type BodySize = { length: number; bytesRemaining: number };

function decodeBodyChain<Operation, Edge>(
  payload: Uint8Array, frameLimit: number, invalid: () => ProtocolError, readOperations: (reader: PodReader) => Operation[],
  replayEdge: (sourceDigest: string, digest: string, operations: Operation[], state: BodySize) => Edge,
): BodyChain<Edge> {
  return decodePod(payload, reader => {
    const id = reader.i32(), revision = reader.i64(), sourceRevision = reader.i64(), available = reader.bool();
    const sourceBody = reader.text(WireLimits.BodyBytes), body = reader.text(WireLimits.BodyBytes), count = reader.i32();
    if (id <= 0 || sourceRevision <= 0n || sourceRevision >= revision || count < 0 || count > WireLimits.ArticleBodyInsertionChainEdges ||
        (available ? BigInt(count) !== revision - sourceRevision : count !== 0 || sourceBody !== '' || body !== '')) throw invalid();
    const edges: Edge[] = [];
    let previousDigest = '';
    const state: BodySize = { length: sourceBody.length, bytesRemaining: WireLimits.BodyBytes };
    for (let index = 0; index < count; index++) {
      const sourceDigest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
      const digest = reader.text(WireLimits.ArticleBodyInsertionDigestBytes);
      const operations = readOperations(reader);
      if (!hexDigest.test(sourceDigest) || !hexDigest.test(digest) || (index !== 0 && sourceDigest !== previousDigest) ||
          (operations.length === 0 && sourceDigest !== digest)) throw invalid();
      edges.push(replayEdge(sourceDigest, digest, operations, state));
      previousDigest = digest;
    }
    if (state.length !== body.length) throw invalid();
    return { id, revision, sourceRevision, available, sourceBody, body, edges };
  }, frameLimit - WireHeader.HeaderSize, invalid);
}

function writeArticleBodyCommand(writer: PodWriter, input: ArticleCommand): PodWriter {
  return writer.i32(input.id).i64(input.expectedRevision).uuid(input.idempotencyKey)
    .text(input.title, WireLimits.TitleBytes).text(input.body, WireLimits.BodyBytes);
}

function readArticleBodyCommand(reader: PodReader): ArticleCommand {
  return { id: reader.i32(), expectedRevision: reader.i64(), idempotencyKey: reader.uuid(),
    title: reader.text(WireLimits.TitleBytes), body: reader.text(WireLimits.BodyBytes) };
}

function saveBodyChanges(input: ArticleCommand, frame: Uint8Array<ArrayBuffer>, invalid: () => ProtocolError,
  session: string, signal: AbortSignal, matchBody = true) {
  return sessionPost(WireRoutes.Save, FrameType.Draft, payload => {
    const draft = decodeDraft(payload);
    if (draft.id !== input.id || draft.revision !== input.expectedRevision + 1n || (matchBody && draft.body !== input.body)) throw invalid();
    return draft;
  }, signal, frame, session);
}

function bodyRevisionPath(id: number, revision: bigint, sourceRevision: bigint, map: string) {
  const path = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(id))
    .replace('{sourceRevision:long}', String(sourceRevision));
  return `${path}?revision=${revision}&map=${map}`;
}
