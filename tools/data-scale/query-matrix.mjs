import { decodeAedsFrame } from './aeds-decoders.mjs';
import { assertSameQueryBinding, queryCaseIds, queryMatrixTiers, requireQueryBinding } from './query-case-registry.mjs';
import { computeSha256 } from './runtime-plan.mjs';

function sameItems(expected, actual)
{
    if (!Array.isArray(actual) || expected.length !== actual.length)
    {
        throw new Error('payload membership incomplete');
    }
    const ids = actual.map((row) => String(row.id));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('duplicate payload row');
    }
    for (let index = 0; index < expected.length; index += 1)
    {
        const row = expected[index];
        for (const [key, value] of Object.entries(row))
        {
            const observed = actual[index]?.[key];
            if (key === 'id' ? String(value) !== String(observed) : computeSha256(value) !== computeSha256(observed ?? null))
            {
                throw new Error(`payload membership, ordering or content mismatch at ${index}.${key}`);
            }
        }
    }
}

/** Decoders are existing product adapters; article cursors stay protected/opaque. */
export function verifyQueryTraversal({ coordinate, samples, binding, decode })
{
    requireQueryBinding(binding);
    if (typeof decode !== 'function' || !Array.isArray(samples) || samples.length === 0)
    {
        throw new Error('payload decoder or samples unavailable');
    }
    const expected = coordinate.traversalItems ?? coordinate.expectedItems;
    const pageSize = coordinate.pageSize ?? expected.length;
    let offset = 0;
    let nextCursor = null;
    const seenCursors = new Set();
    const decodedPages = [];
    for (const sample of samples)
    {
        assertSameQueryBinding(binding, sample.binding);
        if (sample.status !== 200 || !/^application\/octet-stream(?:;|$)/u.test(sample.contentType ?? '')
            || sample.path !== coordinate.path || (sample.inputCursor ?? null) !== nextCursor
            || (!(sample.body instanceof Uint8Array) && !(sample.body instanceof ArrayBuffer)))
        {
            throw new Error('HTTP sample contract or cursor continuation mismatch');
        }
        const frame = decodeAedsFrame(sample.body);
        if (!Number.isSafeInteger(coordinate.frameType) || frame.frameType !== coordinate.frameType)
        {
            throw new Error('payload frame type mismatch');
        }
        const decoded = decode(frame.payload);
        sameItems(expected.slice(offset, offset + pageSize), decoded.items);
        if (coordinate.total !== undefined && decoded.total !== undefined && decoded.total !== coordinate.total)
        {
            throw new Error('payload total mismatch');
        }
        offset += decoded.items.length;
        const hasMore = offset < expected.length;
        const cursorRead = coordinate.traversalItems !== undefined;
        if (cursorRead && (decoded.hasMore !== hasMore || (hasMore ? typeof decoded.nextCursor !== 'string' || !decoded.nextCursor : decoded.nextCursor !== null)))
        {
            throw new Error('payload cursor terminal state mismatch');
        }
        if (hasMore && (decoded.items.length === 0 || seenCursors.has(decoded.nextCursor)))
        {
            throw new Error('cursor repeated or made no progress');
        }
        if (hasMore)
        {
            seenCursors.add(decoded.nextCursor);
        }
        nextCursor = cursorRead ? decoded.nextCursor : null;
        decodedPages.push(decoded.items);
    }
    if (offset !== expected.length || nextCursor !== null || (coordinate.traversalItems === undefined && samples.length !== 1))
    {
        throw new Error('cursor traversal omitted rows or terminal sample');
    }
    if (coordinate.offset !== undefined)
    {
        sameItems(coordinate.expectedItems, decodedPages[coordinate.offset / pageSize]);
    }
    return { itemCount: offset, pageCount: decodedPages.length };
}

function nonnegative(value, field)
{
    if (!Number.isFinite(value) || value < 0)
    {
        throw new Error(`actual plan metric missing or invalid: ${field}`);
    }
    return value;
}

