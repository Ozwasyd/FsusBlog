import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { maskCSharp } from '../../tools/architecture/backend-physical-topology/csharp-mask.mjs';

const root = new URL('../..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const registry = JSON.parse(read('config/development/public-hot-delivery-registry.json'));
const deliveryClasses = [
    'RequiredContent',
    'RequiredTaxonomy',
    'BestEffortView',
    'FullRebuildMarker'
];
const deliveryStatuses = [
    'Accepted',
    'PersistedDirty',
    'Coalesced',
    'Cancelled',
    'Closed',
    'Failed'
];
const handlers = [
    'require-durable',
    'status-switch',
    'taxonomy-status-switch'
];

function compare(left, right)
{
    return `${left.path}:${left.class}`.localeCompare(`${right.path}:${right.class}`);
}

function discoverCs(path)
{
    return readdirSync(new URL(path, root), { withFileTypes: true }).flatMap((entry) =>
    {
        const nested = join(path, entry.name);
        if (entry.isDirectory())
        {
            return discoverCs(nested);
        }

        return entry.name.endsWith('.cs') ? [nested] : [];
    });
}

function findClosingParenthesis(source, openingIndex, label)
{
    let depth = 0;
    for (let index = openingIndex; index < source.length; index += 1)
    {
        if (source[index] === '(')
        {
            depth += 1;
        }
        else if (source[index] === ')')
        {
            depth -= 1;
            if (depth === 0)
            {
                return index;
            }
        }
    }

    assert.fail(`${label} has an unterminated invocation`);
}

function discoverQueueSymbols(maskedSource)
{
    const symbols = new Set([...maskedSource.matchAll(
        /\bPublicHotArtifactUpdateQueue\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\b/gu)]
        .map((match) => match.groups.name));
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const match of maskedSource.matchAll(
            /\b(?:var|PublicHotArtifactUpdateQueue)\s+(?<alias>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:this\.)?(?<source>[A-Za-z_][A-Za-z0-9_]*)\s*;/gu))
        {
            if (symbols.has(match.groups.source) && !symbols.has(match.groups.alias))
            {
                symbols.add(match.groups.alias);
                changed = true;
            }
        }
    }
    return symbols;
}

