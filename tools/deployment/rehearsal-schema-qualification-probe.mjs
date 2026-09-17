#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,159}$/u;
const BACKFILL_TABLE = '__fsus_schema_backfill_progress';
const HISTORY_TABLE = '__fsus_schema_migration_history';
const CONTROL_TABLE = '__fsus_schema_qualification_control';

export function parsePrivateEnvironmentFile(file)
{
    const resolved = path.resolve(file);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('environment file must be a regular non-symlink file');
    }
    if (![0o400, 0o600].includes(stat.mode & 0o777))
    {
        throw new Error('environment file must have mode 0400 or 0600');
    }
    const values = new Map();
    for (const rawLine of fs.readFileSync(fs.realpathSync(resolved), 'utf8').split(/\r?\n/u))
    {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
        {
            continue;
        }
        const separator = line.indexOf('=');
        if (separator <= 0)
        {
            throw new Error('environment file contains an invalid assignment');
        }
        const name = line.slice(0, separator).trim();
        if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(name))
        {
            throw new Error(`environment variable name is invalid: ${name}`);
        }
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        {
            value = value.slice(1, -1);
        }
        values.set(name, value);
    }
    return values;
}

export function hashResumeToken(value)
{
    return `sha256:${crypto.createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

export function normalizeQualificationArguments(argv)
{
    const operation = argv.shift();
    if (![
        'checkpoint', 'backfill-pause', 'prepare-missing-expand', 'rollback-marker',
        'advisory-lock-timeout', 'database-disconnect', 'partial-failure',
        'history-mismatch-unknown'
    ].includes(operation))
    {
        throw new Error('qualification operation is invalid');
    }
    const values = {};
    while (argv.length > 0)
    {
        const name = argv.shift();
        const value = argv.shift();
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (Object.hasOwn(values, key))
        {
            throw new Error(`duplicate argument --${key}`);
        }
        values[key] = value;
    }
    for (const name of ['database', 'env-file'])
    {
        if (!values[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    if (!SAFE_ID.test(values.database) || /prod(?:uction)?/iu.test(values.database))
    {
        throw new Error('--database must identify an isolated non-production qualification database');
    }
    for (const name of ['migration-id', 'contract-id', 'rollout', 'release'])
    {
        if (values[name] !== undefined && !SAFE_ID.test(values[name]))
        {
            throw new Error(`--${name} is invalid`);
        }
    }
    return { operation, ...values };
}

async function main()
{
    ensureTestBoundary();
    const options = normalizeQualificationArguments(process.argv.slice(2));
    const environment = parsePrivateEnvironmentFile(options['env-file']);
    const database = requiredSafe(environment, 'DB_NAME');
    const user = requiredSafe(environment, 'DB_USER');
    const container = requiredSafe(
        new Map([['value', process.env.FSUSBLOG_REHEARSAL_POSTGRES_CONTAINER
      ?? environment.get('FSUSBLOG_REHEARSAL_POSTGRES_CONTAINER')
      ?? 'fsusblog-zdt-postgres']]),
        'value');
    const context = { options, database, user, container };

    let result;
    if (options.operation === 'checkpoint')
    {
        result = checkpoint(context);
    }
    else if (options.operation === 'backfill-pause')
    {
        result = backfillPause(context);
    }
    else if (options.operation === 'prepare-missing-expand')
    {
        result = prepareMissingExpand(context);
    }
    else if (options.operation === 'rollback-marker')
    {
        result = rollbackMarker(context);
    }
    else if (options.operation === 'advisory-lock-timeout')
    {
        result = await advisoryLockTimeout(context);
    }
    else if (options.operation === 'database-disconnect')
    {
        result = databaseDisconnect(context);
    }
    else if (options.operation === 'partial-failure')
    {
        result = partialFailure(context);
    }
    else
    {
        result = historyMismatchUnknown(context);
    }

    process.stdout.write(`${JSON.stringify(result.payload)}\n`);
    process.exitCode = result.exitCode;
}

function checkpoint(context)
{
    const migrationId = requiredId(context.options, 'migration-id');
    const rows = query(context, `
    SELECT status, COALESCE(resume_token, ''), rows_processed, failure_count,
           to_char(updated_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM ${quoteIdentifier(BACKFILL_TABLE)}
    WHERE migration_id = ${sqlLiteral(migrationId)};
  `);
    if (rows.length !== 1)
    {
        throw new Error(`checkpoint is missing for ${migrationId}`);
    }
    const [status, resumeToken, rowsProcessed, failureCount, updatedAtUtc] = rows[0];
    return success({
        status,
        checkpoint: {
            migrationId,
            status,
            resumeTokenHash: hashResumeToken(resumeToken),
            rowsProcessed: Number(rowsProcessed),
            failureCount: Number(failureCount),
            updatedAtUtc
        }
    });
}

function backfillPause(context)
{
    const migrationId = requiredId(context.options, 'migration-id');
    execute(context, controlTablesSql());
    execute(context, `
    UPDATE sys_user
    SET account_subject_hash = NULL
    WHERE id = (SELECT id FROM sys_user ORDER BY id DESC LIMIT 1);
    DELETE FROM ${quoteIdentifier(HISTORY_TABLE)} WHERE migration_id = ${sqlLiteral(migrationId)};
    INSERT INTO ${quoteIdentifier(BACKFILL_TABLE)}(
      migration_id, status, resume_token, rows_processed, failure_count, updated_at_utc,
      verified_at_utc, rows_per_second, remaining_rows_estimate)
    VALUES (${sqlLiteral(migrationId)}, 'paused', '0', 1, 0, now() AT TIME ZONE 'UTC', NULL, NULL, 1)
    ON CONFLICT (migration_id) DO UPDATE
    SET status='paused', resume_token='0', rows_processed=1, failure_count=0,
        updated_at_utc=now() AT TIME ZONE 'UTC', verified_at_utc=NULL,
        rows_per_second=NULL, remaining_rows_estimate=1;
  `);
    return success({
        status: 'paused',
        phase: 'backfill',
        migrationIds: [migrationId],
        codes: ['schema_backfill_resume_required']
    });
}

function prepareMissingExpand(context)
{
    const migrationId = requiredId(context.options, 'migration-id');
    const contractId = requiredId(context.options, 'contract-id');
    execute(context, `
    DELETE FROM ${quoteIdentifier(HISTORY_TABLE)} WHERE migration_id = ${sqlLiteral(migrationId)};
    DELETE FROM ${quoteIdentifier(HISTORY_TABLE)} WHERE migration_id = ${sqlLiteral(contractId)};
  `);
    return success({
        status: 'prepared',
        phase: 'qualification',
        migrationIds: [migrationId, contractId],
        codes: ['schema_expand_removed_for_qualification']
    });
}

function rollbackMarker(context)
{
    const contractId = requiredId(context.options, 'contract-id');
    const rolloutId = requiredId(context.options, 'rollout');
    const releaseId = requiredId(context.options, 'release');
    const rows = query(context, `
    SELECT COUNT(*)::text
    FROM ${quoteIdentifier(HISTORY_TABLE)}
    WHERE migration_id = ${sqlLiteral(contractId)} AND succeeded = TRUE;
  `);
    const applied = Number(rows[0]?.[0] ?? 0) === 1;
    if (!applied)
    {
        throw new Error(`qualified Contract history is missing: ${contractId}`);
    }
    execute(context, controlTablesSql());
    execute(context, `
    INSERT INTO ${quoteIdentifier(CONTROL_TABLE)}(control_key, control_value, updated_at_utc)
    VALUES ('contract-marker', ${sqlLiteral(`${rolloutId}:${releaseId}`)}, now() AT TIME ZONE 'UTC')
    ON CONFLICT (control_key) DO UPDATE
    SET control_value=EXCLUDED.control_value, updated_at_utc=EXCLUDED.updated_at_utc;
  `);
    return success({ status: 'ok', rolloutId, releaseId, contractApplied: true, rollbackCompatible: false });
}

async function advisoryLockTimeout(context)
{
    const lockKey = 7_311_031;
    const holder = spawnPsql(context, `SELECT pg_advisory_lock(${lockKey}); SELECT pg_sleep(3);`);
    await delay(250);
    const contender = psql(context, `SET statement_timeout='150ms'; SELECT pg_advisory_lock(${lockKey});`);
    holder.kill('SIGTERM');
    await waitForExit(holder, 2_000);
    if (contender.status === 0 || !/statement timeout/iu.test(contender.stderr))
    {
        throw new Error('real PostgreSQL advisory lock timeout was not observed');
    }
    return failure({ status: 'failed', codes: ['schema_advisory_lock_timeout'] });
}

function databaseDisconnect(context)
{
    const result = spawnSync('docker', [
        'exec', '-i', context.container, 'psql', '--no-psqlrc', '-X',
        '-h', '127.0.0.1', '-p', '1', '-U', context.user, '-d', context.database, '-c', 'SELECT 1;'
    ], { encoding: 'utf8', timeout: 5_000 });
    if (result.status === 0)
    {
        throw new Error('isolated database disconnect probe unexpectedly connected');
    }
    return failure({ status: 'failed', codes: ['schema_database_unavailable'] });
}

function partialFailure(context)
{
    const migrationId = requiredId(context.options, 'migration-id');
    execute(context, controlTablesSql());
    execute(context, `
    UPDATE sys_user
    SET account_subject_hash = NULL
    WHERE id = (SELECT id FROM sys_user ORDER BY id DESC LIMIT 1);
    DELETE FROM ${quoteIdentifier(HISTORY_TABLE)} WHERE migration_id = ${sqlLiteral(migrationId)};
    INSERT INTO ${quoteIdentifier(BACKFILL_TABLE)}(
      migration_id, status, resume_token, rows_processed, failure_count, updated_at_utc,
      verified_at_utc, rows_per_second, remaining_rows_estimate)
    VALUES (${sqlLiteral(migrationId)}, 'failed', '0', 1, 1, now() AT TIME ZONE 'UTC', NULL, NULL, 1)
    ON CONFLICT (migration_id) DO UPDATE
    SET status='failed', resume_token='0', rows_processed=GREATEST(rows_processed, 1),
        failure_count=GREATEST(failure_count + 1, 1), updated_at_utc=now() AT TIME ZONE 'UTC',
        verified_at_utc=NULL, rows_per_second=NULL, remaining_rows_estimate=1;
  `);
    return failure({ status: 'failed', codes: ['schema_backfill_injected_partial_failure'] });
}

function historyMismatchUnknown(context)
{
    const knownId = requiredId(context.options, 'migration-id');
    const unknownId = `qualification-unknown-${context.options.database}`.slice(0, 150);
    execute(context, controlTablesSql());
    execute(context, `
    UPDATE ${quoteIdentifier(HISTORY_TABLE)}
    SET checksum = 'qualification-mismatched-checksum'
    WHERE migration_id = ${sqlLiteral(knownId)};
    INSERT INTO ${quoteIdentifier(HISTORY_TABLE)}(migration_id, checksum, applied_at_utc, app_version, succeeded)
    VALUES (${sqlLiteral(unknownId)}, 'qualification-unknown-checksum', now() AT TIME ZONE 'UTC', 'qualification', TRUE)
    ON CONFLICT (migration_id) DO UPDATE SET checksum=EXCLUDED.checksum, succeeded=TRUE;
  `);
    const rows = query(context, `
    SELECT migration_id, checksum, succeeded::text
    FROM ${quoteIdentifier(HISTORY_TABLE)}
    ORDER BY migration_id;
  `);
    const historyHash = hashResumeToken(rows.map(row => row.join('\0')).join('\n'));
    return failure({
        status: 'not_ready',
        historyHash,
        issues: [
            { code: 'schema_history_checksum_mismatch', severity: 'error', migrationId: knownId },
            { code: 'schema_history_unknown', severity: 'error', migrationId: unknownId }
        ]
    });
}

function controlTablesSql()
{
    return `
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(CONTROL_TABLE)} (
      control_key varchar(96) PRIMARY KEY,
      control_value varchar(512) NOT NULL,
      updated_at_utc timestamp NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(BACKFILL_TABLE)} (
      migration_id varchar(160) PRIMARY KEY,
      status varchar(32) NOT NULL,
      resume_token varchar(512) NULL,
      rows_processed bigint NOT NULL,
      failure_count bigint NOT NULL,
      updated_at_utc timestamp NOT NULL,
      verified_at_utc timestamp NULL,
      rows_per_second double precision NULL,
      remaining_rows_estimate bigint NULL
    );
  `;
}

function query(context, sql)
{
    const result = psql(context, sql);
    if (result.status !== 0)
    {
        throw new Error(`qualification database query failed: ${sanitizeError(result.stderr)}`);
    }
    const text = result.stdout.trim();
    return text ? text.split(/\r?\n/u).map(line => line.split('\t')) : [];
}

function execute(context, sql)
{
    const result = psql(context, sql);
    if (result.status !== 0)
    {
        throw new Error(`qualification database mutation failed: ${sanitizeError(result.stderr)}`);
    }
}

function psql(context, sql)
{
    const result = spawnSync('docker', psqlArgs(context), {
        input: sql,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function spawnPsql(context, sql)
{
    const child = spawn('docker', psqlArgs(context), { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(sql);
    return child;
}

function psqlArgs(context)
{
    return [
        'exec', '-i', context.container,
        'psql', '--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-F', '\t',
        '-U', context.user, '-d', context.database
    ];
}

function ensureTestBoundary()
{
    if (process.env.ASPNETCORE_ENVIRONMENT !== 'Test'
    || process.env.FSUSBLOG_ROLLOUT_REHEARSAL !== '1')
    {
        throw new Error('schema qualification probe is restricted to the explicit Test rehearsal');
    }
}

function requiredSafe(values, name)
{
    const value = String(values.get(name) ?? '');
    if (!SAFE_ID.test(value))
    {
        throw new Error(`${name} is missing or invalid`);
    }
    return value;
}

function requiredId(options, name)
{
    const value = String(options[name] ?? '');
    if (!SAFE_ID.test(value))
    {
        throw new Error(`--${name} is required and must be safe`);
    }
    return value;
}

function quoteIdentifier(value)
{
    return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value)
{
    return `'${String(value).replaceAll("'", "''")}'`;
}

function success(payload)
{
    return { exitCode: 0, payload };
}

function failure(payload)
{
    return { exitCode: 1, payload };
}

function sanitizeError(value)
{
    return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim().slice(0, 512);
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForExit(child, timeoutMs)
{
    return new Promise(resolve =>
    {
        const timer = setTimeout(() =>
        {
            child.kill('SIGKILL');
            resolve();
        }, timeoutMs);
        child.once('close', () =>
        {
            clearTimeout(timer);
            resolve();
        });
    });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    main().catch(error =>
    {
        process.stderr.write(`[rehearsal-schema-qualification-probe] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
    });
}
