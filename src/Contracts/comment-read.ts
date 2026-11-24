import { decodePod, decodeUtf8, isValidUnixMs, PodReader, ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireHeaders, WireRoutes, WireLimits } from './wire.generated.ts';

export type CommentAuthor = {
  mode: 'public' | 'legacy_server_visible_pseudonymous' | 'zk_anonymous';
  displayName: string;
  language: 'zh-CN' | 'en';
  badge: string;
  scope: string;
};

export type CommentNode = {
  id: string;
  parentId: string | null;
  rootId: string;
  replyToId: string | null;
  depth: number;
  childCount: number;
  moreChildren: boolean;
  deleted: boolean;
  edited: boolean;
  createdAt: number;
  content: string;
  author: CommentAuthor;
  replyToAuthor: CommentAuthor | null;
};

export type CommentRoot = { node: CommentNode; preview: CommentNode[] };
export type CursorPage<T> = { items: T[]; cursor: string | null };

function check(condition: boolean, field: string): asserts condition {
  if (!condition) throw new ProtocolError(`Invalid AEDS comment ${field}`);
}

function count(reader: PodReader, max: number): number {
  const value = reader.i32();
  check(value >= 0 && value <= max, 'count');
  return value;
}

function identifier(reader: PodReader): string | null {
  const value = reader.i64();
  check(value >= 0n, 'identifier');
  return value > 0n ? String(value) : null;
}

function zeros(reader: PodReader, length: number): void {
  check(!reader.fixedBytes(length).some(Boolean), 'reserved bytes');
}

function author(node: PodReader, required: true): CommentAuthor;
function author(node: PodReader, required: false): CommentAuthor | null;
function author(node: PodReader, required: boolean): CommentAuthor | null {
  const size = count(node, 4096);
  if (!size) {
    check(!required, 'missing author');
    return null;
  }
  const bytes = node.fixedBytes(size);
  check(size > 36, 'author size');
  const fields = new PodReader(bytes.subarray(0, 36));
  const modeCode = fields.u8();
  check(modeCode === 0 || modeCode === 1 || modeCode === 3 || modeCode === 4, 'author mode');
  const mode = modeCode === 3 ? 'public' : modeCode === 4 ? 'zk_anonymous' : 'legacy_server_visible_pseudonymous';
  zeros(fields, 3);
  const [displayName, language, badge, scope] = decodePod(bytes.subarray(36), blob => {
    let position = 0;
    return Array.from({ length: 4 }, () => {
      const offset = count(fields, size - 36), length = count(fields, size - 36);
      check(offset === position || (length === 0 && offset === 0), 'author slice');
      position += length;
      return decodeUtf8(blob.fixedBytes(length));
    });
  });
  check(displayName.length > 0 && (language === 'zh-CN' || language === 'en') && (mode !== 'public' || !scope),
    'author display');
  return { mode, displayName, language, badge, scope };
}

function node(reader: PodReader): CommentNode {
  const id = identifier(reader), parentId = identifier(reader), rootId = identifier(reader), replyToId = identifier(reader);
  const depth = count(reader, 256), childCount = count(reader, 0x7fffffff);
  const deleted = reader.bool(), moreChildren = reader.bool(), edited = reader.bool();
  zeros(reader, 1);
  const timestamp = reader.i64();
  zeros(reader, 4);
  const length = count(reader, 12288);
  const value = decodePod(reader.fixedBytes(count(reader, WireLimits.MaxPayloadBytes)), blob => ({
    parentId, replyToId, depth, childCount, moreChildren, deleted, edited,
    content: decodeUtf8(blob.fixedBytes(length)),
    author: author(blob, true), replyToAuthor: author(blob, false),
  }));
  check(id !== null && rootId !== null && isValidUnixMs(timestamp), 'node coordinates');
  check((parentId === null) === (depth === 0) && (depth !== 0 || id === rootId && replyToId === null), 'tree depth');
  check(!moreChildren || childCount > 0, 'child count');
  return { ...value, id, rootId, createdAt: Number(timestamp) };
}

