#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTestSession } from '../support/test-session.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const clientRoot = path.join(repoRoot, 'src', 'frontend');
const fixtureScriptRoot = path.join(repoRoot, 'tests', 'frontend', 'fixtures');
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || '';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || 'fsusblog-redis';

function parseWorkers() {
  const flagIndex = process.argv.indexOf('--workers');
  const raw = flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env.FSUSBLOG_PLAYWRIGHT_WORKERS;
  const parsed = Number(raw || '4');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: clientRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }

  return result.stdout.trim();
}

function assertSafeFixtureContainer(container, label) {
  if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(container)) {
    throw new Error(`${label} must name a dev/test/ci fixture container.`);
  }
}

function runPsql(sql) {
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

function runRedis(args) {
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

function clonePublicSchema(session) {
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

  runPsql(sql);
}

function cleanupRedis(session) {
  const pattern = `e2e:${session}:*`;
  const keys = runRedis(['--scan', '--pattern', pattern])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (keys.length > 0) {
    runRedis(['DEL', ...keys]);
  }
}

function runNodeScript(script, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: clientRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} failed with exit ${result.status}`);
  }
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
  const workers = parseWorkers();
  const sessions = Array.from({ length: workers }, (_, index) => sanitizeTestSession(`pw-${index}`));
  const fixturesDir = path.join(clientRoot, '.playwright-fixtures');
  await mkdir(fixturesDir, { recursive: true });

  for (const session of sessions) {
    console.log(`[prepare-playwright-sessions] preparing ${session}`);
    clonePublicSchema(session);
    cleanupRedis(session);

    const fixtureFile = path.join(fixturesDir, `${session}.aeds`);
    const env = {
      FSUSBLOG_TEST_SESSION: session,
      FSUSBLOG_TEST_SESSION_ISOLATION: '1',
      FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE: fixtureFile
    };

    runNodeScript(path.join(fixtureScriptRoot, 'prepare-auth-smoke-users.mjs'), env);
    runNodeScript(path.join(fixtureScriptRoot, 'discover-playwright-fixtures.mjs'), env);
  }

  await writeFile(
    path.join(fixturesDir, 'sessions.aeds'),
    formatSessionManifest(sessions),
    'utf8'
  );
  console.log(`[prepare-playwright-sessions] prepared ${sessions.length} sessions`);
}

main().catch((error) => {
  console.error('[prepare-playwright-sessions] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
