/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { normalizeSemantic, requireDigest, requireText } from '../../test-runtime/contract.mjs';
import { freezeDeep, plainObject } from '../receipt/canonical.mjs';

import {
    assertOwnedHandle,
    assertReadonlyPort,
    normalizedObserverResult,
    observeDeclaredAbsence,
    readObserverSideEffects,
    requireClock,
    sideEffectDelta,
    stableRecords
} from './common.mjs';

function requireContext(context, domain, portId)
{
    const identity = context?.identity;
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain);
    const port = assertReadonlyPort(context?.ports?.[portId], ['describeDomain', 'readSideEffectCounters'], `${portId} observer port`);
    return { identity, handle, port };
}

function normalizeColumns(columns, label)
{
    if (!Array.isArray(columns) || columns.length === 0)
    {
        throw new Error(`${label} columns are required`);
    }
    const names = columns.map((column) => requireText(column?.name, `${label} column name`));
    if (new Set(names).size !== names.length)
    {
        throw new Error(`${label} has duplicate columns`);
    }
    return columns.map((column) => freezeDeep({
        name: requireText(column.name, `${label} column name`),
        type: requireText(column.type, `${label} column type`),
        nullable: column.nullable === true,
        semanticClock: column.semanticClock === true
    })).sort((left, right) => left.name.localeCompare(right.name));
}

export async function observePostgresqlState({ domain, identity, context, signal })
{
    if (!domain.startsWith('postgres.'))
    {
        throw new Error(`PostgreSQL observer cannot own ${domain}`);
    }
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain);
    const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'postgresql', handle });
    if (absent)
    {
        return absent;
    }
    const { port } = requireContext({ ...context, identity }, domain, 'postgresql');
    if (typeof port.streamRows !== 'function')
    {
        throw new Error('PostgreSQL observer port requires streamRows()');
    }
    const before = await readObserverSideEffects(port);
    const description = await port.describeDomain({ handle, domain, signal });
    if (!plainObject(description) || description.readonly !== true || description.namespace !== handle.namespace)
    {
        throw new Error(`PostgreSQL domain ${domain} is not current-session readonly state`);
    }
    const columns = normalizeColumns(description.columns, domain);
    const primaryKey = (description.primaryKey ?? []).map((item) => requireText(item, `${domain} primary key`));
    if (primaryKey.length === 0 || primaryKey.some((key) => !columns.some((column) => column.name === key)))
    {
        throw new Error(`PostgreSQL domain ${domain} has no canonical primary key`);
    }
    const rows = [];
    for await (const row of port.streamRows({ handle, domain, pageSize: 512, signal }))
    {
        if (!plainObject(row) || !plainObject(row.values))
        {
            throw new Error(`${domain} yielded a malformed row`);
        }
        const actualColumns = Object.keys(row.values).sort();
        const expectedColumns = columns.map((column) => column.name).sort();
        if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns))
        {
            throw new Error(`${domain} row column set is incomplete or unknown`);
        }
        for (const column of columns)
        {
            if (row.values[column.name] === null && !column.nullable)
            {
                throw new Error(`${domain}.${column.name} unexpectedly null`);
            }
            if (column.semanticClock && identity.clockDigest !== context.fixedClock?.digest)
            {
                throw new Error(`${domain}.${column.name} has no fixed clock binding`);
            }
        }
        rows.push({
            table: requireText(description.table, `${domain} table`),
            key: primaryKey.map((key) => normalizeSemantic(row.values[key])),
            values: normalizeSemantic(row.values)
        });
    }
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind: 'postgresql',
        namespace: handle.namespace,
        schema: requireText(description.schema, `${domain} schema`),
        table: requireText(description.table, `${domain} table`),
        columns,
        primaryKey,
        rows: stableRecords(rows, ['table', 'key'], `${domain} rows`)
    }, {
        providerId: requireText(description.providerId, `${domain} providerId`),
        providerVersion: requireText(description.providerVersion, `${domain} providerVersion`),
        pageSize: 512
    }, sideEffectDelta(before, after));
}

function normalizeRedisValue(entry, clock)
{
    const type = requireText(entry.type, 'Redis value type');
    if (!['string', 'hash', 'list', 'set', 'sorted-set', 'stream'].includes(type))
    {
        throw new Error(`unsupported Redis type ${type}`);
    }
    const expiresAtEpochMs = entry.expiresAtEpochMs == null ? null : Number(entry.expiresAtEpochMs);
    if (expiresAtEpochMs != null && !Number.isSafeInteger(expiresAtEpochMs))
    {
        throw new Error('Redis expiry is not canonical');
    }
    return freezeDeep({
        key: requireText(entry.key, 'Redis key'),
        type,
        value: normalizeSemantic(entry.value, `Redis ${entry.key} value`),
        ttlMs: expiresAtEpochMs == null ? null : expiresAtEpochMs - clock.epochMs,
        generation: entry.generation == null ? null : requireText(entry.generation, `Redis ${entry.key} generation`)
    });
}

export async function observeRedisState({ domain, identity, context, signal })
{
    if (!domain.startsWith('redis.'))
    {
        throw new Error(`Redis observer cannot own ${domain}`);
    }
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain);
    const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'redis', handle });
    if (absent)
    {
        return absent;
    }
    const { port } = requireContext({ ...context, identity }, domain, 'redis');
    if (typeof port.scanDomain !== 'function')
    {
        throw new Error('Redis observer port requires scanDomain()');
    }
    const clock = requireClock({ ...context, identity });
    const before = await readObserverSideEffects(port);
    const description = await port.describeDomain({ handle, domain, signal });
    if (!plainObject(description) || description.readonly !== true || description.namespace !== handle.namespace
    || description.clockDigest !== clock.digest)
    {
        throw new Error(`Redis domain ${domain} identity/clock is stale or shared`);
    }
    const entries = [];
    for await (const entry of port.scanDomain({ handle, domain, pageSize: 512, signal }))
    {
        entries.push(normalizeRedisValue(entry, clock));
    }
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind: 'redis',
        namespace: handle.namespace,
        keyPattern: requireText(description.keyPattern, `${domain} keyPattern`),
        clockDigest: requireDigest(description.clockDigest, `${domain} clockDigest`),
        entries: stableRecords(entries, ['key'], `${domain} Redis entries`)
    }, {
        providerId: requireText(description.providerId, `${domain} providerId`),
        providerVersion: requireText(description.providerVersion, `${domain} providerVersion`),
        pageSize: 512
    }, sideEffectDelta(before, after));
}

export function createPostgresqlObserver()
{
    return Object.freeze({ observerId: 'postgresql', version: 'v1', observe: observePostgresqlState });
}

export function createRedisObserver()
{
    return Object.freeze({ observerId: 'redis', version: 'v1', observe: observeRedisState });
}
