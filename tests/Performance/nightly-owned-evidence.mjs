import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Agent, get as httpGet } from 'node:http';
import { join } from 'node:path';
import { WireHeader, WireHeaders, WireLimits } from '../../src/Contracts/wire.generated.ts';

export const BINARY = 'application/octet-stream';
export const HEX64 = /^[0-9a-f]{64}$/;
export const CURSOR_TOKEN = /^[A-Za-z0-9_-]{155}$/;
export const UTF8 = new TextDecoder('utf-8', { fatal: true });
export const MAX_AEDS_BYTES = WireHeader.HeaderSize + WireLimits.MaxPayloadBytes;
export const HEADERS = {
  trace: WireHeaders.TraceId.toLowerCase(),
  generation: WireHeaders.SearchIndexGeneration.toLowerCase(),
  pages: WireHeaders.SearchIndexPages.toLowerCase(),
  digest: WireHeaders.SearchCorpusDigest.toLowerCase(),
};
export function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}
export const writePrivate = (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
export const isSignedDecimal = (value, allowZero = true) =>
  typeof value === 'string' &&
  (allowZero ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value) &&
  BigInt(value) <= 9223372036854775807n;

export function assertOwnedFile(path, uid, message = 'Invalid private owned file.') {
  const info = lstatSync(path);
  assert(info.isFile() && info.uid === uid && (info.mode & 0o077) === 0, message);
  return info;
}

export function readBoundedFile(path, maxBytes, message = 'Expected a bounded evidence file', uid, sizeMsg = 'Evidence file size changed') {
  const info = uid === undefined ? lstatSync(path) : assertOwnedFile(path, uid, message);
  assert(info.isFile() && info.size > 0 && info.size <= maxBytes, message);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, info.size, sizeMsg);
  return bytes;
}

export function readBoundedJson(path, maxBytes, message) {
  const bytes = readBoundedFile(path, maxBytes, message);
  return { bytes, data: JSON.parse(UTF8.decode(bytes)) };
}

export function parseLoopbackOrigin(text, protocol = 'http', minPort = 1024, message) {
  assert.match(text, new RegExp(`^${protocol}://127\\.0\\.0\\.1:[1-9][0-9]{0,4}$`), message);
  const origin = new URL(text);
  assert(origin.origin === text && Number(origin.port) >= minPort, message);
  return origin;
}

function parseKeyValues(text, keys) {
  const result = new Map();
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (index <= 0 || (keys && !keys.includes(key))) {
      assert(keys, 'Invalid Kestrel ownership record.');
      continue;
    }
    assert(!result.has(key), 'Duplicate owner field: ' + key);
    result.set(key, line.slice(index + 1));
  }
  return result;
}

export function parseNdjson(bytes, maxRows, maxLineBytes = 16_384) {
  const rows = [];
  for (let start = 0; start < bytes.length; ) {
    const end = bytes.indexOf(10, start);
    assert(end > start && end - start <= maxLineBytes && rows.length < maxRows, 'Invalid bounded NDJSON record.');
    rows.push(JSON.parse(UTF8.decode(bytes.subarray(start, end))));
    start = end + 1;
  }
  return rows;
}

export function openNdjsonLog(path) {
  const fd = openSync(path, 'wx', 0o600);
  return { write: entry => writeFileSync(fd, JSON.stringify(entry) + '\n'), close: () => closeSync(fd) };
}

export function createAedsClient(origin, opts = {}) {
  const { agent = false, maxBytes = MAX_AEDS_BYTES, truncate = false } = opts;
  const overflowMessage = opts.overflowMessage ?? 'AEDS body exceeded the response budget';
  const deadlineMessage = opts.deadlineMessage ?? 'Fixture HTTP deadline reached';
  async function fetch(path, timeoutMs) {
    const started = performance.now();
    const chunks = [];
    let length = 0, response, error = timeoutMs <= 0 ? deadlineMessage : null;
    if (!error) {
      try {
        response = await new Promise((resolve, reject) =>
          httpGet(new URL(path, origin), { agent, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: BINARY, 'Accept-Encoding': 'identity' } }, resolve).once('error', reject));
        for await (const chunk of response) {
          if (length + chunk.length > maxBytes) {
            if (truncate) {
              if (maxBytes > length) chunks.push(chunk.subarray(0, maxBytes - length));
              length = maxBytes;
            }
            response.destroy();
            throw new Error(overflowMessage);
          }
          chunks.push(chunk);
          length += chunk.length;
        }
        assert(response.complete, 'HTTP response was incomplete');
      } catch (caught) {
        error = caught.message;
      }
    }
    const headers = response?.headers ?? {};
    const body = Buffer.concat(chunks, length);
    const summary = {
      status: response?.statusCode ?? null, httpVersion: response?.httpVersion ?? null,
      elapsedMs: timeoutMs <= 0 ? 0 : Math.round((performance.now() - started) * 1000) / 1000,
      bytes: body.length, contentLength: headers['content-length'] ?? null,
      contentType: headers['content-type'] ?? null, cacheControl: headers['cache-control'] ?? null,
      contentEncoding: headers['content-encoding'] ?? null, traceId: headers[HEADERS.trace] ?? null,
    };
    return { ...summary, headers, body, error, summary };
  }

  function verifyResponse(response, expectedStatus, label = '') {
    const tag = suffix => (label ? `${label} ${suffix}` : undefined);
    assert.equal(response.error, null, label ? `${label} transport` : response.error);
    assert.equal(response.status, expectedStatus, tag('HTTP status'));
    assert.equal(response.httpVersion, '1.1', tag('HTTP protocol'));
    assert.equal(response.contentType, BINARY, tag('media type'));
    assert.equal(response.cacheControl, 'no-store', tag('cache policy'));
    assert.equal(response.contentEncoding ?? 'identity', 'identity', tag('content encoding'));
    assert.equal(response.contentLength, String(response.body.length), tag('HTTP content length'));
  }
  return { fetch, verifyResponse };
}

