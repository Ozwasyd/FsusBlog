import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeCommentChildren, decodeCommentContext, decodeCommentRoots } from '../../src/Contracts/comment-read.ts';
import { decodeArticle } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { commentPlans } from './nightly-comment-plans.mjs';
import { HEADERS, HEX64, isSignedDecimal, openNightlyWitness, sha256 } from './nightly-owned-evidence.mjs';

const base = 9007199254740993n;
const rootId = ordinal => String(base + BigInt(ordinal));
const replyId = ordinal => String(base + 500_000n + BigInt(ordinal));
const width = 5, pages = 2_000;
const positive = value => isSignedDecimal(value, false);

const witness = openNightlyWitness('comments', 'comment-oracle.ndjson', 8 * 1024 * 1024, 19_996, {
  maxLineBytes: 1024,
  client: { overflowMessage: 'Oversized AEDS body.', deadlineMessage: 'Fixture business epoch expired.' },
});
const { evidence, directory, oracleBytes, scope, rows, release, run, owner, out, log } = witness;
assert(scope.profile === 'nightly' && scope.rows === 1_000_000 && scope.roots === 500_000 &&
  scope.hotRows === 20_000 && rows.length === 19_995, 'The oracle must verify the full seeded corpus and stored hot graph.');
assert(isSignedDecimal(scope.taxonomyEpoch) && positive(scope.publication) && scope.revision === '3');
assert.match(run.get('run_id'), /^[0-9a-f]{32}$/);
assert.equal(scope.databaseName, 'fsusv2_nightly_' + run.get('run_id'));
assert.equal(scope.databaseName, run.get('database'));
assert.equal(scope.siteId, run.get('site'));

const checkOwner = () => witness.checkListener(() => {
  const socket = owner.get('postgres_socket');
  assert.match(socket, /\/fsusv2-nightly\.[\w]+\/socket\/\.s\.PGSQL\.[1-9][0-9]*$/);
  const postgres = lstatSync(socket);
  assert(postgres.isSocket() && postgres.uid === directory.uid && (postgres.mode & 0o077) === 0, 'Missing owned PostgreSQL socket.');
});

const nodes = new Map(), children = new Map(), roots = [];
let previous = 0n;
for (const row of rows) {
  const [id, parent, root, depth, masked, createdAt, contentSha, authorSha] = row;
  assert(row.length === 8 && positive(id) && BigInt(id) > previous && positive(root) &&
    Number.isSafeInteger(createdAt) && createdAt > 0 && typeof masked === 'boolean' &&
    Number.isInteger(depth) && depth >= 0 && depth <= 32 &&
    (depth === 0 ? parent === null && root === id : positive(parent) && nodes.has(parent)) &&
    (masked ? contentSha === null && authorSha === null : HEX64.test(contentSha) && HEX64.test(authorSha)),
  'Invalid independent oracle node.');
  previous = BigInt(id);
  const node = { id, parent, root, depth, masked, createdAt, contentSha, authorSha };
  if (parent === null) roots.push(node);
  else {
    const parentNode = nodes.get(parent);
    assert(parentNode.root === root && parentNode.depth + 1 === depth, 'Invalid oracle ancestry.');
    (children.get(parent) ?? children.set(parent, []).get(parent)).push(node);
  }
  nodes.set(id, node);
}
roots.reverse();
assert.equal(roots.length, pages * width);
roots.forEach((node, index) => assert.equal(node.id, rootId(10_000 - index)));
const descendants = id => children.get(id) ?? [];
assert.deepEqual(roots.filter(root => root.masked).map(root => root.id), [rootId(5), rootId(4), rootId(3)]);
assert.equal(descendants(rootId(1)).length, 480);

const authorShape = (displayName, language) => ({
  mode: 'legacy_server_visible_pseudonymous', displayName, language, badge: '', scope: '',
});
const tombstone = authorShape('已删除评论', 'zh-CN');
const assertVisibleAuthor = (author, authorSha) =>
  assert.deepEqual({ ...author, displayName: sha256(author.displayName) }, authorShape(authorSha, 'en'));

