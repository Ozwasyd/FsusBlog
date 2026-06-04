#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  authBinary,
  baseUrl,
  buildPowHeaders,
  fetchChallenge,
  loginWithPow,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import {
  encodeAedsFrame,
  encodeAuthLoginRequest
} from '../../support/aeds-envelope.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const deniedStatuses = new Set([400, 401, 403, 404, 405, 406, 409, 413, 415, 422, 423, 428, 429]);
const FRAME_AUTH_LOGIN_REQUEST = 43;
const FRAME_CATEGORY_WRITE_REQUEST = 33;
const repoRoot = resolve(process.cwd(), '..', '..');
const evidenceDir = process.env.FSUSBLOG_SECURITY_EVIDENCE_DIR || resolve(repoRoot, '.tmp/security');
const execFileAsync = promisify(execFile);
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0';
const maxDeterministicPowDifficulty = Number.parseInt(process.env.FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY ?? '20', 10) || 20;
const internalErrorPattern = /System\.[A-Za-z]+Exception| at FsusBlog\.|StackTrace|SqlSugarException|PostgresException|Npgsql|Failed to bind parameter|syntax error|unterminated quoted string|relation .* does not exist|column .* does not exist/i;
const sqlInjectionPayloads = [
  "' OR '1'='1",
  "admin'--",
  "x';SELECT 1--"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function resetLocalPowRiskState() {
  if (!resetSecurityTestState) {
    return;
  }

  try {
    await execFileAsync('docker', [
      'exec',
      'fsusblog-redis',
      'sh',
      '-c',
      "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
    ], { timeout: 5000 });
  } catch {
    // Non-local environments may not use the developer docker container name.
  }
}

async function waitForDeterministicPow(label) {
  let lastDifficulty = 'unknown';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const challenge = await fetchChallenge(5000);
      const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 999);
      lastDifficulty = Number.isFinite(difficulty) ? String(difficulty) : 'unknown';
      if (difficulty <= maxDeterministicPowDifficulty) {
        return;
      }
    } catch {
      lastDifficulty = 'unreachable';
    }

    await delay(1000);
  }

  throw new Error(`${label} pow difficulty did not settle below ${maxDeterministicPowDifficulty}; last=${lastDifficulty}`);
}

async function resetAndWaitForPow(label) {
  await resetLocalPowRiskState();
  await waitForDeterministicPow(label);
}

async function withFreshPowBudget(label, action) {
  await resetAndWaitForPow(label);
  return await action();
}

async function writeEvidence(status, error = null) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, 'attack-matrix.json'), `${JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    baseUrl,
    checks: [
      'pow-required',
      'pow-tamper-denied',
      'binary-content-type-denied',
      'forged-cookie-denied',
      'csrf-origin-denied',
      'method-override-denied',
      'path-traversal-denied',
      'oversized-binary-denied',
      'sql-injection-defended',
      'attack-marker-not-persisted'
    ],
    error: error ? String(error instanceof Error ? error.message : error) : null
  }, null, 2)}\n`);
}

function assertNoServerError(name, response) {
  assert(response.status < 500, `${name} must not return 5xx, got ${response.status}`);
}

function assertDenied(name, response) {
  assertNoServerError(name, response);
  assert(!response.ok, `${name} must not return 2xx, got ${response.status}`);
  assert(deniedStatuses.has(response.status), `${name} returned unexpected denial status ${response.status}`);
}

function assertNoInternalErrorText(name, body) {
  assert(!internalErrorPattern.test(body), `${name} leaked internal error text`);
}

function payloadContains(value, needle) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).includes(needle);
  if (Array.isArray(value)) return value.some((item) => payloadContains(item, needle));
  if (typeof value === 'object') return Object.values(value).some((item) => payloadContains(item, needle));
  return false;
}

async function assertRawDenied(name, path, init) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, init, requestTimeoutMs);
  assertDenied(name, response);
  const body = Buffer.from(await response.arrayBuffer()).toString('utf8');
  assertNoInternalErrorText(name, body);
  return response;
}

