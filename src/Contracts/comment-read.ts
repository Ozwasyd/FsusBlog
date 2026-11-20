import { ProtocolError, decodeUtf8 } from './binary.ts';
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

class Read {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(length: number): Uint8Array {
    check(length >= 0 && length <= this.bytes.length - this.offset, 'length');
    const field = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return field;
  }

  private view(length: number): DataView {
    const part = this.take(length);
    return new DataView(part.buffer, part.byteOffset, part.byteLength);
  }

  byte(): number { return this.take(1)[0]; }
  count(max: number): number {
    const value = this.view(4).getInt32(0, true);
    check(value >= 0 && value <= max, 'count');
    return value;
  }
  i64(): bigint { return this.view(8).getBigInt64(0, true); }
  id(): string | null {
    const value = this.i64();
    check(value >= 0n, 'identifier');
    return value > 0n ? String(value) : null;
  }
  flag(): boolean {
    const value = this.byte();
    check(value <= 1, 'flag');
    return value === 1;
  }
  zeros(length: number): void {
    check(!this.take(length).some(Boolean), 'reserved bytes');
  }
  end(): void {
    check(this.offset === this.bytes.length, 'trailing bytes');
  }
}

function footer(reader: Read, cursor: string | null, count: number, more: boolean): void {
  check(Boolean(cursor) === more && (!more || count > 0), 'cursor');
  reader.end();
}

function author(node: Read, required: true): CommentAuthor;
function author(node: Read, required: false): CommentAuthor | null;
function author(node: Read, required: boolean): CommentAuthor | null {
  const size = node.count(4096);
  if (!size) {
    check(!required, 'missing author');
    return null;
  }
  const bytes = node.take(size);
  check(size > 36, 'author size');
  const fields = new Read(bytes.subarray(0, 36));
  const modeCode = fields.byte();
  check(modeCode === 0 || modeCode === 1 || modeCode === 3 || modeCode === 4, 'author mode');
  const mode = modeCode === 3 ? 'public' : modeCode === 4 ? 'zk_anonymous' : 'legacy_server_visible_pseudonymous';
  fields.zeros(3);
  const blob = new Read(bytes.subarray(36));
  let position = 0;
  const text = Array.from({ length: 4 }, () => {
    const offset = fields.count(size - 36);
    const length = fields.count(size - 36);
    check(offset === position || length === 0 && offset === 0, 'author slice');
    position += length;
    return decodeUtf8(blob.take(length));
  });
  blob.end();
  const [displayName, language, badge, scope] = text;
  check(displayName.length > 0 && (language === 'zh-CN' || language === 'en') && (mode !== 'public' || !scope),
    'author display');
  return { mode, displayName, language, badge, scope };
}

function node(reader: Read): CommentNode {
  const id = reader.id();
  const parentId = reader.id();
  const rootId = reader.id();
  const replyToId = reader.id();
  const depth = reader.count(256);
  const childCount = reader.count(0x7fffffff);
  const deleted = reader.flag();
  const moreChildren = reader.flag();
  const edited = reader.flag();
  reader.zeros(1);
  const timestamp = reader.i64();
  reader.zeros(4);
  const length = reader.count(12288);
  const blob = new Read(reader.take(reader.count(WireLimits.MaxPayloadBytes)));
  const content = decodeUtf8(blob.take(length));
  const value = {
    parentId, replyToId, depth, childCount, moreChildren, deleted, edited, content,
    author: author(blob, true), replyToAuthor: author(blob, false),
  };
  blob.end();
  check(id !== null && rootId !== null && timestamp >= -62135596800000n && timestamp <= 253402300799999n, 'node coordinates');
  check((parentId === null) === (depth === 0) && (depth !== 0 || id === rootId && replyToId === null), 'tree depth');
  check(!moreChildren || childCount > 0, 'child count');
  return { ...value, id, rootId, createdAt: Number(timestamp) };
}

export function decodeCommentRoots(payload: Uint8Array): CursorPage<CommentRoot> {
  const reader = new Read(payload);
  const cursor = reader.id();
  const more = reader.flag();
  const count = reader.count(50);
  const items = Array.from({ length: count }, () => {
    const root = node(reader);
    check(root.depth === 0, 'root depth');
    const previewCount = reader.byte();
    check(previewCount <= 3 && previewCount <= root.childCount, 'root preview');
    reader.zeros(3);
    const preview = Array.from({ length: previewCount }, () => node(reader));
    check(preview.every(child => child.parentId === root.id && child.rootId === root.id && child.depth === 1), 'preview ancestry');
    return { node: root, preview };
  });
  footer(reader, cursor, count, more);
  check(cursor === null || cursor === items.at(-1)?.node.id, 'root cursor position');
  check(items.every((item, index) => index === 0 || BigInt(item.node.id) < BigInt(items[index - 1].node.id)),
    'root order');
  return { items, cursor };
}

export function decodeCommentChildren(payload: Uint8Array, parentId?: string, rootId?: string): CursorPage<CommentNode> {
  const reader = new Read(payload);
  const parent = reader.id();
  const root = reader.id();
  const cursor = reader.id();
  const count = reader.count(100);
  const more = reader.flag();
  reader.zeros(3);
  const items = Array.from({ length: count }, () => node(reader));
  footer(reader, cursor, count, more);
  check(parent !== null && (parentId === undefined || parent === parentId) &&
    (rootId === undefined || root === null || root === rootId) &&
    (cursor === null || cursor === items.at(-1)?.id) &&
    items.every(child => child.parentId === parent && child.rootId === root), 'child scope');
  check(items.every((item, index) => index === 0 || BigInt(item.id) > BigInt(items[index - 1].id)), 'children order');
  return { items, cursor };
}

export type CommentContext = { ancestors: CommentNode[]; target: CommentNode; siblings: CommentNode[] };

export function decodeCommentContext(payload: Uint8Array): CommentContext | null {
  const reader = new Read(payload);
  const id = reader.id();
  const root = reader.id();
  const count = reader.count(256);
  const siblingCount = reader.count(20);
  const unavailable = reader.flag();
  const hasTarget = reader.flag();
  const hasPrevious = reader.flag();
  const hasNext = reader.flag();
  reader.zeros(4);
  if (unavailable) {
    check(id === null && root === null && count === 0 && siblingCount === 0 &&
      !hasTarget && !hasPrevious && !hasNext, 'unavailable context');
    reader.end();
    return null;
  }
  check(hasTarget, 'missing target');
  const ancestors = Array.from({ length: count }, () => node(reader));
  const target = node(reader);
  const siblings = Array.from({ length: siblingCount }, () => node(reader));
  reader.end();
  check(target.id === id && !target.deleted && [...ancestors, target].every((entry, index) =>
    entry.depth === index && entry.rootId === root && entry.parentId === (ancestors[index - 1]?.id ?? null)) &&
    siblings.every(item => item.id !== id && item.parentId === target.parentId && item.depth === target.depth &&
      (target.parentId === null || item.rootId === root)),
  'permalink ancestry');
  return { ancestors, target, siblings };
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