function compareNode(actual, expected, form) {
  const { id, parent, root, depth, masked, createdAt, contentSha, authorSha } = expected;
  const expectedChildren = descendants(id).length;
  const reply = !masked && parent !== null ? nodes.get(parent) : null;
  assert.deepEqual(
    { id: actual.id, parentId: actual.parentId, rootId: actual.rootId, depth: actual.depth, deleted: actual.deleted,
      createdAt: actual.createdAt, edited: actual.edited, childCount: actual.childCount,
      moreChildren: actual.moreChildren, replyToId: actual.replyToId },
    { id, parentId: parent, rootId: root, depth, deleted: masked, createdAt, edited: false,
      childCount: form === 'flat' ? 0 : expectedChildren,
      moreChildren: form === 'root' ? expectedChildren > 3 : form !== 'flat' && expectedChildren > 0,
      replyToId: !reply || reply.masked ? null : reply.id },
    'Wrong comment projection for ' + id);
  if (masked) {
    assert.equal(actual.content, '该回复已删除');
    assert.deepEqual(actual.author, tombstone);
  } else {
    assert.equal(sha256(actual.content), contentSha);
    assertVisibleAuthor(actual.author, authorSha);
  }
  if (reply && !reply.masked) {
    assert(actual.replyToAuthor, 'Missing visible reply author.');
    assertVisibleAuthor(actual.replyToAuthor, reply.authorSha);
  } else assert.deepEqual(actual.replyToAuthor, reply ? tombstone : null);
}

// Frame 8's retired field takes the space used by child count in the current tree node format.
// Validate the flat envelope first, then reuse the production decoder for each shared node/blob layout.
function flatPage(payload, root) {
  const bytes = Buffer.from(payload);
  assert(bytes.length >= 21 && bytes.readBigInt64LE(0).toString() === root);
  const next = bytes.readBigInt64LE(8), count = bytes.readInt32LE(17);
  assert(count >= 0 && count <= width && next >= 0n && bytes[16] === Number(next > 0n));
  const rows = [];
  let offset = 21;
  for (let index = 0; index < count; index++) {
    assert(offset + 64 <= bytes.length);
    const blob = bytes.readInt32LE(offset + 60);
    assert(blob >= 0 && offset + 64 + blob <= bytes.length && bytes.readInt32LE(offset + 24) === 0 && bytes[offset + 41] === 0);
    const node = bytes.subarray(offset, offset + 64 + blob);
    const normal = Buffer.alloc(32 + node.length);
    node.copy(normal, 0, 8, 24);
    normal.writeInt32LE(1, 24);
    node.copy(normal, 32, 0, 24);
    node.copy(normal, 56, 28, 40);
    node.copy(normal, 72, 40);
    rows.push(decodeCommentChildren(normal, undefined, root).items[0]);
    offset += node.length;
  }
  assert(offset === bytes.length && (next === 0n || next.toString() === rows.at(-1)?.id), 'Invalid flat-thread cursor.');
  return { items: rows, cursor: next === 0n ? null : next.toString() };
}

const collector = commentPlans({ directory: evidence, runId: run.get('run_id'), database: scope.databaseName, socket: owner.get('postgres_socket'), output: out });
const rootChain = createHash('sha256');
const traces = new Set();
let active, generation, count = 0;
const pathFor = (route, article, field, id) => {
  const path = route.replace('{articleId:int}', String(article));
  return field ? path.replace(field, id) : path;
};
const pageQuery = incoming => '?limit=' + width + (incoming ? '&cursor=' + encodeURIComponent(incoming) : '');
const remaining = () => Number(scope.dueUnixMs) - Date.now();

