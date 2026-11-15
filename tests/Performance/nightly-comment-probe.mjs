import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Agent, get } from 'node:http';
import { join } from 'node:path';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeCommentChildren, decodeCommentContext, decodeCommentRoots } from '../../src/Contracts/comment-read.ts';
import { decodeArticle } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireHeader, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { commentPlans } from './nightly-comment-plans.mjs';

const base = 9007199254740993n;
const rootId = ordinal => String(base + BigInt(ordinal));
const replyId = ordinal => String(base + 500_000n + BigInt(ordinal));
const width = 5;
const pages = 2_000;
const binary = 'application/octet-stream';
const traceHeader = WireHeaders.TraceId.toLowerCase();
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase();
const digest = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const positive = value => decimal(value) && value !== '0';

assert.equal(process.argv.length, 3, 'Usage: nightly-comment-probe.mjs OWNED_NIGHTLY_EVIDENCE_DIRECTORY');
const evidence = realpathSync(process.argv[2]);
const directory = lstatSync(evidence);
assert(directory.isDirectory() && directory.uid === process.geteuid() && (directory.mode & 0o077) === 0,
  'Expected the private directory of this nightly run.');

function read(name, limit = 1_048_576) {
  const path = join(evidence, name);
  const info = lstatSync(path);
  assert(info.isFile() && info.uid === directory.uid && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= limit,
    'Invalid owned evidence file: ' + name);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, info.size);
  return bytes;
}

function fields(name, keys) {
  const result = new Map();
  for (const line of utf8.decode(read(name, 32_768)).split('\n')) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (index <= 0 || !keys.includes(key)) continue;
    assert(!result.has(key), 'Duplicate owner field: ' + key);
    result.set(key, line.slice(index + 1));
  }
  return result;
}

const oracleBytes = read('comment-oracle.ndjson', 8 * 1024 * 1024);
const lines = utf8.decode(oracleBytes).split('\n');
assert.equal(lines.pop(), '', 'The oracle must end with a complete NDJSON row.');
const scope = JSON.parse(lines.shift());
assert(scope.version === 1 && scope.verified === true && scope.profile === 'nightly' &&
  scope.rows === 1_000_000 && scope.roots === 500_000 && scope.hotRows === 20_000 && lines.length === 19_995,
  'The oracle must verify the full seeded corpus and stored hot graph.');
assert(positive(scope.watermark) && decimal(scope.taxonomyEpoch) && positive(scope.publication) &&
  scope.revision === '3' && positive(scope.dueUnixMs) && Number.isSafeInteger(Number(scope.dueUnixMs)));
