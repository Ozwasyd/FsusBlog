#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkerTestSession } from '../support/test-session.mjs';
import { resolveSessionFixtureDirectory } from '../support/fixture-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const clientRoot = path.join(repoRoot, 'src', 'frontend');
const fixtureScriptRoot = path.join(repoRoot, 'tests', 'frontend', 'fixtures');
const backendBaseUrl = process.env.FSUSBLOG_BASE_URL
  || process.env.FSUSBLOG_DEBUG_BACKEND_URL
  || '';
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER
  || process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME
  || '';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER
  || process.env.FSUSBLOG_REDIS_CONTAINER_NAME
  || '';

function parseWorkers() {
  const flagIndex = process.argv.indexOf('--workers');
  const raw = flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env.FSUSBLOG_PLAYWRIGHT_WORKERS;
  const parsed = Number(raw || '4');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4;
}

function parseConcurrency(workers) {
  const flagIndex = process.argv.indexOf('--concurrency');
  const raw = flagIndex >= 0
    ? process.argv[flagIndex + 1]
    : process.env.FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY;
  if (raw === undefined || String(raw).trim() === '') return workers;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Playwright session prep concurrency must be a positive integer, got ${raw}`);
  }
  return Math.min(workers, parsed);
}

async function runWithConcurrency(items, concurrency, action) {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await action(items[index]);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(items.length, concurrency) },
    () => worker()
  ));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdio = options.stdio || 'pipe';
    const child = spawn(command, args, {
      cwd: clientRoot,
      env: options.env || process.env,
      stdio
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(stderr || stdout || `${command} failed (${signal || `exit ${code}`})`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function assertSafeFixtureContainer(container, label) {
  if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(container)) {
    throw new Error(`${label} must name a dev/test/ci fixture container.`);
  }
}

function assertActiveNamespaceUrl(value, label) {
  if (!/^https?:\/\/[^/]+/u.test(value)) {
    throw new Error(`${label} must name the active namespace HTTP origin.`);
  }
}

async function runPsql(sql) {
  assertSafeFixtureContainer(pgContainer, 'FSUSBLOG_PG_CONTAINER');
  return run('docker', [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    pgUser,
    '-d',
    pgDb,
    '-c',
    sql
  ]);
}

async function runRedis(args) {
  assertSafeFixtureContainer(redisContainer, 'FSUSBLOG_REDIS_CONTAINER');
  return run('docker', [
    'exec',
    '-i',
    redisContainer,
    'redis-cli',
    ...args
  ]);
}

function schemaForSession(session) {
  return `fsus_e2e_${session.replaceAll('-', '_')}`;
}

async function clonePublicSchema(session) {
  const schema = schemaForSession(session);
  const sql = `
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
CREATE SCHEMA "${schema}";
DO $$
DECLARE
  table_row record;
BEGIN
  FOR table_row IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  LOOP
    EXECUTE format('CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)', '${schema}', table_row.tablename, table_row.tablename);
    EXECUTE format('INSERT INTO %I.%I SELECT * FROM public.%I', '${schema}', table_row.tablename, table_row.tablename);
  END LOOP;
END $$;
`;

  await runPsql(sql);
}

async function cleanupRedis(session) {
  const pattern = `e2e:${session}:*`;
  const keys = (await runRedis(['--scan', '--pattern', pattern]))
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (keys.length > 0) {
    await runRedis(['DEL', ...keys]);
  }
}

async function runNodeScript(script, env) {
  await run(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
}

function encodeValue(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64url');
}

function formatSessionManifest(sessions) {
  return [
    `generatedAt\t${encodeValue(new Date().toISOString())}`,
    ...sessions.map((session, index) => `session.${index}\t${encodeValue(session)}`)
  ].join('\n') + '\n';
}

async function main() {
  assertActiveNamespaceUrl(backendBaseUrl, 'FSUSBLOG_BASE_URL or FSUSBLOG_DEBUG_BACKEND_URL');
  const workers = parseWorkers();
  const sessionPrepConcurrency = parseConcurrency(workers);
  const sessions = Array.from({ length: workers }, (_, index) => resolveWorkerTestSession(index));
  const fixturesDir = resolveSessionFixtureDirectory();
  await mkdir(fixturesDir, { recursive: true });

  await runWithConcurrency(sessions, sessionPrepConcurrency, async (session) => {
    console.log(`[prepare-playwright-sessions] preparing ${session}`);
    await Promise.all([
      clonePublicSchema(session),
      cleanupRedis(session)
    ]);

    const fixtureFile = path.join(fixturesDir, `${session}.aeds`);
    const env = {
      FSUSBLOG_BASE_URL: backendBaseUrl,
      FSUSBLOG_PG_CONTAINER: pgContainer,
      FSUSBLOG_REDIS_CONTAINER: redisContainer,
      FSUSBLOG_TEST_SESSION: session,
      FSUSBLOG_TEST_SESSION_ISOLATION: '1',
      // A fixture login deliberately revokes every other active session for
      // the same identity. Give each parallel worker its own identities as well
      // as its own device key, otherwise later workers invalidate earlier
      // storage states and user-profile routes emit real 401 warnings.
      FSUSBLOG_USER_USERNAME: `binaryuser-${session}`,
      FSUSBLOG_ADMIN_USERNAME: `binaryadmin-${session}`,
      FSUSBLOG_DEVICE_FP: `${session}-playwright`,
      FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE: fixtureFile
    };

    await runNodeScript(path.join(fixtureScriptRoot, 'prepare-auth-smoke-users.mjs'), env);
    await runNodeScript(path.join(fixtureScriptRoot, 'discover-playwright-fixtures.mjs'), env);
  });

  await writeFile(
    path.join(fixturesDir, 'sessions.aeds'),
    formatSessionManifest(sessions),
    'utf8'
  );
  console.log(
    `[prepare-playwright-sessions] prepared ${sessions.length} sessions concurrency=${sessionPrepConcurrency}`
  );
}

main().catch((error) => {
  console.error('[prepare-playwright-sessions] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
