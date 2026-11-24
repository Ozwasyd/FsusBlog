import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeArticleBodyEditsCommand, decodeDraftRevisionBodyEditChain, encodeArticleBodyEditsCommand } from '../../src/Contracts/article-body-edits.ts';
import { decodeArticleBodyInsertionsCommand, decodeDraftRevisionBodyInsertionChain, encodeArticleBodyInsertionsCommand } from '../../src/Contracts/article-body-insertion.ts';
import { decodeArticleSummary, encodeArticleSummaryCommand } from '../../src/Contracts/article-summary.ts';
import { FrameType, WireLimits } from '../../src/Contracts/wire.generated.ts';
import { parseDraftMarkdown, readDraftMarkdownFile } from '../../src/Web/src/authoring/draftMarkdownImport.ts';
import { appendByte, hexBytes, i32, i64, rejectInputs, rejectWrongLength, sha256Hex, text, withByte, withI64 } from './fixture-source.ts';

const editKey = '11111111-1111-4111-8111-111111111111';

test('body edit commands encode exact deletion and replacement without changing insertion frames', () => {
  const edits = [{ offset: 0, removedLength: 4, insert: '' }, { offset: 1, removedLength: 5, insert: 'tail' }];
  const input = { id: 17, expectedRevision: 11n, idempotencyKey: editKey, title: 'One', body: 'Xtail', edits };
  const bytes = hexBytes(
    '110000000b0000000000000011111111111141118111111111111111030000004f6e6505000000587461696c' +
    '020000000000000004000000000000000100000005000000040000007461696c',
  );
  const frame = encodeArticleBodyEditsCommand(input);
  assert.equal(FrameType.ArticleBodyEditsCommand, 33042);
  assert.deepEqual(Buffer.from(decodeFrame(frame, FrameType.ArticleBodyEditsCommand).payload), bytes);
  assert.deepEqual(decodeArticleBodyEditsCommand(bytes), input);
  assert.throws(() => decodeFrame(frame, FrameType.ArticleBodyInsertionsCommand), ProtocolError);
  assert.throws(() => decodeArticleBodyEditsCommand(bytes.subarray(0, -1)), ProtocolError);
  const padding = '北'.repeat(Math.floor(WireLimits.BodyBytes / 5));
  rejectInputs(invalid => encodeArticleBodyEditsCommand({ ...input, edits: invalid }), [
    [{ offset: 0, removedLength: 0, insert: '' }],
    [{ offset: 0, removedLength: 4, insert: '\0' }],
    [{ ...edits[0], offset: 99 }, edits[1]],
    [{ offset: 0, removedLength: 0, insert: padding }, { offset: 0, removedLength: padding.length, insert: padding },
      { offset: 0, removedLength: padding.length, insert: '' }, ...edits],
  ]);

  const sourceBody = 'dropXother';
  const [from, to] = [sha256Hex(sourceBody), sha256Hex(input.body)];
  const payload = Buffer.concat([i32(17), i64(13n), i64(11n), Uint8Array.of(1), text(sourceBody), text(input.body), i32(2),
    text(from), text(from), i32(0), text(from), text(to), i32(edits.length),
    ...edits.flatMap(edit => [i32(edit.offset), i32(edit.removedLength), text(edit.insert)]),
  ]);
  assert.equal(FrameType.DraftRevisionBodyEditChain, 33043);
  assert.deepEqual(decodeDraftRevisionBodyEditChain(payload), {
    id: 17, revision: 13n, sourceRevision: 11n, available: true, sourceBody, body: input.body,
    edges: [{ sourceDigest: from, digest: from, edits: [] }, { sourceDigest: from, digest: to, edits }],
  });
  rejectInputs(decodeDraftRevisionBodyEditChain, [payload.subarray(0, -1), withI64(payload, 4, 14n), withByte(payload, 20, 0)]);
});