const run = fields('run.txt', ['run_id', 'profile', 'database', 'site', 'due_unix_ms']);
assert.match(run.get('run_id'), /^[0-9a-f]{32}$/);
assert.equal(scope.databaseName, 'fsusv2_nightly_' + run.get('run_id'));
assert.equal(scope.databaseName, run.get('database'));
assert.match(scope.siteId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
assert.equal(scope.siteId, run.get('site'));
assert.equal(run.get('profile'), 'nightly');
assert.equal(run.get('due_unix_ms'), scope.dueUnixMs);
assert.equal(scope.fixtureSha256, sha256(read('plan.json')));
assert.equal(scope.readbackSha256, sha256(read('readback.json')));
assert.equal(scope.readbackSha256, utf8.decode(read('readback.sha256', 128)).trim());

const shortOracle = JSON.parse(utf8.decode(read('http-oracle.json')));
for (const key of ['profile', 'fixtureSha256', 'readbackSha256', 'watermark'])
  assert.equal(scope[key], shortOracle[key], 'The HTTP and comment oracles have different fixture epochs.');
const release = JSON.parse(utf8.decode(read('http-release-binding.json', 4096)));
for (const key of ['fsusblogCommit', 'fsusuiCommit']) assert.match(release[key], /^[0-9a-f]{40}$/);
for (const key of ['payloadManifestSha256', 'serverSha256']) assert.match(release[key], digest);
assert(utf8.decode(read('run.txt', 32_768)).split('\n').includes(release.fsusblogCommit), 'Release differs from the owner run.');

const owner = fields('http-server.txt', ['origin', 'readiness', 'server_exit', 'owner_pid', 'postgres_pid', 'server_pid', 'postgres_socket']);
assert.match(owner.get('origin'), /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
const origin = new URL(owner.get('origin'));
assert(origin.origin === owner.get('origin') && Number(origin.port) >= 1024 &&
  owner.get('readiness') === '204' && !owner.has('server_exit'), 'The owned Kestrel listener must still be serving.');

function checkOwner() {
  for (const key of ['owner_pid', 'postgres_pid', 'server_pid']) {
    const pid = Number(owner.get(key));
    assert(Number.isSafeInteger(pid) && pid > 1, 'Missing owned process: ' + key);
    process.kill(pid, 0);
  }
  const socket = owner.get('postgres_socket');
  assert.match(socket, /\/fsusv2-nightly\.[\w]+\/socket\/\.s\.PGSQL\.[1-9][0-9]*$/);
  const postgres = lstatSync(socket);
  assert(postgres.isSocket() && postgres.uid === directory.uid && (postgres.mode & 0o077) === 0, 'Missing owned PostgreSQL socket.');
  execFileSync('lsof', ['-n', '-P', '-a', '-p', owner.get('server_pid'),
    '-iTCP@127.0.0.1:' + origin.port, '-sTCP:LISTEN'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
}

const nodes = new Map();
const children = new Map();
const roots = [];
let previous = 0n;
for (const line of lines) {
  assert(line.length <= 1024, 'Oversized oracle record.');
  const row = JSON.parse(line);
  const [id, parent, root, depth, masked, createdAt, contentSha, authorSha] = row;
  assert(row.length === 8 && positive(id) && BigInt(id) > previous && positive(root) &&
    Number.isSafeInteger(createdAt) && createdAt > 0 && typeof masked === 'boolean' &&
    Number.isInteger(depth) && depth >= 0 && depth <= 32 &&
    (depth === 0 ? parent === null && root === id : positive(parent) && nodes.has(parent)) &&
    (masked ? contentSha === null && authorSha === null : digest.test(contentSha) && digest.test(authorSha)),
  'Invalid independent oracle node.');
  previous = BigInt(id);
  const node = { id, parent, root, depth, masked, createdAt, contentSha, authorSha };
  if (parent === null) roots.push(node);
  else {
    const parentNode = nodes.get(parent);
    assert(parentNode.root === root && parentNode.depth + 1 === depth, 'Invalid oracle ancestry.');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  nodes.set(id, node);
}
roots.reverse();
assert.equal(roots.length, pages * width);
roots.forEach((node, index) => assert.equal(node.id, rootId(10_000 - index)));
const descendants = id => children.get(id) ?? [];
assert.deepEqual(roots.filter(root => root.masked).map(root => root.id), [rootId(5), rootId(4), rootId(3)]);
assert.equal(descendants(rootId(1)).length, 480);

const tombstone = { mode: 'legacy_server_visible_pseudonymous', displayName: '已删除评论', language: 'zh-CN', badge: '', scope: '' };

function compareNode(actual, expected, form) {
  const { id, parent, root, depth, masked, createdAt, contentSha, authorSha } = expected;
  const expectedChildren = descendants(id).length;
  const moreChildren = form === 'root' ? expectedChildren > 3 : form !== 'flat' && expectedChildren > 0;
  const reply = !masked && parent !== null ? nodes.get(parent) : null;
  assert.deepEqual([actual.id, actual.parentId, actual.rootId, actual.depth, actual.deleted, actual.createdAt, actual.edited,
    actual.childCount, actual.moreChildren, actual.replyToId],
  [id, parent, root, depth, masked, createdAt, false, form === 'flat' ? 0 : expectedChildren,
    moreChildren, !reply || reply.masked ? null : reply.id], 'Wrong comment projection for ' + id);
  if (masked) {
    assert.equal(actual.content, '该回复已删除');
    assert.deepEqual(actual.author, tombstone);
  } else {
    assert.equal(sha256(actual.content), contentSha);
    assert.deepEqual([actual.author.mode, sha256(actual.author.displayName), actual.author.language, actual.author.badge, actual.author.scope],
      ['legacy_server_visible_pseudonymous', authorSha, 'en', '', '']);
  }
  if (reply && !reply.masked) {
    assert(actual.replyToAuthor, 'Missing visible reply author.');
    assert.deepEqual([actual.replyToAuthor.mode, sha256(actual.replyToAuthor.displayName), actual.replyToAuthor.language,
      actual.replyToAuthor.badge, actual.replyToAuthor.scope], ['legacy_server_visible_pseudonymous', reply.authorSha, 'en', '', '']);
  } else assert.deepEqual(actual.replyToAuthor, reply ? tombstone : null);
}

// Frame 8's retired field takes the space used by child count in the current tree node format.
// Validate the flat envelope first, then reuse the production decoder for each shared node/blob layout.
function flatPage(payload, root) {
  const bytes = Buffer.from(payload);
  assert(bytes.length >= 21);
  assert.equal(bytes.readBigInt64LE(0).toString(), root);
  const next = bytes.readBigInt64LE(8);
  const count = bytes.readInt32LE(17);
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
  assert.equal(offset, bytes.length);
  assert(next === 0n || next.toString() === rows.at(-1)?.id, 'Invalid flat-thread cursor.');
  return { items: rows, cursor: next === 0n ? null : next.toString() };
}

const out = join(evidence, 'comments');
mkdirSync(out, { mode: 0o700 });
const collector = commentPlans({ directory: evidence, runId: run.get('run_id'), database: scope.databaseName,
  socket: owner.get('postgres_socket'), output: out });
const log = openSync(join(out, 'actual.ndjson'), 'wx', 0o600);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const rootChain = createHash('sha256');
const traces = new Set();
let active, generation, count = 0;
const record = event => writeFileSync(log, JSON.stringify(event) + '\n');
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
  const chunks = [];
  let length = 0;
  let body;
  let planWindow;
  try {
    assert(remaining() > 0, 'Fixture business epoch expired.');
    if (caseId === targetCase) planWindow = await collector.begin(event);
    const start = performance.now();
    let response;
    try {
      response = await new Promise((resolve, reject) => get(new URL(path, origin),
        { agent, signal: AbortSignal.timeout(Math.min(15_000, remaining())), headers: {
          Accept: binary, 'Accept-Encoding': 'identity',
        } }, resolve).once('error', reject));
      for await (const chunk of response) {
        assert(length + chunk.length <= WireHeader.HeaderSize + WireLimits.MaxPayloadBytes, 'Oversized AEDS body.');
        chunks.push(chunk);
        length += chunk.length;
      }
    } finally {
      event.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      Object.assign(event, { status: response?.statusCode ?? null, httpVersion: response?.httpVersion ?? null,
        contentType: response?.headers['content-type'] ?? null, contentLength: response?.headers['content-length'] ?? null,
        cacheControl: response?.headers['cache-control'] ?? null, contentEncoding: response?.headers['content-encoding'] ?? null,
        traceId: response?.headers[traceHeader] ?? null, responseGeneration: response?.headers[generationHeader] ?? null });
      body = Buffer.concat(chunks, length);
      event.bytes = body.length;
      event.bodySha256 = sha256(body);
    }
    assert(response.complete, 'Incomplete HTTP response.');
    assert.equal(event.status, 200);
    assert.equal(event.httpVersion, '1.1');
    assert.equal(response.headers['content-type'], binary);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-encoding'] ?? 'identity', 'identity');
    assert.equal(response.headers['content-length'], String(body.length));
    assert(typeof event.traceId === 'string' && event.traceId.length > 0 && !traces.has(event.traceId), 'Missing unique HTTP trace ID.');
    traces.add(event.traceId);
    if (generation && event.responseGeneration !== null) assert.equal(event.responseGeneration, generation);
    const result = verify(decodeFrame(body, type).payload, event);
    Object.assign(event, result);
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
      writeFileSync(join(out, event.rawFile), body, { flag: 'wx', mode: 0o600 });
    }
    record(event);
    if (evidenceError && !event.error) throw evidenceError;
  }
}

async function anchor(id) {
  await observe(id, WireRoutes.PublicArticle.replace('{id}', '1'), FrameType.ArticleDetail, (payload, event) => {
    const article = decodeArticle(payload);
    assert.equal(article.id, 1);
    assert.equal(String(article.publication), scope.publication);
    assert.equal(String(article.revision), scope.revision);
    assert(positive(event.responseGeneration), 'Missing public article generation.');
    generation ??= event.responseGeneration;
    return { publication: scope.publication, revision: scope.revision };
  });
}

function childPage(payload, parent, expected, next) {
  assert.equal(Buffer.from(payload).readBigInt64LE(8).toString(), nodes.get(parent).root);
  const page = decodeCommentChildren(payload, parent, nodes.get(parent).root);
  assert.equal(page.items.length, expected.length);
  assert.equal(page.cursor, next);
  page.items.forEach((node, index) => compareNode(node, expected[index], 'tree'));
  return { ids: page.items.map(node => node.id), outgoing: page.cursor, parent };
}

try {
  checkOwner();
  record({ kind: 'begin', runId: run.get('run_id'), oracleSha256: sha256(oracleBytes), source: release.fsusblogCommit,
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
    if (target) assert.deepEqual([incoming, expectedNext], target.slice(1));
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

  const narrow = rootId(2);
  const wide = rootId(1);
  const childPath = parent => pathFor(WireRoutes.CommentChildren, 1, '{parentId:long}', parent);
  await observe('comment-nested-root-expansion', childPath(narrow) + pageQuery(null),
    FrameType.CommentChildCursor, payload => childPage(payload, narrow, descendants(narrow), null));

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
  await observe('comment-nested-deep-child', childPath(tail.parent) + pageQuery(null), FrameType.CommentChildCursor,
    payload => childPage(payload, tail.parent, [tail], null));
  await observe('comment-nested-deep-leaf', childPath(tail.id) + pageQuery(null), FrameType.CommentChildCursor,
    payload => childPage(payload, tail.id, [], null));
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
  const firstWide = await observe('comment-nested-wide-first', childPath(wide) + pageQuery(null), FrameType.CommentChildCursor,
    payload => childPage(payload, wide, wideChildren.slice(0, width), wideChildren[width - 1].id));
  await observe('comment-nested-wide-next', childPath(wide) + pageQuery(firstWide.outgoing), FrameType.CommentChildCursor,
    payload => childPage(payload, wide, wideChildren.slice(width, width * 2), wideChildren[width * 2 - 1].id), true, firstWide.outgoing);

  for (const [label, article] of [['empty', 2], ['unpublished', 80001], ['archived', 90001], ['deleted', 95001]])
    await observe('comment-control-' + label, pathFor(WireRoutes.CommentRoots, article) + pageQuery(null),
      FrameType.CommentTreeRootCursor, payload => {
        assert.deepEqual(decodeCommentRoots(payload), { items: [], cursor: null });
        return { ids: [], outgoing: null };
      });
  await anchor('publication-after');
  checkOwner();
  assert(remaining() > 0, 'Fixture business epoch expired before verification completed.');
  record({ kind: 'verification', verified: true, requests: count, roots: roots.length, rootPages: pages,
    rootChainSha256: rootChain.digest('hex'), generationAnchors: generation,
    requestSnapshotIdentity: 'not-collected', sqlPlanAndBindValues: 'native-auto_explain-four-targets',
    sqlParameterOids: 'not-collected', literalExplainReplay: 'not-run',
    sqlEpochRecheck: 'requires-after-oracle' });
} catch (error) {
  record({ kind: 'verification', verified: false, requests: count, active, error: error.message });
  throw error;
} finally {
  agent.destroy();
  closeSync(log);
}
