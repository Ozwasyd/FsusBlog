#!/usr/bin/env node
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';
import { decodeBinaryEnvelope } from '../../support/aeds-envelope.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
const userToken = process.env.FSUSBLOG_USER_TOKEN || '';
const adminToken = process.env.FSUSBLOG_ADMIN_TOKEN || '';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);

const checks = [
  { name: 'article_list', path: '/api/binary/article?page=1&size=5', expect: 'binary' },
  { name: 'article_hot', path: '/api/binary/article/hot?size=5', expect: 'binary' },
  { name: 'search_index', path: '/search/index.bin', expect: 'binary' },
  { name: 'comment_article', path: '/api/binary/comment/1?limit=10', expect: 'binary_or_json_error' },
  { name: 'comment_me_unauthorized', path: '/api/binary/comment/me?limit=10', expect: 'json_error', status: 401 },
  { name: 'stats_unauthorized', path: '/api/binary/stats', expect: 'json_error', status: 401 }
];

if (userToken) {
  checks.push({
    name: 'comment_me_authorized',
    path: '/api/binary/comment/me?limit=10',
    expect: 'binary',
    authToken: userToken
  });
}

if (adminToken) {
  checks.push({
    name: 'stats_authorized_admin',
    path: '/api/binary/stats',
    expect: 'binary',
    authToken: adminToken
  });
}

const reachabilityProbe = '/api/Article?page=1&size=1';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCheck(item) {
  const url = `${baseUrl}${item.path}`;
  const headers = {
    Accept: 'application/octet-stream'
  };
  if (item.authToken) {
    headers.Authorization = `Bearer ${item.authToken}`;
  }

  const response = await fetchWithTimeout(url, {
    headers
  }, requestTimeoutMs);
  const contentType = response.headers.get('content-type') || '';

  if (item.expect === 'binary') {
    assert(response.ok, `[${item.name}] expected 2xx, got ${response.status}`);
    assert(contentType.includes('application/octet-stream'), `[${item.name}] expected octet-stream, got ${contentType || 'none'}`);
    return;
  }

  if (item.expect === 'json_error') {
    assert(!response.ok, `[${item.name}] expected non-2xx, got ${response.status}`);
    if (contentType.includes('application/octet-stream')) {
      const envelope = decodeBinaryEnvelope(await response.arrayBuffer());
      assert(envelope.statusCode === response.status, `[${item.name}] binary envelope status mismatch: ${envelope.statusCode} vs ${response.status}`);
      assert(
        envelope.contentType.includes('application/json'),
        `[${item.name}] binary error envelope should carry json body, got ${envelope.contentType || 'none'}`
      );
    } else {
      assert(contentType.includes('application/json'), `[${item.name}] expected json error content-type, got ${contentType || 'none'}`);
    }
    if (typeof item.status === 'number') {
      assert(response.status === item.status, `[${item.name}] expected status ${item.status}, got ${response.status}`);
    }
    return;
  }

  if (response.ok) {
    assert(contentType.includes('application/octet-stream'), `[${item.name}] success path must be octet-stream, got ${contentType || 'none'}`);
    return;
  }

  assert(contentType.includes('application/json'), `[${item.name}] error path must be json, got ${contentType || 'none'}`);
}

async function ensureServerReachable() {
  try {
    const response = await fetchWithTimeout(`${baseUrl}${reachabilityProbe}`, {}, requestTimeoutMs);
    if (response.status >= 500) {
      throw new Error(`server responded ${response.status}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const tip = [
      `cannot reach backend at ${baseUrl}`,
      'ensure FsusBlog.Server is running and Redis connection string is configured',
      'example: ConnectionStrings__Redis=127.0.0.1:6379 dotnet run --project FsusBlog.Server/FsusBlog.Server.csproj -c Release'
    ].join(' | ');
    throw new Error(`${tip} | reason: ${reason}`);
  }
}

async function main() {
  await probeReachable(`${baseUrl}${reachabilityProbe}`, '[binary-smoke backend]', requestTimeoutMs);
  await ensureServerReachable();

  const failures = [];
  for (const item of checks) {
    try {
      await runCheck(item);
      console.log(`[binary-smoke] ok: ${item.name}`);
    } catch (error) {
      failures.push(`[binary-smoke] fail: ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    for (const line of failures) {
      console.error(line);
    }
    process.exit(1);
  }

  console.log('[binary-smoke] all checks passed');
}

main().catch((error) => {
  console.error('[binary-smoke] fatal:', error);
  process.exit(1);
});
