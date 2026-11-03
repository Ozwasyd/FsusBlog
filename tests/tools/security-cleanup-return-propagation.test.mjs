import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const producerSource = readFileSync(new URL('../../tools/test-fixtures/producers/security-fixture-producer.mjs', import.meta.url), 'utf8');
const portSource = readFileSync(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url), 'utf8');

// Execute only the original return-propagation functions. Every operation helper
// is a stub; production cleanup, observations and authority imports never run.
function cleanupWithStubs(stubs)
{
    const start = producerSource.indexOf('export async function cleanupSecurityFixtures(');
    assert.ok(start >= 0);
    const source = producerSource.slice(start).replace(/^export /u, '');
    return vm.runInNewContext(`${source}\ncleanupSecurityFixtures;`, stubs);
}

function portCleanupWithStub(cleanupSecurityFixtures)
{
    const start = portSource.indexOf('export function createSecurityStatePort(');
    const end = portSource.indexOf('\nfunction requireConsumedProducerOutputs', start);
    assert.ok(start >= 0 && end > start);
    const body = portSource.slice(start, end).match(/async cleanup\(context, producerResult, signal\)\s*\{(?<body>[\s\S]*?)\n {8}\}/u)?.groups.body;
    assert.equal(typeof body, 'string');
    const importStatement = "const { cleanupSecurityFixtures } = await import('./security-fixture-producer.mjs');";
    assert.ok(body.includes(importStatement));
    return vm.runInNewContext(`(async (context, producerResult, signal) => {${body.replace(importStatement, '')}\n})`, {
        cleanupSecurityFixtures
    });
}

function stubFixture(cleanupFamily)
{
    const families = ['credential', 'ban', 'risk-pow-rate-limit'];
    const adapters = Object.fromEntries(families.map((family) => [family, { control: `adapter-${family}` }]));
    const fragments = Object.fromEntries(families.map((family) => [family, { control: `fragment-${family}` }]));
    const context = { runIdentity: 'return-control', namespace: 'return-control' };
    const plan = { runId: context.runIdentity, namespace: context.namespace };
    return {
        families, adapters, fragments, context, plan,
        cleanup: cleanupWithStubs({
            familyAdapters: (actualContext) =>
            {
                assert.equal(actualContext, context);
                return adapters;
            },
            selectedFamilies: (actualPlan) =>
            {
                assert.equal(actualPlan, plan);
                return families;
            },
            fragmentForFamily: (actualPlan, family) =>
            {
                assert.equal(actualPlan, plan);
                return fragments[family];
            },
            cleanupFamily
        })
    };
}

test('cleanup returns original helper objects in reverse family order after one call each', async () =>
{
    const observations = [{ control: 'risk-return' }, { control: 'ban-return' }, { control: 'credential-return' }];
    const calls = [];
    const fixture = stubFixture(async (...args) =>
    {
        calls.push(args);
        return observations[calls.length - 1];
    });
    const signal = new AbortController().signal;
    const result = await fixture.cleanup(fixture.context, { operationPlan: fixture.plan }, signal);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.length, observations.length);
    for (const [index, family] of [...fixture.families].reverse().entries())
    {
        assert.equal(result[index], observations[index]);
        assert.deepEqual(calls[index], [fixture.adapters[family], fixture.plan, fixture.fragments[family], signal]);
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(fixture.families, ['credential', 'ban', 'risk-pow-rate-limit']);
});

test('cleanup rejects with the original helper error and stops before later families', async () =>
{
    const originalError = new Error('synthetic cleanup helper failure');
    const calls = [];
    const fixture = stubFixture(async (...args) =>
    {
        calls.push(args);
        if (calls.length === 2)
        {
            throw originalError;
        }
        return { control: 'first helper return' };
    });
    const signal = new AbortController().signal;
    await assert.rejects(fixture.cleanup(fixture.context, { operationPlan: fixture.plan }, signal),
        (error) => error === originalError);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], fixture.adapters['risk-pow-rate-limit']);
    assert.equal(calls[1][0], fixture.adapters.ban);
    assert.ok(calls.every((call) => call[1] === fixture.plan && call[3] === signal));
});

test('catalog cleanup port awaits one original call and returns the same array', async () =>
{
    const observations = Object.freeze([{ control: 'original observation' }]);
    const context = { control: 'context' };
    const producerResult = { control: 'producer result' };
    const signal = new AbortController().signal;
    const calls = [];
    const cleanup = portCleanupWithStub(async (...args) =>
    {
        calls.push(args);
        await Promise.resolve();
        return observations;
    });
    assert.equal(await cleanup(context, producerResult, signal), observations);
    assert.deepEqual(calls, [[context, producerResult, signal]]);
});

test('catalog cleanup port preserves the original rejection without retry or wrapping', async () =>
{
    const originalError = new Error('synthetic producer failure');
    let calls = 0;
    const cleanup = portCleanupWithStub(async () =>
    {
        calls += 1;
        throw originalError;
    });
    await assert.rejects(cleanup({}, {}, new AbortController().signal), (error) => error === originalError);
    assert.equal(calls, 1);
});