/** Root buffer counters are cumulative; summing parents and children double-counts. */
export function summarizeActualPlan(explain)
{
    if (!Array.isArray(explain) || explain.length !== 1 || !explain[0]?.Plan)
    {
        throw new Error('actual EXPLAIN JSON unavailable');
    }
    const document = explain[0];
    const root = document.Plan;
    const scanTypes = new Set();
    const indexNames = new Set();
    let rowsRead = 0;
    let nodeCount = 0;
    function visit(node)
    {
        if (!node || typeof node['Node Type'] !== 'string')
        {
            throw new Error('plan node invalid');
        }
        nodeCount += 1;
        nonnegative(node['Actual Rows'], 'Actual Rows');
        nonnegative(node['Actual Loops'], 'Actual Loops');
        if (/Scan$/u.test(node['Node Type']))
        {
            scanTypes.add(node['Node Type']);
            rowsRead += (node['Actual Rows']
                + nonnegative(node['Rows Removed by Filter'] ?? 0, 'Rows Removed by Filter')
                + nonnegative(node['Rows Removed by Index Recheck'] ?? 0, 'Rows Removed by Index Recheck')) * node['Actual Loops'];
        }
        if (node['Index Name'])
        {
            indexNames.add(node['Index Name']);
        }
        for (const child of node.Plans ?? [])
        {
            visit(child);
        }
    }
    visit(root);
    return {
        latencyMs: nonnegative(document['Execution Time'], 'Execution Time'),
        planningMs: nonnegative(document['Planning Time'], 'Planning Time'),
        rowsRead,
        sharedBlocksRead: nonnegative(root['Shared Read Blocks'], 'Shared Read Blocks'),
        sharedBlocksHit: nonnegative(root['Shared Hit Blocks'], 'Shared Hit Blocks'),
        tempBlocks: nonnegative(root['Temp Read Blocks'], 'Temp Read Blocks') + nonnegative(root['Temp Written Blocks'], 'Temp Written Blocks'),
        scanTypes: [...scanTypes].sort(),
        indexNames: [...indexNames].sort(),
        nodeCount
    };
}

export function sqlFingerprint(sql)
{
    if (typeof sql !== 'string' || !sql.trim())
    {
        throw new Error('canonical parameterized SQL unavailable');
    }
    // Keep literals and SQL token boundaries intact. Parameters have a separate digest.
    return computeSha256(sql.replaceAll('\r\n', '\n').trim());
}

export function validateQueryPolicy(policy)
{
    for (const field of ['maxLatencyMs', 'maxRowsRead', 'maxSharedBlocksRead', 'maxTempBlocks'])
    {
        nonnegative(policy?.[field], `policy.${field}`);
    }
    if (policy.maxLatencyMs === 0 || !Array.isArray(policy.allowedScanTypes) || !policy.allowedScanTypes.length
        || policy.allowedScanTypes.some((type) => typeof type !== 'string' || !type.endsWith('Scan'))
        || !Array.isArray(policy.requiredIndexNames) || policy.requiredIndexNames.some((name) => typeof name !== 'string' || !name)
        || typeof policy.forbidOffset !== 'boolean')
    {
        throw new Error('case-specific query policy invalid');
    }
    if (policy.allowedScanTypes.includes('Seq Scan') && (typeof policy.seqScanReason !== 'string' || policy.seqScanReason.trim().length < 10))
    {
        throw new Error('allowed Seq Scan requires a case-specific reason');
    }
}

/** Evaluates collector output only; it does not admit a runtime or qualify a lane. */
export function evaluateQueryCase({ entry, sample, policy, binding, decode })
{
    const failureReasons = [];
    let metrics = null;
    const queryEvidence = [];
    try
    {
        validateQueryPolicy(policy);
        if (entry.status !== 'ready' || !entry.coordinate)
        {
            throw new Error(`fixture coordinate blocked: ${(entry.failureReasons ?? []).join('; ')}`);
        }
        if (sample?.status !== 'collected')
        {
            throw new Error('case sample missing, skipped or collector failed');
        }
        assertSameQueryBinding(binding, sample.binding);
        verifyQueryTraversal({ coordinate: entry.coordinate, samples: sample.http, binding, decode });
        if (!Array.isArray(sample.queries) || sample.queries.length === 0)
        {
            throw new Error('actual query plan collector unavailable');
        }
        const targetSampleIndex = entry.coordinate.offset === undefined ? 0 : entry.coordinate.offset / entry.coordinate.pageSize;
        const plans = sample.queries.map((query) =>
        {
            assertSameQueryBinding(binding, query.binding);
            if (query.status !== 'collected')
            {
                throw new Error('query collector failed or skipped a statement');
            }
            if (query.httpSampleIndex !== targetSampleIndex)
            {
                throw new Error('query plan does not belong to the measured HTTP window');
            }
            if (query.sqlFingerprint !== sqlFingerprint(query.sql)
                || !query.parameters || query.parametersDigest !== computeSha256(query.parameters))
            {
                throw new Error('SQL fingerprint or parameter binding mismatch');
            }
            if (policy.forbidOffset && /\boffset\b/iu.test(query.sql))
            {
                throw new Error('cursor query degraded to OFFSET');
            }
            const actual = summarizeActualPlan(query.explain);
            queryEvidence.push({ sqlFingerprint: query.sqlFingerprint, parametersDigest: query.parametersDigest,
                httpSampleIndex: query.httpSampleIndex, metrics: actual });
            return actual;
        });
        const httpLatency = nonnegative(sample.http[targetSampleIndex]?.latencyMs, 'HTTP latency');
        const sumMetric = (metric) => plans.reduce((sum, plan) => sum + plan[metric], 0);
        metrics = {
            latencyMs: Math.max(httpLatency, sumMetric('latencyMs')),
            rowsRead: sumMetric('rowsRead'),
            sharedBlocksRead: sumMetric('sharedBlocksRead'),
            sharedBlocksHit: sumMetric('sharedBlocksHit'),
            tempBlocks: sumMetric('tempBlocks')
        };
        for (const [metric, maximum] of Object.entries({ latencyMs: 'maxLatencyMs', rowsRead: 'maxRowsRead', sharedBlocksRead: 'maxSharedBlocksRead', tempBlocks: 'maxTempBlocks' }))
        {
            if (metrics[metric] > policy[maximum])
            {
                failureReasons.push(`${metric} exceeds case policy`);
            }
        }
        for (const plan of plans)
        {
            for (const type of plan.scanTypes)
            {
                if (!policy.allowedScanTypes.includes(type))
                {
                    failureReasons.push(`unexpected scan type: ${type}`);
                }
            }
        }
        const usedIndexes = new Set(plans.flatMap((plan) => plan.indexNames));
        for (const index of policy.requiredIndexNames)
        {
            if (!usedIndexes.has(index))
            {
                failureReasons.push(`required index not used: ${index}`);
            }
        }
    }
    catch (error)
    {
        failureReasons.push(error.message);
    }
    return { id: entry.id, status: failureReasons.length ? 'failed' : 'ok', metrics, queryEvidence, failureReasons };
}

