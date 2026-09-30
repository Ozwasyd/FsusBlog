import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const { readPrivateFile, readPrivateJson, writePrivateJson } = await import(new URL('../test-fixtures/receipt/private-io.mjs', import.meta.url));
const { readRetainedMySqlFixtureLifecycle, verifyMySqlFixtureServiceCleanup } = await import(new URL('../test-fixtures/services/mysql.mjs', import.meta.url));
import { loadExecutionServiceCatalog, validateExecutionServiceCatalog,
    validateExecutionServiceEnvelopeShape, verifyLiveServiceEnvelope } from './execution-envelope-services.mjs';

export const mysqlFixtureAdmissionSchema = 'fsusblog.mysql-fixture-admission.v1';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourceFingerprint = (value) => String(value ?? '').replace(/^sha256:/u, '');
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function exact(value, keys)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function requireContext(context)
{
    if (!exact(context, ['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState', 'resourceGrant',
        'startupBudgetMs', 'commandBudgetMs', 'cleanupBudgetMs'])
        || !exact(context.sourceState, ['commit', 'worktreeFingerprint'])
        || !exact(context.resourceGrant, ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'])
        || typeof context.root !== 'string' || fs.realpathSync(context.root) !== context.root
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(context.runId)
        || [context.namespace, context.bundleId, context.stepId].some((value) =>
            typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value))
        || !/^[a-f0-9]{40}$/u.test(context.sourceState.commit)
        || !/^[a-f0-9]{64}$/u.test(sourceFingerprint(context.sourceState.worktreeFingerprint))
        || [context.startupBudgetMs, context.commandBudgetMs, context.cleanupBudgetMs].some((value) =>
            !Number.isSafeInteger(value) || value <= 0))
    {
        throw new Error('MySQL fixture admission requires an exact scheduler/lifecycle context');
    }
}

export function mysqlFixtureAdmissionFile(context)
{
    requireContext(context);
    const owner = sha256(`${context.bundleId}\n${context.stepId}`).slice(7);
    return path.join(context.root, '.tmp/test-runs', context.runId, 'mysql-admission', `${owner}.json`);
}

function requirePrivateOwnedFile(file, label, { json = true } = {})
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
    {
        throw new Error(`${label} requires one private scheduler-owned regular file`);
    }
    return json ? readPrivateJson(file, { label }) : readPrivateFile(file, { label });
}

function requireCatalog(catalog)
{
    const errors = validateExecutionServiceCatalog(catalog, {
        tiers: [{ services: Object.keys(catalog?.services ?? {}) }]
    });
    if (errors.length || !catalog?.services?.mysql?.resourceGrant)
    {
        throw new Error('MySQL fixture admission requires the registered service catalog');
    }
}

function requireEnvelope(record, catalog)
{
    const { context, envelope, reservation } = record;
    const physicalBundleId = context.bundleId === 'matrix:backend-unit'
        ? 'backend-unit' : context.bundleId;
    validateExecutionServiceEnvelopeShape(envelope, catalog);
    if (!exact(reservation, ['runId', 'bundleId', 'id', 'identity', 'limits', 'held'])
        || reservation.held !== true || reservation.runId !== context.runId
        || reservation.bundleId !== physicalBundleId || reservation.id !== 'mysql-migration'
        || !isDeepStrictEqual(reservation.identity, Object.fromEntries(
            ['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState'].map((key) => [key, context[key]])))
        || !isDeepStrictEqual(reservation.limits, context.resourceGrant)
        || !isDeepStrictEqual(context.resourceGrant, catalog.services.mysql.resourceGrant)
        || !isDeepStrictEqual({ startupMs: context.startupBudgetMs, commandMs: context.commandBudgetMs,
            cleanupMs: context.cleanupBudgetMs }, catalog.services.mysql.lifecycleBudgets)
        || envelope?.qualificationEligible !== true
        || envelope?.producerId !== context.stepId || envelope?.runId !== context.runId
        || !isDeepStrictEqual(envelope?.requiredServices, ['mysql'])
        || envelope?.actual?.services?.length !== 1)
    {
        throw new Error('MySQL fixture admission crosses its held service grant or producer');
    }
    const service = envelope.actual.services[0];
    const expectedOwnership = {
        runId: context.runId, bundleId: context.bundleId, stepId: context.stepId,
        namespace: context.namespace, repositoryRootDigest: sha256(context.root)
    };
    if (service.id !== 'mysql' || !isDeepStrictEqual(service.ownership, expectedOwnership)
        || service.resourceLimits?.nanoCpus !== context.resourceGrant.cpuUnits * 1e9
        || service.resourceLimits?.memoryReservation !== context.resourceGrant.memoryHighBytes
        || service.resourceLimits?.memory !== context.resourceGrant.memoryMaxBytes
        || service.resourceLimits?.pidsLimit !== context.resourceGrant.pidsMax
        || !/^[a-f0-9]{64}$/u.test(service.containerId ?? ''))
    {
        throw new Error('MySQL fixture admission observed service differs from its owner and grant');
    }
    return service;
}