async function observe(caseId, path, type, verify, retain = true, incoming = null) {
  active = { caseId, path, incoming };
  const targetCase = caseId.startsWith('comment-nested-') ? 'comment-nested-root-expansion' :
    caseId.startsWith('comment-root-') && caseId !== 'comment-root-prefix' ? caseId : null;
  const event = { kind: 'request', number: ++count, caseId, targetCase, path, incoming, frame: type, method: 'GET' };
  let body, planWindow;
  try {
    assert(remaining() > 0, 'Fixture business epoch expired.');
    if (caseId === targetCase) planWindow = await collector.begin(event);
    const response = await witness.fetch(path, Math.min(15_000, remaining()));
    const { headers } = response;
    body = response.body;
    Object.assign(event, response.summary, {
      responseGeneration: headers[HEADERS.generation] ?? null, bodySha256: sha256(body),
    });
    witness.verifyResponse(response, 200);
    assert(typeof event.traceId === 'string' && event.traceId.length > 0 && !traces.has(event.traceId), 'Missing unique HTTP trace ID.');
    traces.add(event.traceId);
    if (generation && event.responseGeneration !== null) assert.equal(event.responseGeneration, generation);
    Object.assign(event, verify(decodeFrame(body, type).payload, event));
    return event;
  } catch (error) {
    event.error = error.message;
    throw error;
  } finally {
    let evidenceError;
    if (planWindow) {
      try { event.sql = await collector.finish(planWindow, event); }
      catch (error) {
        event.sql = { verified: false, error: error.message };
        evidenceError = error;
      }
    }
    if (body && (retain || event.error || evidenceError)) {
      event.rawFile = String(event.number).padStart(4, '0') + '-' + caseId + '.aeds';
      witness.save(event.rawFile, body);
    }
    log.write(event);
    if (evidenceError && !event.error) throw evidenceError;
  }
}

const anchor = id => observe(id, WireRoutes.PublicArticle.replace('{id}', '1'), FrameType.ArticleDetail, (payload, event) => {
  const article = decodeArticle(payload);
  assert.equal(article.id, 1);
  assert.equal(String(article.publication), scope.publication);
  assert.equal(String(article.revision), scope.revision);
  assert(positive(event.responseGeneration), 'Missing public article generation.');
  generation ??= event.responseGeneration;
  return { publication: scope.publication, revision: scope.revision };
});

const observeChildren = (id, parent, expected, next = null, incoming = null) =>
  observe(id, pathFor(WireRoutes.CommentChildren, 1, '{parentId:long}', parent) + pageQuery(incoming), FrameType.CommentChildCursor, payload => {
    assert.equal(Buffer.from(payload).readBigInt64LE(8).toString(), nodes.get(parent).root);
    const page = decodeCommentChildren(payload, parent, nodes.get(parent).root);
    assert.equal(page.items.length, expected.length);
    assert.equal(page.cursor, next);
    page.items.forEach((node, index) => compareNode(node, expected[index], 'tree'));
    return { ids: page.items.map(node => node.id), outgoing: page.cursor, parent };
  }, true, incoming);