export function evaluateQueryMatrix({ registry, samples, policies, decoders })
{
    requireQueryBinding(registry.binding);
    const { contentDigest, ...registryBody } = registry;
    if (contentDigest !== computeSha256(registryBody))
    {
        throw new Error('query registry content digest mismatch');
    }
    if (!queryMatrixTiers.includes(registry.tier) || !Array.isArray(registry.cases) || !Array.isArray(samples))
    {
        throw new Error('query matrix registry or samples invalid');
    }
    const results = queryCaseIds.map((id) =>
    {
        const entries = registry.cases.filter((entry) => entry.id === id);
        const matches = samples.filter((sample) => sample.id === id);
        if (entries.length !== 1 || matches.length !== 1)
        {
            return { id, status: 'failed', metrics: null, failureReasons: ['case registry or sample missing/duplicated'] };
        }
        return evaluateQueryCase({ entry: entries[0], sample: matches[0], policy: policies?.[id], binding: registry.binding, decode: decoders?.[id] });
    });
    const unknownIds = [...registry.cases, ...samples].filter((row) => !queryCaseIds.includes(row.id)).map((row) => row.id);
    return {
        schema: 'fsusblog.data-scale-query-matrix-evaluation.v1',
        tier: registry.tier,
        binding: registry.binding,
        status: unknownIds.length || results.some((row) => row.status !== 'ok') ? 'failed' : 'ok',
        unknownIds,
        results
    };
}

export function compareQueryTrends(matrices)
{
    const results = [];
    const failures = [];
    for (const tier of queryMatrixTiers)
    {
        const matches = matrices.filter((matrix) => matrix.tier === tier);
        if (matches.length !== 1 || matches[0].status !== 'ok'
            || matches[0].results.length !== queryCaseIds.length
            || queryCaseIds.some((id) => matches[0].results.filter((row) => row.id === id && row.status === 'ok').length !== 1))
        {
            failures.push(`${tier} matrix missing, failed or case set inconsistent`);
        }
    }
    if (matrices.length !== queryMatrixTiers.length)
    {
        failures.push('unexpected tier matrix');
    }
    if (!failures.length)
    {
        for (const id of queryCaseIds)
        {
            const values = queryMatrixTiers.map((tier) =>
            {
                const matrix = matrices.find((item) => item.tier === tier);
                requireQueryBinding(matrix.binding);
                const metrics = matrix.results.find((row) => row.id === id).metrics;
                for (const field of ['rowsRead', 'sharedBlocksRead', 'sharedBlocksHit', 'tempBlocks', 'latencyMs'])
                {
                    nonnegative(metrics?.[field], `trend.${field}`);
                }
                return { tier, ...metrics };
            });
            if (new Set(matrices.map((matrix) => matrix.binding.sourceCommit)).size !== 1
                || new Set(matrices.map((matrix) => matrix.binding.businessEpochUtc)).size !== 1)
            {
                throw new Error('cross-tier source commit or business epoch mismatch');
            }
            const comparisons = values.slice(1).map((current, index) =>
            {
                const previous = values[index];
                const changes = Object.fromEntries(['rowsRead', 'sharedBlocksRead', 'sharedBlocksHit', 'tempBlocks', 'latencyMs'].map((field) => [field, {
                    delta: current[field] - previous[field],
                    ratio: previous[field] === 0 ? (current[field] === 0 ? 1 : null) : current[field] / previous[field]
                }]));
                return { fromTier: previous.tier, toTier: current.tier, changes };
            });
            results.push({ id, values, comparisons });
        }
    }
    return { schema: 'fsusblog.data-scale-query-trends-evaluation.v1', status: failures.length ? 'failed' : 'ok', failures, results };
}
