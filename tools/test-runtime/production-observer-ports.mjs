import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function safeContainer(value, label)
{
    const name = String(value ?? '').trim();
    if (!/^fsusblog-(?:dev|test|ci)[A-Za-z0-9_.-]*$/u.test(name)
        && !/^[0-9a-f]{64}$/u.test(name))
    {
        throw new Error(`${label} is not a dedicated FsusBlog container`);
    }
    return name;
}

function safeIdentifier(value, label)
{
    const identifier = String(value ?? '').trim();
    if (!/^[a-z_][a-z0-9_]*$/u.test(identifier))
    {
        throw new Error(`${label} is not a canonical PostgreSQL identifier`);
    }
    return identifier;
}

function docker(container, args, { encoding = 'utf8', input } = {})
{
    return execFileSync('docker', ['exec', ...(input === undefined ? [] : ['-i']), container, ...args], {
        encoding,
        input,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024
    });
}

function bytesDigest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Bind relation inventories and row digests without storing fixture values in receipts. */
export function postgresqlDatabaseStateDigest(state)
{
    return bytesDigest(JSON.stringify({ schemaDigest: state.schemaDigest,
        relations: state.relations.map(({ name, kind, rowCount, rowsDigest }) => (
            { name, kind, rowCount, rowsDigest }
        )) }));
}

/** Observe the complete public fixture schema, rows and sequence state without writes. */
export function readDockerPostgresqlDatabaseState({ container })
{
    const endpoint = safeContainer(container, 'PostgreSQL container');
    // pg_dump's random psql restrict nonce is transport metadata, not schema state.
    const readSchema = () => docker(endpoint, ['pg_dump', '-U', 'fsusblog', '-d', 'fsusblog',
        '--schema=public', '--schema-only'])
        .replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?\n/gmu, '');
    const schema = readSchema();
    const script = `
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
DO $$ BEGIN
IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'f') THEN
RAISE EXCEPTION 'foreign-table fixture data cannot be observed locally';
END IF;
END $$;
SELECT jsonb_build_object('kind', 'inventory', 'relations', coalesce(jsonb_agg(
    jsonb_build_object('name', c.relname, 'kind', c.relkind::text) ORDER BY c.relname COLLATE "C"), '[]'::jsonb))
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'S');
SELECT format(CASE WHEN c.relkind = 'S' THEN
    'SELECT jsonb_build_object(''name'', %L, ''kind'', %L, ''rows'', jsonb_build_array(jsonb_build_object(''last_value'', last_value, ''log_cnt'', log_cnt, ''is_called'', is_called))) FROM %I.%I;'
    ELSE 'SELECT jsonb_build_object(''name'', %L, ''kind'', %L, ''rows'', coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), ''[]''::jsonb)) FROM %I.%I AS t;' END,
    c.relname, c.relkind::text, n.nspname, c.relname)
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'S')
ORDER BY c.relname COLLATE "C"
\\gexec
ROLLBACK;
`;
    const output = docker(endpoint, ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'fsusblog', '-d', 'fsusblog'], { input: script });
    const [inventory, ...records] = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (inventory?.kind !== 'inventory' || !Array.isArray(inventory.relations))
    {
        throw new Error('PostgreSQL database relation inventory is missing');
    }
    const relations = records.map((record) =>
    {
        if (typeof record.name !== 'string' || !['r', 'm', 'S'].includes(record.kind)
            || !Array.isArray(record.rows))
        {
            throw new Error('PostgreSQL database observation is incomplete');
        }
        return { name: record.name, kind: record.kind, rowCount: record.rows.length,
            rowsDigest: bytesDigest(JSON.stringify(record.rows)) };
    });
    if (JSON.stringify(inventory.relations.map(({ name, kind }) => ({ name, kind })))
        !== JSON.stringify(relations.map(({ name, kind }) => ({ name, kind }))))
    {
        throw new Error('PostgreSQL database relation inventory is incomplete');
    }
    if (schema !== readSchema())
    {
        throw new Error('PostgreSQL schema changed during data observation');
    }
    const state = { schemaDigest: bytesDigest(schema), relations };
    return { status: 'observed', database: 'fsusblog', ...state,
        stateDigest: postgresqlDatabaseStateDigest(state) };
}

/** Observe only public cache keys through the existing semantic Redis owner. */
export async function readDockerPublicCacheState({ container, namespacePrefix })
{
    if (typeof namespacePrefix !== 'string' || !/^[A-Za-z0-9_.-]+_$/u.test(namespacePrefix))
    {
        throw new Error('public cache requires the sealed instance prefix');
    }
    const port = createDockerRedisReadonlyPort({ container,
        fixedClock: { epochMs: 0, digest: 'readonly-key-inventory' } });
    const handle = { namespacePrefix, keyPatterns: [`${namespacePrefix}*`, 'e2e:*'],
        ownershipClass: 'dedicated-session-container' };
    const keys = [];
    for await (const entry of port.scanDomain({ handle, domain: 'redis.cache.public' }))
    {
        keys.push(entry.key);
    }
    return { status: 'observed', namespacePrefix, publicKeyCount: keys.length,
        keyDigests: keys.map((key) => bytesDigest(key)).sort() };
}