test('ordered body insertion save and saved insertion chain validate UTF-16 coordinates and contiguous digests', () => {
  const sourceBody = 'A🐈\r\nZ';
  const body = '>' + sourceBody + '.';
  const insertions = [{ offset: 0, length: 1 }, { offset: 7, length: 1 }] as const;
  const command = { id: 17, expectedRevision: 11n, idempotencyKey: editKey, title: 'One', body, insertions };
  const golden = hexBytes(
    '110000000b0000000000000011111111111141118111111111111111030000004f6e650a0000003e41f09f90880d0a5a2e' +
    '0200000000000000010000000700000001000000',
  );
  const frame = encodeArticleBodyInsertionsCommand(command);
  assert.equal(FrameType.ArticleBodyInsertionsCommand, 33037);
  assert.deepEqual(Buffer.from(decodeFrame(frame, FrameType.ArticleBodyInsertionsCommand).payload), golden);
  assert.deepEqual(decodeArticleBodyInsertionsCommand(golden), command);
  assert.throws(() => decodeFrame(frame, FrameType.ArticleBodyInsertionCommand), ProtocolError);
  assert.throws(() => decodeArticleBodyInsertionsCommand(golden.subarray(0, -1)), ProtocolError);
  rejectInputs(invalid => encodeArticleBodyInsertionsCommand({ ...command, insertions: invalid }), [
    [], Array.from({ length: 9 }, () => ({ offset: 0, length: 1 })), [insertions[0], { offset: 8, length: 1 }], [{ offset: 0, length: 0 }],
  ]);

  const identity = { sourceDigest: sha256Hex(sourceBody), digest: sha256Hex(sourceBody), insertions: [] };
  const changed = { sourceDigest: identity.digest, digest: sha256Hex(body), insertions };
  const encode = (edges = [identity, changed], revision = 13n, available = true, from = sourceBody, to = body) =>
    Buffer.concat([i32(17), i64(revision), i64(11n), Uint8Array.of(Number(available)), text(from), text(to), i32(edges.length),
      ...edges.flatMap(edge => [text(edge.sourceDigest), text(edge.digest), i32(edge.insertions.length),
        ...edge.insertions.flatMap(op => [i32(op.offset), i32(op.length)])]),
    ]);
  assert.equal(FrameType.DraftRevisionBodyInsertionChain, 33038);
  assert.deepEqual(decodeDraftRevisionBodyInsertionChain(encode()), {
    id: 17, revision: 13n, sourceRevision: 11n, available: true, sourceBody, body, edges: [identity, changed],
  });
  assert.deepEqual(decodeDraftRevisionBodyInsertionChain(encode([], 40n, false, '', '')).edges, []);
  rejectInputs(decodeDraftRevisionBodyInsertionChain, [
    encode([identity], 13n), encode(Array.from({ length: WireLimits.ArticleBodyInsertionChainEdges + 1 }, () => identity), 20n),
    encode([{ ...identity, digest: changed.digest }, changed]), encode([identity, { ...changed, sourceDigest: changed.digest }]),
    encode([identity, { ...changed, insertions: [] }]), encode([identity, changed], 13n, false),
    encode([], 13n, false, sourceBody, ''), encode().subarray(0, -1), appendByte(encode()),
  ]);
});

test('manual summary save and read preserve exact CAS, clear, and UTF-8 bounds', () => {
  const command = { id: 51, expectedRevision: 7n, idempotencyKey: '00112233-4455-6677-8899-aabbccddeeff', text: '' };
  const payload = decodeFrame(encodeArticleSummaryCommand(command), FrameType.ArticleSummaryCommand).payload;
  assert.equal(Buffer.from(payload).toString('hex'), '33000000070000000000000000112233445566778899aabbccddeeff00000000');
  rejectInputs(t => encodeArticleSummaryCommand({ ...command, text: t }), ['a'.repeat(251), 'bad\0']);

  const summary = '🧭'.repeat(512);
  const readPayload = Buffer.concat([i32(51), i64(7n), text(summary)]);
  assert.deepEqual(decodeArticleSummary(readPayload), { id: 51, revision: 7n, text: summary });
  rejectWrongLength(decodeArticleSummary, readPayload);
});

test('draft markdown import preserves frontmatter exports, rejects broken headers and invalid UTF-8', async () => {
  const header = (title: string, revision = '32') => `---\nfsusFormat: fsusblog-markdown-v2\ntitle: ${title}\nrevision: ${revision}\n---\n`;
  const body = '\uFEFF## 中文\r\n\r\nTwo  \r\n\r\n';
  const file = new File([header('"\u4e2d\u6587 \\"quoted\\"Z"') + body], 'article.md');
  assert.deepEqual(parseDraftMarkdown(await readDraftMarkdownFile(file), 'Unrelated given title'), { title: '中文 "quoted"Z', body });
  assert.deepEqual(parseDraftMarkdown(header('"Title without a body"'), ''), { title: 'Title without a body', body: '' });
  assert.deepEqual(parseDraftMarkdown(header('"\\uFEFFChapter"') + body, ''), { title: '\uFEFFChapter', body });

  const plain = '---\n\n# Heading\r\n title: literal text\r\n';
  assert.deepEqual(parseDraftMarkdown(plain, '  A title  '), { title: 'A title', body: plain });
  assert.deepEqual(parseDraftMarkdown(plain, '\u0085A title\u0085'), { title: 'A title', body: plain });
  assert.throws(() => parseDraftMarkdown(plain, ''), /valid title/);
  assert.throws(() => parseDraftMarkdown(' \n ', 'Title'), /Enter Markdown/);

  for (const source of [
    '---\ntitle: Old format\nfsusMetadataJson: legacy\n---\nBody',
    header('"unterminated') + 'Body', header('"Named too new"', '9223372036854775808') + 'Body',
    header('"Named zero"', '0') + 'Body', header('"Named with BOM"').replace(/^---/, '\uFEFF---') + 'Body',
    header('"Wrong format"').replace('markdown-v2', 'markdown-v3') + 'Body',
  ]) assert.throws(() => parseDraftMarkdown(source, 'Valid explicit title'), /header|exported by FsusBlog/);

  for (const [md, title, pattern] of [
    ['Invalid \0 body', 'Title', /NUL/], ['Invalid \ud800 body', 'Title', /Unicode/],
    [header('"\\ud800"') + 'Body', '', /valid title/], ['text', '字'.repeat(86), /valid title/],
    ['a'.repeat(200_001), 'Title', /size limit/],
  ] as const) assert.throws(() => parseDraftMarkdown(md, title), pattern);
  await assert.rejects(readDraftMarkdownFile(new File([new Uint8Array([0xc3, 0x28])], 'invalid.md')), /UTF-8/);
  await assert.rejects(readDraftMarkdownFile(new File([new Uint8Array(WireLimits.BodyBytes + 2048)], 'oversize.md')), /size limit/);
});
