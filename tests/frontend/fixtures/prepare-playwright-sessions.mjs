#!/usr/bin/env node
// fixture-catalog: consumer playwright-session-fixture auth-basic
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWorkerTestSession } from '../support/test-session.mjs';
import {
  playwrightSessionModes,
  resolvePlaywrightSessionMode,
  resolveSessionFixtureDirectory
} from '../support/fixture-paths.mjs';
import { resolveSessionPrepConcurrency } from './session-prep-admission.mjs';
import { loadTemporalContext } from '../../../tools/test/temporal-context.mjs';
import {
  resolveTemporalRolesForProducer,
  verifyResolvedTemporalArtifact
} from '../../../tools/test/temporal-role-resolver.mjs';

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

function parseWorkers(argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.indexOf('--workers');
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : env.FSUSBLOG_PLAYWRIGHT_WORKERS;
  const parsed = Number(raw || '4');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4;
}

function parseConcurrency(workers, argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.indexOf('--concurrency');
  const raw = flagIndex >= 0
    ? argv[flagIndex + 1]
    : env.FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY;
  if (raw === undefined || String(raw).trim() === '') return workers;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Playwright session prep concurrency must be a positive integer, got ${raw}`);
  }
  return Math.min(workers, parsed);
}

export function resolveSessionPreparationTopology({
  argv = process.argv.slice(2),
  env = process.env
} = {}) {
  const mode = resolvePlaywrightSessionMode(env);
  if (mode === playwrightSessionModes.browserContract) {
    throw new Error(
      'browser-contract must use its formal single-namespace fixture lifecycle; '
      + 'legacy Playwright session preparation and public-schema cloning are disabled'
    );
  }

  const workers = parseWorkers(argv, env);
  const requestedSessionPrepConcurrency = parseConcurrency(workers, argv, env);
  if (mode === playwrightSessionModes.browserDiagnostics) {
    if (workers !== 1 || requestedSessionPrepConcurrency !== 1) {
      throw new Error('browser-diagnostics session preparation requires exactly one worker and one preparation slot');
    }
    return {
      mode,
      workers: 1,
      requestedSessionPrepConcurrency: 1,
      usesDynamicPostgresPidAdmission: false,
      sessions: [resolveWorkerTestSession(0, env)]
    };
  }

  return {
    mode,
    workers,
    requestedSessionPrepConcurrency,
    usesDynamicPostgresPidAdmission: true,
    sessions: Array.from({ length: workers }, (_, index) => resolveWorkerTestSession(index, env))
  };
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

async function readPostgresPidSnapshot() {
  assertSafeFixtureContainer(pgContainer, 'FSUSBLOG_PG_CONTAINER');
  const output = await run('docker', [
    'exec',
    pgContainer,
    'sh',
    '-c',
    'cat /sys/fs/cgroup/pids.current; cat /sys/fs/cgroup/pids.max'
  ]);
  const [currentRaw, maxRaw] = output.split(/\r?\n/u).map((value) => value.trim());
  const current = Number(currentRaw);
  const max = maxRaw === 'max' ? null : Number(maxRaw);
  if (!Number.isInteger(current) || current < 0 || (max !== null && (!Number.isInteger(max) || max <= 0))) {
    throw new Error(`invalid PostgreSQL cgroup PID counters: ${output}`);
  }
  return { current, max };
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
  const topology = resolveSessionPreparationTopology();
  assertActiveNamespaceUrl(backendBaseUrl, 'FSUSBLOG_BASE_URL or FSUSBLOG_DEBUG_BACKEND_URL');
  const {
    mode,
    requestedSessionPrepConcurrency,
    sessions,
    usesDynamicPostgresPidAdmission
  } = topology;
  const postgresPids = usesDynamicPostgresPidAdmission
    ? await readPostgresPidSnapshot()
    : null;
  const sessionPrepConcurrency = postgresPids
    ? resolveSessionPrepConcurrency(requestedSessionPrepConcurrency, postgresPids)
    : 1;
  const fixturesDir = resolveSessionFixtureDirectory();
  const temporalContext = loadTemporalContext();
  const resolvedTemporalRoles = resolveTemporalRolesForProducer({
    temporalContext,
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
    fixtureId: 'auth-session'
  });
  verifyResolvedTemporalArtifact(resolvedTemporalRoles, { temporalContext });
  const temporalRoleEnvironment = {
    FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON: JSON.stringify(resolvedTemporalRoles),
    FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST: resolvedTemporalRoles.contentDigest
  };
  await mkdir(fixturesDir, { recursive: true });
  const admissionEvidence = postgresPids
    ? `postgresPids=${postgresPids.current}/${postgresPids.max ?? 'max'}`
    : 'postgresPids=not-read-fixed-topology';
  console.log(
    `[prepare-playwright-sessions] mode=${mode} admission requested=${requestedSessionPrepConcurrency}`
    + ` effective=${sessionPrepConcurrency} ${admissionEvidence}`
  );

  await runWithConcurrency(sessions, sessionPrepConcurrency, async (session) => {
    console.log(`[prepare-playwright-sessions] preparing ${session}`);
    await Promise.all([
      clonePublicSchema(session),
      cleanupRedis(session)
    ]);

    const env = {
      ...temporalRoleEnvironment,
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
      FSUSBLOG_DEVICE_FP: `${session}-playwright`
    };

    // Auth smoke only here. Public content is owned by FixtureOrchestrator public-content
    // transaction-fixture producer (#1712); do not dual-seed via discover-playwright-fixtures.
    await runNodeScript(path.join(fixtureScriptRoot, 'prepare-auth-smoke-users.mjs'), env);
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

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error('[prepare-playwright-sessions] fatal:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