function assertBinaryNoServerError(name, result) {
  assertNoServerError(name, result.response);
  assertNoInternalErrorText(name, JSON.stringify(result.payload ?? ''));
}

async function assertSqlInjectionProbeRejectedByLogin(name, payload) {
  const result = await withFreshPowBudget(name, async () =>
    await authBinary('/api/Auth/login', {
      method: 'POST',
      deviceFingerprint: name,
      body: {
        username: payload,
        password: userPassword,
        rememberMe: false
      },
      requiresPow: true
    })
  );

  assertDenied(name, result.response);
  assertNoInternalErrorText(name, JSON.stringify(result.payload ?? ''));
}

async function assertSqlInjectionProbeSafeForAdminKeyword(name, adminSession, payload) {
  const result = await authBinary(`/api/admin/users?page=1&pageSize=10&keyword=${encodeURIComponent(payload)}`, {
    method: 'GET',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: name
  });

  assert(result.response.ok, `${name} must remain a valid parameterized admin query, got ${result.response.status}`);
  assertBinaryNoServerError(name, result);
}

async function assertSqlInjectionProbeSafeForNumericBoundaries(name, payload) {
  const encoded = encodeURIComponent(payload);
  const probes = [
    [`${name} article categoryId`, `/api/binary/article/list/category/${encoded}/1/5.aeds`],
    [`${name} article tagId`, `/api/binary/article/list/tag/${encoded}/1/5.aeds`]
  ];

  for (const [probeName, path] of probes) {
    await assertRawDenied(probeName, path, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream'
      }
    });
  }

  await assertRawDenied(`${name} article id route`, `/api/binary/article/${encoded}.aeds`, {
    method: 'GET',
    headers: {
      Accept: 'application/octet-stream'
    }
  });

  await assertRawDenied(`${name} comment article route`, `/api/binary/comment/${encoded}?limit=5`, {
    method: 'GET',
    headers: {
      Accept: 'application/octet-stream'
    }
  });
}

async function assertSqlInjectionDefenses(adminSession) {
  for (let i = 0; i < sqlInjectionPayloads.length; i += 1) {
    await assertSqlInjectionProbeRejectedByLogin(`sql injection probe ${i + 1} login`, sqlInjectionPayloads[i]);
  }

  for (let i = 0; i < sqlInjectionPayloads.length; i += 1) {
    await assertSqlInjectionProbeSafeForAdminKeyword(`sql injection probe ${i + 1} admin keyword`, adminSession, sqlInjectionPayloads[i]);
  }

  for (let i = 0; i < sqlInjectionPayloads.length; i += 1) {
    const payload = sqlInjectionPayloads[i];
    const name = `sql injection probe ${i + 1}`;
    await assertSqlInjectionProbeSafeForNumericBoundaries(name, payload);
  }
}

async function assertMarkerAbsent(adminSession, marker) {
  const categories = await withFreshPowBudget('attack marker category probe pow', async () =>
    await authBinary('/api/Category', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'attack-marker-category-probe',
      requiresPow: true
    })
  );
  const tags = await withFreshPowBudget('attack marker tag probe pow', async () =>
    await authBinary('/api/Tag', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'attack-marker-tag-probe',
      requiresPow: true
    })
  );

  assert(categories.response.ok, `category marker probe failed: ${categories.response.status}`);
  assert(tags.response.ok, `tag marker probe failed: ${tags.response.status}`);
  assert(!payloadContains(categories.payload, marker), `category marker persisted after denied attack: ${marker}`);
  assert(!payloadContains(tags.payload, marker), `tag marker persisted after denied attack: ${marker}`);
}