/** Remove exact public cache keys only after re-observing current run ownership. */
export async function resetDockerPublicCache({ container, runId, namespace, namespacePrefix })
{
    if (!/^[0-9a-f]{64}$/u.test(String(container ?? '')) || !runId || !namespace)
    {
        throw new Error('public cache reset requires exact container/run/namespace identities');
    }
    const verifyOwner = () =>
    {
        const [actual] = JSON.parse(execFileSync('docker', ['inspect', container], {
            encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024
        }));
        if (actual?.Id !== container || actual.State?.Running !== true
            || actual.Config?.Labels?.['io.fsusblog.test.run-id'] !== runId
            || actual.Config?.Labels?.['io.fsusblog.test.namespace'] !== namespace)
        {
            throw new Error('public cache reset container ownership changed');
        }
    };
    verifyOwner();
    // Validate the prefix before scanning or mutating any key.
    const before = await readDockerPublicCacheState({ container, namespacePrefix });
    const port = createDockerRedisReadonlyPort({ container,
        fixedClock: { epochMs: 0, digest: 'readonly-key-inventory' } });
    const handle = { namespacePrefix, keyPatterns: [`${namespacePrefix}*`, 'e2e:*'],
        ownershipClass: 'dedicated-session-container' };
    const deleted = [];
    for await (const entry of port.scanDomain({ handle, domain: 'redis.cache.public' }))
    {
        verifyOwner();
        const count = redisJson(container, 'DEL', entry.key);
        if (!Number.isInteger(count) || count < 0 || count > 1)
        {
            throw new Error('public cache reset returned an invalid deletion result');
        }
        deleted.push({ keyDigest: bytesDigest(entry.key), deletedCount: count });
    }
    verifyOwner();
    const after = await readDockerPublicCacheState({ container, namespacePrefix });
    return { status: after.publicKeyCount === 0 ? 'complete' : 'failed',
        containerId: container, runId, namespace, namespacePrefix,
        deleted: deleted.sort((left, right) => left.keyDigest.localeCompare(right.keyDigest)),
        before, after };
}

