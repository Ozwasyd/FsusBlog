import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { framedFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeCommentChildren, decodeCommentContext, decodeCommentRoots } from '../../src/Contracts/comment-read.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

function fixture(name: string, type: FrameType): Uint8Array {
  return framedFixture(`comment-${name}-current.hex`, type);
}

test('independent comment vectors preserve 64-bit nodes, author views and recursive coordinates', () => {
  const roots = decodeCommentRoots(fixture('root', FrameType.CommentTreeRootCursor));
  const children = decodeCommentChildren(fixture('children', FrameType.CommentChildCursor), '9007199254740993', '9007199254740993');
  const path = decodeCommentContext(fixture('context', FrameType.CommentPermalinkContext));
  equal(roots.cursor, null);
  equal(roots.items[0].node.id, '9007199254740993');
  equal(roots.items[0].node.edited, true);
  equal(children.items[0].id, '9007199254740994');
  equal(children.items[0].content, 'Visible reply 独立');
  equal(children.items[0].replyToAuthor?.displayName, 'Writer');
  equal(children.items[0].author.scope, 'some scope');
  deepStrictEqual(roots.items[0].preview, children.items);
  deepStrictEqual(path?.ancestors, [roots.items[0].node]);
  deepStrictEqual(path?.target, children.items[0]);
});

test('comment readers reject truncated children, a wrong parent and inconsistent unavailable context', () => {
  const children = fixture('children', FrameType.CommentChildCursor);
  throws(() => decodeCommentChildren(children, '9007199254740994'), ProtocolError);
  throws(() => decodeCommentChildren(children.subarray(0, -1)), ProtocolError);
  const context = fixture('context', FrameType.CommentPermalinkContext);
  context[24] = 1;
  throws(() => decodeCommentContext(context), ProtocolError);
  const unavailable = new Uint8Array(32);
  unavailable[24] = 1;
  equal(decodeCommentContext(unavailable), null);
});