async function main() {
  const marker = `sec-attack-${Date.now()}`;

  await resetAndWaitForPow('attack matrix start');

  await assertRawDenied('login without PoW', '/api/binary/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Device-Fp': 'attack-no-pow'
    },
    body: encodeAedsFrame(FRAME_AUTH_LOGIN_REQUEST, encodeAuthLoginRequest({
      username: userName,
      password: userPassword,
      rememberMe: false
    }))
  });

  await resetAndWaitForPow('attack matrix tampered pow');

  const tamperedPowHeaders = await buildPowHeaders('attack-tampered-pow', requestTimeoutMs);
  tamperedPowHeaders['X-Fsus-Pow-Proof'] = `${tamperedPowHeaders['X-Fsus-Pow-Proof'].slice(0, -4)}AAAA`;
  await assertRawDenied('login with tampered PoW', '/api/binary/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      ...tamperedPowHeaders
    },
    body: encodeAedsFrame(FRAME_AUTH_LOGIN_REQUEST, encodeAuthLoginRequest({
      username: userName,
      password: userPassword,
      rememberMe: false
    }))
  });

  await resetAndWaitForPow('attack matrix content-type probe');

  await assertRawDenied('binary mutation with text content-type', '/api/binary/category', {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'text/plain',
      'X-Fsus-Device-Fp': 'attack-content-type'
    },
    body: marker
  });

  const forgedCookie = await authBinary('/api/Auth/me', {
    method: 'GET',
    cookieHeader: '__Host-AccessToken=not-a-valid-jwt; __Host-RefreshToken=not-a-refresh-token',
    deviceFingerprint: 'attack-forged-cookie'
  });
  assertDenied('forged auth cookies', forgedCookie.response);

  await resetAndWaitForPow('attack matrix positive sessions');

  const userSession = await withFreshPowBudget('attack matrix user login pow', async () =>
    await loginWithPow(userName, userPassword, false, 'attack-user', requestTimeoutMs)
  );
  const adminSession = await withFreshPowBudget('attack matrix admin login pow', async () =>
    await loginWithPow(adminName, adminPassword, false, 'attack-admin', requestTimeoutMs)
  );

  const csrfCategory = await withFreshPowBudget('attack matrix csrf pow', async () =>
    await authBinary('/api/Category', {
      method: 'POST',
      cookieHeader: userSession.cookieHeader,
      deviceFingerprint: 'attack-csrf-category',
      headers: {
        Origin: 'https://attacker.invalid',
        Referer: 'https://attacker.invalid/form'
      },
      body: { name: `${marker}-csrf` },
      requiresPow: true
    })
  );
  assertDenied('role=user cross-origin category mutation', csrfCategory.response);

  const methodOverride = await withFreshPowBudget('attack matrix method override pow', async () =>
    await authBinary('/api/Category', {
      method: 'POST',
      cookieHeader: userSession.cookieHeader,
      deviceFingerprint: 'attack-method-override',
      headers: {
        'X-HTTP-Method-Override': 'DELETE'
      },
      body: { name: `${marker}-override` },
      requiresPow: true
    })
  );
  assertDenied('role=user method override mutation', methodOverride.response);

  await assertRawDenied('encoded traversal path', '/api/%252e%252e/appsettings.Production.json', {
    method: 'GET',
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'Mozilla/5.0 (FsusBlog Attack Matrix)'
    }
  });

  await assertRawDenied('oversized binary mutation payload without auth', '/api/binary/category', {
    method: 'POST',
    headers: {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Device-Fp': 'attack-oversized'
    },
    body: encodeAedsFrame(FRAME_CATEGORY_WRITE_REQUEST, new Uint8Array(70_000))
  });

  await resetAndWaitForPow('attack matrix marker probe');
  await assertMarkerAbsent(adminSession, marker);

  await resetAndWaitForPow('attack matrix sql probes');
  await assertSqlInjectionDefenses(adminSession);

  await writeEvidence('ok');
  console.log(`[check-security-attack-matrix] ok | base=${baseUrl}`);
}

main().catch((error) => {
  writeEvidence('failed', error).catch((writeError) => {
    console.error('[check-security-attack-matrix] evidence write failed:', writeError instanceof Error ? writeError.message : String(writeError));
  }).finally(() => {
    console.error('[check-security-attack-matrix] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
});