function psql(container, sql)
{
    return docker(container, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-At', '-c', sql]);
}

function sqlLiteral(value)
{
    return `'${String(value).replaceAll("'", "''")}'`;
}

function quoted(value, label)
{
    return `"${safeIdentifier(value, label)}"`;
}

/** A production readonly port backed by the session-owned PostgreSQL container. */
export function createDockerPostgresqlReadonlyPort({ container })
{
    const containerName = safeContainer(container, 'PostgreSQL container');
    return Object.freeze({
        readonly: true,
        async readSideEffectCounters()
        {
            return { writes: 0, networkMutations: 0, tokenRefreshes: 0, repairs: 0, lifecycleTransitions: 0 };
        },
        async describeDomain({ handle, domain })
        {
            const schema = safeIdentifier(handle.schema ?? 'public', `${domain} schema`);
            const table = safeIdentifier(handle.table, `${domain} table`);
            const columns = psql(containerName, `
SELECT column_name || E'\\t' || data_type || E'\\t' || CASE WHEN is_nullable = 'YES' THEN '1' ELSE '0' END
FROM information_schema.columns
WHERE table_schema = ${sqlLiteral(schema)} AND table_name = ${sqlLiteral(table)}
ORDER BY ordinal_position;`).trim().split('\n').filter(Boolean).map((line) =>
            {
                const [name, type, nullable] = line.split('\t');
                return { name, type, nullable: nullable === '1', semanticClock: (handle.semanticClockColumns ?? []).includes(name) };
            });
            if (columns.length === 0)
            {
                throw new Error(`PostgreSQL domain ${domain} table is missing`);
            }
            const primaryKey = psql(containerName, `
SELECT a.attname
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE i.indrelid = ${sqlLiteral(`${schema}.${table}`)}::regclass AND i.indisprimary
ORDER BY array_position(i.indkey, a.attnum);`).trim().split('\n').filter(Boolean);
            if (primaryKey.length === 0)
            {
                throw new Error(`PostgreSQL domain ${domain} lacks a primary key`);
            }
            return {
                readonly: true,
                namespace: handle.namespace,
                schema,
                table,
                columns,
                primaryKey,
                providerId: 'docker-postgresql',
                providerVersion: String(docker(containerName, ['postgres', '--version'])).trim()
            };
        },
        async *streamRows({ handle, domain })
        {
            const schema = quoted(handle.schema ?? 'public', `${domain} schema`);
            const table = quoted(handle.table, `${domain} table`);
            const primaryKey = (handle.primaryKey ?? []).map((column) => quoted(column, `${domain} primary key`));
            if (primaryKey.length === 0)
            {
                throw new Error(`${domain} handle lacks sealed primary key columns`);
            }
            const rows = psql(containerName, `SELECT row_to_json(t)::text FROM (SELECT * FROM ${schema}.${table} ORDER BY ${primaryKey.join(', ')}) AS t;`);
            for (const line of rows.trim().split('\n').filter(Boolean))
            {
                yield { values: JSON.parse(line) };
            }
        }
    });
}

function redisJson(container, ...args)
{
    const output = docker(container, ['redis-cli', '--json', ...args]).trim();
    return output ? JSON.parse(output) : null;
}

function redisValue(container, type, key)
{
    if (type === 'string')
    {
        return redisJson(container, 'GET', key);
    }
    if (type === 'hash')
    {
        const values = redisJson(container, 'HGETALL', key) ?? [];
        const entries = [];
        for (let index = 0; index < values.length; index += 2)
        {
            entries.push([values[index], values[index + 1]]);
        }
        return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
    }
    if (type === 'list')
    {
        return redisJson(container, 'LRANGE', key, '0', '-1') ?? [];
    }
    if (type === 'set')
    {
        return (redisJson(container, 'SMEMBERS', key) ?? []).sort();
    }
    if (type === 'zset')
    {
        return redisJson(container, 'ZRANGE', key, '0', '-1', 'WITHSCORES') ?? [];
    }
    if (type === 'stream')
    {
        return redisJson(container, 'XRANGE', key, '-', '+') ?? [];
    }
    throw new Error(`unsupported Redis type ${type}`);
}

function redisSemanticDomain(key, instancePrefix)
{
    let semantic = String(key);
    if (instancePrefix && semantic.startsWith(instancePrefix))
    {
        semantic = semantic.slice(instancePrefix.length);
    }
    semantic = semantic.replace(/^e2e:[a-z0-9-]+:/u, '');
    if (/(?:session|auth|token|credential|mfa|passkey|login|logout)/u.test(semantic))
    {
        return 'redis.session';
    }
    if (/(?:rate|risk|challenge|pow|visit-lock|human-read|perception|blacklist|blocked-user|anonymous-comment-ticket)/u.test(semantic))
    {
        return 'redis.rate-limit';
    }
    if (/^(?:fsus:)?(?:blog|public|sys):|^blog:/u.test(semantic))
    {
        return 'redis.cache.public';
    }
    return 'redis.cache.private';
}

/** A production readonly port backed by the session-owned Redis container. */
export function createDockerRedisReadonlyPort({ container, fixedClock })
{
    const containerName = safeContainer(container, 'Redis container');
    if (!Number.isSafeInteger(Number(fixedClock?.epochMs)) || !fixedClock?.digest)
    {
        throw new Error('Redis port requires a sealed fixed clock');
    }
    return Object.freeze({
        readonly: true,
        async readSideEffectCounters()
        {
            return { writes: 0, networkMutations: 0, tokenRefreshes: 0, repairs: 0, lifecycleTransitions: 0 };
        },
        async describeDomain({ handle, domain })
        {
            const prefix = String(handle.namespacePrefix ?? '');
            const patterns = handle.keyPatterns ?? [];
            if (!prefix || handle.ownershipClass !== 'dedicated-session-container'
        || !Array.isArray(patterns) || patterns.length !== 2
        || patterns[0] !== `${prefix}*` || patterns[1] !== 'e2e:*')
            {
                throw new Error(`${domain} Redis patterns are shared or unsealed`);
            }
            return {
                readonly: true,
                namespace: handle.namespace,
                keyPattern: String(handle.keyPattern),
                clockDigest: fixedClock.digest,
                providerId: 'docker-redis',
                providerVersion: String(docker(containerName, ['redis-server', '--version'])).trim()
            };
        },
        async *scanDomain({ handle, domain })
        {
            const prefix = String(handle.namespacePrefix ?? '');
            const keys = [];
            for (const pattern of handle.keyPatterns)
            {
                let cursor = '0';
                do
                {
                    const page = redisJson(containerName, 'SCAN', cursor, 'MATCH', pattern, 'COUNT', '512');
                    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1]))
                    {
                        throw new Error('Redis SCAN returned a partial page');
                    }
                    cursor = String(page[0]);
                    keys.push(...page[1]);
                } while (cursor !== '0');
            }
            for (const key of [...new Set(keys)].filter((value) => redisSemanticDomain(value, prefix) === domain).sort())
            {
                if (!key.startsWith(prefix) && !key.startsWith('e2e:'))
                {
                    throw new Error(`Redis key escaped the current session namespace: ${key}`);
                }
                const type = redisJson(containerName, 'TYPE', key);
                if (type === 'none')
                {
                    throw new Error(`Redis key disappeared during observation: ${key}`);
                }
                const ttlMs = Number(redisJson(containerName, 'PTTL', key));
                if (!Number.isSafeInteger(ttlMs) || ttlMs < -1)
                {
                    throw new Error(`Redis TTL is unstable for ${key}`);
                }
                yield {
                    key,
                    type,
                    value: redisValue(containerName, type, key),
                    expiresAtEpochMs: ttlMs === -1 ? null : Number(fixedClock.epochMs) + ttlMs,
                    generation: null
                };
            }
        }
    });
}