/** The scheduler publishes only after its resource lease and live service both verify. */
export function publishMySqlFixtureAdmission({ context, stateFile, bindingDigest, envelope, reservation })
{
    const file = mysqlFixtureAdmissionFile(context);
    if (fs.lstatSync(file, { throwIfNoEntry: false }))
    {
        throw new Error('MySQL fixture admission refuses a stale or repeated publication');
    }
    const record = { schema: mysqlFixtureAdmissionSchema, context, stateFile, bindingDigest, envelope, reservation };
    requireEnvelope(record, loadExecutionServiceCatalog());
    const retained = readRetainedMySqlFixtureLifecycle(context, bindingDigest);
    if (stateFile !== retained.paths.stateFile || retained.state.phase !== 'prepared'
        || !isDeepStrictEqual(retained.state.observation, envelope.actual))
    {
        throw new Error('MySQL fixture admission cannot publish an unprepared lifecycle');
    }
    writePrivateJson(file, record, { label: 'MySQL fixture admission' });
    return file;
}

/** Revalidate immutable admission plus live service or exact post-run cleanup. */
export function readMySqlFixtureAdmission(context, {
    file = mysqlFixtureAdmissionFile(context),
    phase = 'live',
    catalog = loadExecutionServiceCatalog(),
    observeRuntime,
    observeService,
    verifyCleanup = verifyMySqlFixtureServiceCleanup
} = {})
{
    const expectedFile = mysqlFixtureAdmissionFile(context);
    if (file !== expectedFile || !['live', 'live-or-cleaned'].includes(phase))
    {
        throw new Error('MySQL fixture admission path or phase differs from its scheduler owner');
    }
    requireCatalog(catalog);
    const { document: record, contentDigest } = requirePrivateOwnedFile(file, 'MySQL fixture admission');
    if (!exact(record, ['schema', 'context', 'stateFile', 'bindingDigest', 'envelope', 'reservation'])
        || record.schema !== mysqlFixtureAdmissionSchema
        || !isDeepStrictEqual(record.context, context)
        || !digestPattern.test(record.bindingDigest ?? '')
        || typeof record.stateFile !== 'string')
    {
        throw new Error('MySQL fixture admission is malformed or crossed');
    }
    const service = requireEnvelope(record, catalog);
    const { paths, state } = readRetainedMySqlFixtureLifecycle(context, record.bindingDigest);
    if (record.stateFile !== paths.stateFile
        || state.containerId !== service.containerId
        || !isDeepStrictEqual(state.observation, record.envelope.actual))
    {
        throw new Error('MySQL fixture admission lifecycle differs from its retained service');
    }
    if (state.phase === 'prepared')
    {
        const client = requirePrivateOwnedFile(path.join(paths.directory, 'client.cnf'),
            'MySQL fixture client options', { json: false });
        if (!/^\[client\]\npassword=[a-f0-9]{64}\n$/u.test(client.bytes.toString('utf8')))
        {
            throw new Error('MySQL fixture client options are malformed');
        }
        verifyLiveServiceEnvelope({ envelope: record.envelope, catalog, observeRuntime, observeService });
    }
    else if (phase === 'live-or-cleaned' && state.phase === 'cleaned')
    {
        verifyCleanup(context, { expectedBindingDigest: record.bindingDigest });
    }
    else
    {
        throw new Error('MySQL fixture admission requires a live service or exact completed cleanup');
    }
    const port = service.ports?.find((entry) => entry.containerPort === '3306/tcp'
        && entry.hostIp === '127.0.0.1')?.hostPort;
    const database = service.databaseIdentity;
    if (!/^[1-9][0-9]{0,4}$/u.test(port ?? '') || Number(port) > 65535
        || !/^[0-9a-fA-F-]{36}$/u.test(database?.serverUuid ?? '')
        || typeof database.serverVersion !== 'string' || !database.serverVersion)
    {
        throw new Error('MySQL fixture admission has no exact loopback SQL identity');
    }
    return {
        record, contentDigest,
        executionEnvironment: {
            FSUSBLOG_MYSQL_FIXTURE_CLIENT_FILE: path.join(path.dirname(record.stateFile), 'client.cnf'),
            FSUSBLOG_MYSQL_FIXTURE_PORT: port,
            FSUSBLOG_MYSQL_FIXTURE_SERVER_UUID: database.serverUuid,
            FSUSBLOG_MYSQL_FIXTURE_SERVER_VERSION: database.serverVersion,
            FSUSBLOG_MYSQL_FIXTURE_DATABASE_PREFIX: state.databasePrefix,
            FSUSBLOG_MYSQL_FIXTURE_TIMEOUT_SECONDS: String(Math.max(1, Math.ceil(context.commandBudgetMs / 1000)))
        }
    };
}

/** Child-side lookup accepts only the scheduler's exact run/source/producer path. */
export function readMySqlFixtureAdmissionForRun(expected, { file, ...options } = {})
{
    if (!exact(expected, ['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState'])
        || typeof file !== 'string' || !path.isAbsolute(file))
    {
        throw new Error('MySQL fixture admission requires an exact scheduler run lookup');
    }
    const first = requirePrivateOwnedFile(file, 'MySQL fixture admission');
    const context = first.document?.context;
    if (!context || Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(context[key], value))
        || file !== mysqlFixtureAdmissionFile(context))
    {
        throw new Error('MySQL fixture admission file crosses its run, source or producer');
    }
    const verified = readMySqlFixtureAdmission(context, { file, ...options });
    if (first.contentDigest !== verified.contentDigest)
    {
        throw new Error('MySQL fixture admission changed during verification');
    }
    return verified;
}