export function openNightlyWitness(outName, oracleFile, oracleLimit, maxRows, opts = {}) {
  assert.equal(process.argv.length, 3, 'Expected OWNED_NIGHTLY_EVIDENCE_DIRECTORY');
  const evidence = realpathSync(process.argv[2]);
  const directory = lstatSync(evidence);
  assert(directory.isDirectory() && directory.uid === process.geteuid() && (directory.mode & 0o077) === 0,
    'Expected the private evidence directory of this nightly run.');
  const read = (name, limit = 1_048_576) =>
    readBoundedFile(join(evidence, name), limit, 'Invalid owned evidence file: ' + name, directory.uid);
  const oracleBytes = read(oracleFile, oracleLimit);
  const [scope, ...rows] = parseNdjson(oracleBytes, maxRows, opts.maxLineBytes);
  assert(scope?.version === 1 && scope.verified === true, 'The oracle must verify the seeded fixture.');
  assert(isSignedDecimal(scope.watermark, false) && isSignedDecimal(scope.dueUnixMs, false) &&
    Number.isSafeInteger(Number(scope.dueUnixMs)), 'Oracle epoch is unavailable.');
  assert.match(scope.siteId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(scope.fixtureSha256, sha256(read('plan.json')));
  assert.equal(scope.readbackSha256, sha256(read('readback.json')));
  assert.equal(scope.readbackSha256, UTF8.decode(read('readback.sha256', 128)).trim());

  const shortOracleBytes = read('http-oracle.json');
  const shortOracle = JSON.parse(UTF8.decode(shortOracleBytes));
  assert.equal(shortOracle.profile, 'nightly');
  for (const key of ['fixtureSha256', 'readbackSha256', 'watermark'])
    assert.equal(scope[key], shortOracle[key], 'The HTTP and witness oracles have different fixture epochs.');

  const release = JSON.parse(UTF8.decode(read('http-release-binding.json', 4096)));
  for (const key of ['fsusblogCommit', 'fsusuiCommit']) assert.match(release[key], /^[0-9a-f]{40}$/);
  for (const key of ['payloadManifestSha256', 'serverSha256', 'migrateSha256']) assert.match(release[key], HEX64);

  const runText = UTF8.decode(read('run.txt', 32_768));
  const runLines = runText.split('\n');
  assert(runLines.includes(release.fsusblogCommit) && runLines.includes('profile=nightly') && runLines.includes('due_unix_ms=' + scope.dueUnixMs),
    'Release, fixture, or business epoch differs from the owner run.');
  const run = parseKeyValues(runText, ['run_id', 'profile', 'database', 'site', 'due_unix_ms']);

  const owner = parseKeyValues(UTF8.decode(read('http-server.txt', 32_768)).trimEnd());
  const origin = parseLoopbackOrigin(owner.get('origin'), 'http', 1024, 'The owned Kestrel listener must still be serving.');
  assert(owner.get('readiness') === '204' && !owner.has('server_exit'), 'The owned Kestrel listener must still be serving.');

  const out = join(evidence, outName);
  mkdirSync(out, { mode: 0o700 });
  const log = openNdjsonLog(join(out, 'actual.ndjson'));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const client = createAedsClient(origin, { ...opts.client, agent });
  function checkListener(checkSocket) {
    for (const key of ['owner_pid', 'postgres_pid', 'server_pid']) {
      const pid = Number(owner.get(key));
      assert(Number.isSafeInteger(pid) && pid > 1, 'Missing owned process: ' + key);
      process.kill(pid, 0);
    }
    checkSocket?.();
    execFileSync('lsof', ['-n', '-P', '-a', '-p', owner.get('server_pid'),
      '-iTCP@127.0.0.1:' + origin.port, '-sTCP:LISTEN'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return {
    evidence, directory, read, oracleBytes, scope, rows, shortOracleBytes, shortOracle, release, run, owner, origin, out, log, ...client,
    checkListener, save: (file, data) => writePrivate(join(out, file), data),
    close: () => { agent.destroy(); log.close(); },
  };
}