export function decodeCommentRoots(payload: Uint8Array): CursorPage<CommentRoot> {
  return decodePod(payload, reader => {
    const cursor = identifier(reader), more = reader.bool(), total = count(reader, 50);
    const items = Array.from({ length: total }, () => {
      const root = node(reader);
      check(root.depth === 0, 'root depth');
      const previewCount = reader.u8();
      check(previewCount <= 3 && previewCount <= root.childCount, 'root preview');
      zeros(reader, 3);
      const preview = Array.from({ length: previewCount }, () => node(reader));
      check(preview.every(child => child.parentId === root.id && child.rootId === root.id && child.depth === 1), 'preview ancestry');
      return { node: root, preview };
    });
    check(Boolean(cursor) === more && (!more || total > 0), 'cursor');
    check(cursor === null || cursor === items.at(-1)?.node.id, 'root cursor position');
    check(items.every((item, index) => index === 0 || BigInt(item.node.id) < BigInt(items[index - 1].node.id)), 'root order');
    return { items, cursor };
  });
}

export function decodeCommentChildren(payload: Uint8Array, parentId?: string, rootId?: string): CursorPage<CommentNode> {
  return decodePod(payload, reader => {
    const parent = identifier(reader), root = identifier(reader), cursor = identifier(reader);
    const total = count(reader, 100), more = reader.bool();
    zeros(reader, 3);
    const items = Array.from({ length: total }, () => node(reader));
    check(Boolean(cursor) === more && (!more || total > 0), 'cursor');
    check(parent !== null && (parentId === undefined || parent === parentId) &&
      (rootId === undefined || root === null || root === rootId) &&
      (cursor === null || cursor === items.at(-1)?.id) &&
      items.every(child => child.parentId === parent && child.rootId === root), 'child scope');
    check(items.every((item, index) => index === 0 || BigInt(item.id) > BigInt(items[index - 1].id)), 'children order');
    return { items, cursor };
  });
}

export type CommentContext = { ancestors: CommentNode[]; target: CommentNode; siblings: CommentNode[] };

export function decodeCommentContext(payload: Uint8Array): CommentContext | null {
  return decodePod(payload, reader => {
    const id = identifier(reader), root = identifier(reader);
    const total = count(reader, 256), siblingCount = count(reader, 20);
    const unavailable = reader.bool(), hasTarget = reader.bool(), hasPrevious = reader.bool(), hasNext = reader.bool();
    zeros(reader, 4);
    if (unavailable) {
      check(id === null && root === null && total === 0 && siblingCount === 0 &&
        !hasTarget && !hasPrevious && !hasNext, 'unavailable context');
      return null;
    }
    check(hasTarget, 'missing target');
    const ancestors = Array.from({ length: total }, () => node(reader));
    const target = node(reader);
    const siblings = Array.from({ length: siblingCount }, () => node(reader));
    check(target.id === id && !target.deleted && [...ancestors, target].every((entry, index) =>
      entry.depth === index && entry.rootId === root && entry.parentId === (ancestors[index - 1]?.id ?? null)) &&
      siblings.every(item => item.id !== id && item.parentId === target.parentId && item.depth === target.depth &&
        (target.parentId === null || item.rootId === root)),
    'permalink ancestry');
    return { ancestors, target, siblings };
  });
}

function cursorQuery(cursor: string | null): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}

function readWriteEnabled(headers: Headers): boolean {
  const value = headers.get(WireHeaders.PublicCommentWriteEnabled);
  if (value !== null && value !== '1') throw new ProtocolError('Invalid AEDS comment write availability');
  return value === '1';
}

export const comments = {
  roots(article: number, cursor: string | null, signal: AbortSignal) {
    const route = WireRoutes.CommentRoots.replace('{articleId:int}', String(article));
    return request(route + cursorQuery(cursor), FrameType.CommentTreeRootCursor, (payload, headers) => ({
      ...decodeCommentRoots(payload),
      writeEnabled: readWriteEnabled(headers),
    }), signal);
  },
  children(article: number, parent: CommentNode, cursor: string | null, signal: AbortSignal) {
    const route = WireRoutes.CommentChildren.replace('{articleId:int}', String(article)).replace('{parentId:long}', parent.id);
    return request(route + cursorQuery(cursor), FrameType.CommentChildCursor,
      payload => decodeCommentChildren(payload, parent.id, parent.rootId), signal);
  },
  context(article: number, id: string, signal: AbortSignal) {
    const route = WireRoutes.CommentContext.replace('{articleId:int}', String(article)).replace('{commentId:long}', id);
    return request(route, FrameType.CommentPermalinkContext, (payload, headers) => {
      const context = decodeCommentContext(payload);
      check(context === null || context.target.id === id, 'permalink target');
      return { context, writeEnabled: readWriteEnabled(headers) };
    }, signal);
  },
};