try {
  checkOwner();
  log.write({ kind: 'begin', runId: run.get('run_id'), oracleSha256: sha256(oracleBytes), source: release.fsusblogCommit,
    serverSha256: release.serverSha256, serverPid: owner.get('server_pid'), postgresPid: owner.get('postgres_pid'),
    fixtureSha256: scope.fixtureSha256, readbackSha256: scope.readbackSha256,
    watermark: scope.watermark, taxonomyEpoch: scope.taxonomyEpoch, dueUnixMs: scope.dueUnixMs });
  await anchor('publication-before');
  const cases = new Map([
    [1, ['comment-root-first', null, rootId(9996)]],
    [1000, ['comment-root-middle-cursor', '9007199254745999', rootId(5001)]],
    [2000, ['comment-root-last-cursor', '9007199254740999', null]],
  ]);
  let incoming = null;
  for (let number = 1; number <= pages; number++) {
    const target = cases.get(number);
    const expected = roots.slice((number - 1) * width, number * width);
    const expectedNext = number === pages ? null : expected.at(-1).id;
    if (target) {
      assert.equal(incoming, target[1]);
      assert.equal(expectedNext, target[2]);
    }
    const event = await observe(target?.[0] ?? 'comment-root-prefix',
      pathFor(WireRoutes.CommentRoots, 1) + pageQuery(incoming), FrameType.CommentTreeRootCursor, payload => {
        const page = decodeCommentRoots(payload);
        assert.equal(page.items.length, width);
        assert.equal(page.cursor, expectedNext);
        page.items.forEach(({ node, preview }, index) => {
          compareNode(node, expected[index], 'root');
          const expectedPreview = descendants(node.id).slice(0, 3);
          assert.equal(preview.length, expectedPreview.length);
          preview.forEach((child, ordinal) => compareNode(child, expectedPreview[ordinal], 'tree'));
        });
        return { page: number, outgoing: page.cursor, ids: page.items.map(item => item.node.id),
          previews: page.items.map(item => item.preview.map(child => child.id)) };
      }, Boolean(target), incoming);
    rootChain.update(JSON.stringify([event.page, event.incoming, event.outgoing, event.ids, event.traceId, event.bodySha256]) + '\n');
    incoming = event.outgoing;
  }

  const narrow = rootId(2), wide = rootId(1);
  await observeChildren('comment-nested-root-expansion', narrow, descendants(narrow));

  const thread = Array.from({ length: 32 }, (_, index) => nodes.get(replyId(index + 481)));
  assert(thread.every(Boolean));
  incoming = null;
  for (let at = 0; at < thread.length; at += width) {
    const expected = thread.slice(at, at + width);
    const expectedNext = at + width < thread.length ? expected.at(-1).id : null;
    const event = await observe('comment-nested-thread', pathFor(WireRoutes.CommentThread, 1, '{rootId:long}', narrow) + pageQuery(incoming),
      FrameType.CommentThreadReplyCursor, payload => {
        const page = flatPage(payload, narrow);
        assert.equal(page.cursor, expectedNext);
        assert.equal(page.items.length, expected.length);
        page.items.forEach((node, index) => compareNode(node, expected[index], 'flat'));
        return { outgoing: page.cursor, ids: page.items.map(node => node.id) };
      }, true, incoming);
    incoming = event.outgoing;
  }

  const tail = thread.at(-1);
  await observeChildren('comment-nested-deep-child', tail.parent, [tail]);
  await observeChildren('comment-nested-deep-leaf', tail.id, []);
  await observe('comment-nested-context', pathFor(WireRoutes.CommentContext, 1, '{commentId:long}', tail.id) + '?window=6',
    FrameType.CommentPermalinkContext, payload => {
      const context = decodeCommentContext(payload);
      const ancestors = [nodes.get(narrow), ...thread.slice(0, -1)];
      assert.equal(context.ancestors.length, ancestors.length);
      assert.equal(context.siblings.length, 0);
      assert.deepEqual(Array.from(payload.subarray(24, 28)), [0, 1, 0, 0]);
      context.ancestors.forEach((node, index) => compareNode(node, ancestors[index], 'tree'));
      compareNode(context.target, tail, 'tree');
      return { target: context.target.id, ancestors: context.ancestors.map(node => node.id), siblings: [] };
    });

  const wideChildren = descendants(wide);
  const firstWide = await observeChildren('comment-nested-wide-first', wide, wideChildren.slice(0, width), wideChildren[width - 1].id);
  await observeChildren('comment-nested-wide-next', wide, wideChildren.slice(width, width * 2), wideChildren[width * 2 - 1].id, firstWide.outgoing);

  for (const [label, article] of [['empty', 2], ['unpublished', 80001], ['archived', 90001], ['deleted', 95001]])
    await observe('comment-control-' + label, pathFor(WireRoutes.CommentRoots, article) + pageQuery(null),
      FrameType.CommentTreeRootCursor, payload => {
        assert.deepEqual(decodeCommentRoots(payload), { items: [], cursor: null });
        return { ids: [], outgoing: null };
      });
  await anchor('publication-after');
  checkOwner();
  assert(remaining() > 0, 'Fixture business epoch expired before verification completed.');
  log.write({ kind: 'verification', verified: true, requests: count, roots: roots.length, rootPages: pages,
    rootChainSha256: rootChain.digest('hex'), generationAnchors: generation,
    requestSnapshotIdentity: 'not-collected', sqlPlanAndBindValues: 'native-auto_explain-four-targets',
    sqlParameterOids: 'not-collected', literalExplainReplay: 'not-run',
    sqlEpochRecheck: 'requires-after-oracle' });
} catch (error) {
  log.write({ kind: 'verification', verified: false, requests: count, active, error: error.message });
  throw error;
} finally {
  witness.close();
}