function discoverPublicHotCallsInSource(path, source)
{
    const masked = maskCSharp(source);
    const queueSymbols = discoverQueueSymbols(masked);
    const discovered = [];
    const allEnqueueInvocations = [...masked.matchAll(/\.\s*EnqueueAsync\s*\(/gu)];
    for (const match of masked.matchAll(
        /\b(?<receiver>[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*EnqueueAsync\s*\(/gu))
    {
        if (!queueSymbols.has(match.groups.receiver))
        {
            continue;
        }

        const openingIndex = masked.indexOf('(', match.index);
        const closingIndex = findClosingParenthesis(masked, openingIndex, `${path}:${match.index}`);
        const call = source.slice(match.index, closingIndex + 1);
        const classMatches = [...call.matchAll(
            /PublicHotArtifactDeliveryClass\.(RequiredContent|RequiredTaxonomy|BestEffortView|FullRebuildMarker)/gu)];
        assert.equal(
            classMatches.length,
            1,
            `${path}:${match.index} must declare exactly one literal delivery class`);

        const statementStart = Math.max(
            masked.lastIndexOf(';', match.index),
            masked.lastIndexOf('{', match.index),
            masked.lastIndexOf('}', match.index)) + 1;
        const prefix = masked.slice(statementStart, match.index);
        const resultMatch = prefix.match(
            /PublicHotArtifactEnqueueResult\s+(?<result>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:await\s*)?$/su);
        assert.ok(resultMatch?.groups?.result, `${path}:${match.index} must consume the typed result`);
        const statementEnd = masked.indexOf(';', closingIndex);
        assert.notEqual(statementEnd, -1, `${path}:${match.index} has no statement terminator`);
        discovered.push({
            path,
            class: classMatches[0][1],
            result: resultMatch.groups.result,
            callEnd: statementEnd
        });
    }

    if (queueSymbols.size > 0)
    {
        assert.equal(
            discovered.length,
            allEnqueueInvocations.length,
            `${path} contains an unresolved EnqueueAsync invocation beside a PublicHot queue`);
    }

    return discovered;
}

function discoverPublicHotCalls()
{
    const discovered = [];
    for (const path of discoverCs('src/backend'))
    {
        const source = read(path);
        assert.doesNotMatch(
            source,
            /(?:publicHot(?:Updates|UpdateQueue)|updateQueue)\.TryEnqueue\s*\(/u,
            path);
        discovered.push(...discoverPublicHotCallsInSource(path, source));
    }

    return discovered;
}

function assertExhaustiveStatusSwitch(source, label)
{
    for (const status of deliveryStatuses)
    {
        assert.match(
            source,
            new RegExp(`PublicHotArtifactDeliveryStatus\\.${status}\\b`, 'u'),
            `${label} does not handle ${status}`);
    }
}

test('delivery registry schema is closed, unique, and machine readable', () =>
{
    assert.deepEqual(Object.keys(registry).sort(), ['callSites', 'schemaVersion']);
    assert.equal(registry.schemaVersion, 1);
    assert.ok(Array.isArray(registry.callSites) && registry.callSites.length > 0);

    const identities = new Set();
    for (const entry of registry.callSites)
    {
        assert.deepEqual(
            Object.keys(entry).sort(),
            ['class', 'count', 'handler', 'path']);
        assert.match(entry.path, /^src\/backend\/.+\.cs$/u);
        assert.ok(deliveryClasses.includes(entry.class), entry.class);
        assert.ok(handlers.includes(entry.handler), entry.handler);
        assert.ok(Number.isInteger(entry.count) && entry.count > 0, entry.path);

        const identity = `${entry.path}:${entry.class}`;
        assert.equal(identities.has(identity), false, `duplicate registry identity ${identity}`);
        identities.add(identity);
    }
});

test('PublicHot producers consume typed receipts with one registered delivery class', () =>
{
    const discovered = discoverPublicHotCalls();
    const expected = registry.callSites.flatMap((entry) =>
        Array.from({ length: entry.count }, () => ({
            path: entry.path,
            class: entry.class
        })));
    assert.deepEqual(
        discovered.map(({ path, class: deliveryClass }) => ({
            path,
            class: deliveryClass
        })).sort(compare),
        expected.sort(compare));

    for (const call of discovered)
    {
        const entry = registry.callSites.find((candidate) =>
            candidate.path === call.path && candidate.class === call.class);
        assert.ok(entry, `${call.path}:${call.class}`);
        const source = read(call.path);
        const handlerContext = source.slice(call.callEnd, call.callEnd + 1_200);
        const escapedResult = call.result.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
        assert.doesNotMatch(
            source,
            new RegExp(`\\b${escapedResult}\\.Accepted\\b`, 'u'),
            `${call.path} must branch on Status, not a bool`);

        if (entry.handler === 'require-durable')
        {
            assert.match(
                handlerContext,
                new RegExp(
                    `PublicHotArtifactDeliveryReceipt\\.RequireDurable\\(\\s*${escapedResult}\\b`,
                    'u'),
                `${call.path} must require the durable receipt`);
        }
        else if (entry.handler === 'taxonomy-status-switch')
        {
            assert.match(
                handlerContext,
                new RegExp(`IsRequiredTaxonomyDeliveryDurable\\(\\s*${escapedResult}\\b`, 'u'));
            assertExhaustiveStatusSwitch(source, call.path);
        }
        else
        {
            assert.match(
                handlerContext,
                new RegExp(`\\b${escapedResult}\\.Status\\s+switch\\b`, 'u'));
            assertExhaustiveStatusSwitch(source, call.path);
        }
    }
});

test('PublicHot scanner kills variable-class, aliased, and multiline naked-call mutations', () =>
{
    const variableClassMutation = `
        sealed class Mutation(PublicHotArtifactUpdateQueue queue)
        {
            async Task Run(PublicHotArtifactDeliveryClass deliveryClass)
            {
                await queue.EnqueueAsync(deliveryClass, 42, "bypass");
            }
        }
    `;
    assert.throws(
        () => discoverPublicHotCallsInSource('fixture-variable-class.cs', variableClassMutation),
        /exactly one literal delivery class/u);

    const aliasMutation = `
        sealed class Mutation(PublicHotArtifactUpdateQueue queue)
        {
            async Task Run()
            {
                var alias = true ? queue : queue;
                PublicHotArtifactEnqueueResult result = await alias .
                    EnqueueAsync(
                        PublicHotArtifactDeliveryClass.RequiredContent,
                        42,
                        "bypass");
                PublicHotArtifactDeliveryReceipt.RequireDurable(result, "bypass");
            }
        }
    `;
    assert.throws(
        () => discoverPublicHotCallsInSource('fixture-alias.cs', aliasMutation),
        /unresolved EnqueueAsync invocation/u);

    const multilineMutation = `
        sealed class Mutation(PublicHotArtifactUpdateQueue queue)
        {
            async Task Run()
            {
                await queue
                    .EnqueueAsync(
                        PublicHotArtifactDeliveryClass.RequiredContent,
                        42,
                        "bypass");
            }
        }
    `;
    assert.throws(
        () => discoverPublicHotCallsInSource('fixture-multiline.cs', multilineMutation),
        /must consume the typed result/u);

    const legalDirectAndSimpleAlias = `
        sealed class Valid(PublicHotArtifactUpdateQueue queue)
        {
            async Task Run()
            {
                PublicHotArtifactEnqueueResult direct = await queue.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.RequiredContent,
                    41,
                    "direct");
                PublicHotArtifactDeliveryReceipt.RequireDurable(direct, "direct");
                var alias = queue;
                PublicHotArtifactEnqueueResult aliased = await alias .
                    EnqueueAsync(
                        PublicHotArtifactDeliveryClass.RequiredContent,
                        42,
                        "aliased");
                PublicHotArtifactDeliveryReceipt.RequireDurable(aliased, "aliased");
            }
        }
    `;
    assert.equal(
        discoverPublicHotCallsInSource('fixture-valid.cs', legalDirectAndSimpleAlias).length,
        2);
});

test('typed receipt exposes no Accepted bool and its durable gate is exhaustive', () =>
{
    const source = read(
        'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs');
    assert.doesNotMatch(
        source,
        /PublicHotArtifactEnqueueResult[\s\S]{0,240}\bbool\s+Accepted\b/u);
    assert.doesNotMatch(source, /internal\s+PublicHotArtifactEnqueueResult\s+Enqueue\s*\(/u);
    assertExhaustiveStatusSwitch(source, 'PublicHotArtifactDeliveryReceipt.RequireDurable');
});

test('bounded queue has no warning-only or retry-loop delivery fallback', () =>
{
    const source = read(
        'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs');
    assert.match(source, /BoundedChannelFullMode\.Wait/u);
    assert.match(source, /MarkDirtyAsync/u);
    assert.match(source, /LoadRecoveryUpdateAsync/u);
    assert.doesNotMatch(
        source,
        /queue-full-or-closed|Task\.Delay\([^)]*TryWrite|while\s*\([^)]*TryWrite/u);
});

test('durable generation uses atomic Redis compare-and-clear', () =>
{
    const source = read(
        'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactDeliveryState.cs');
    assert.match(source, /LuaScript\.Prepare/u);
    assert.match(source, /generation > pending/u);
    assert.match(source, /pending <= tonumber\(@generation\)/u);
    assert.doesNotMatch(
        source,
        /StringSetAsync\(runtimeKeyScope\.PrefixKey\(PendingKey\)/u);
});
