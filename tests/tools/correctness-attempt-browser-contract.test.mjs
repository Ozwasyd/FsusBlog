import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
const { finalizeBrowserContractReceipt } = await import(new URL('../browser-contract/contract.mjs', import.meta.url));

const { inventoryByDomain } = await import(new URL('../../tools/test/correctness-attempt-producers.mjs', import.meta.url));
const { defaultTimeoutPolicyDigest, qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { applyBrowserTemporalClock, observeBrowserTemporalContext } = await import(new URL('../../tools/test/temporal-producer-bindings.mjs', import.meta.url));
const { parse } = createRequire(new URL('../../tools/frontend/style-toolchain/package.json', import.meta.url))('espree');
const root = path.resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/correctness-attempt-producers.json'),
    'utf8'
));

test('Browser Contract producers are exact and use zero retry policy', () =>
{
    const entries = inventoryByDomain(inventory).get('browser-contract');
    assert.deepEqual(entries.map((item) => item.producerId), [
        'matrix:browser-contract',
        'matrix:production-xss-release'
    ]);
    for (const item of entries)
    {
        assert.equal(item.allowedRetries, 0);
        assert.equal(item.frameworkRetrySetting, 0);
        assert.equal(item.policyId, 'correctness-first-attempt');
        assert.equal(item.migrationState, 'migrated');
        assert.equal(item.qualificationEligible, true);
        assert.equal(item.attemptAdapter, 'tools/test/attempt-runner.mjs#runProducerAttempts');
    }
});

test('Playwright correctness settings cannot enable retries', () =>
{
    const config = fs.readFileSync(path.join(root, 'src/frontend/playwright.config.ts'), 'utf8');
    const diagnostics = fs.readFileSync(path.join(root, 'src/frontend/playwright.diagnostics.config.ts'), 'utf8');
    assert.doesNotMatch(config, /retries\s*:\s*[1-9]/u);
    assert.match(diagnostics, /retries\s*:\s*0/u);
    const runner = fs.readFileSync(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
    assert.doesNotMatch(runner, /FSUSBLOG_PLAYWRIGHT_RETRIES[^\n]*[1-9]/u);
});

test('the production scenario loop stops on first product failure and seals failed-no-retry', async () =>
{
    const source = fs.readFileSync(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const main = program.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'main');
    const loops = [];
    const collect = (node) =>
    {
        if (node?.type === 'ForOfStatement' && node.right.type === 'Identifier'
            && node.right.name === 'selectedScenarios' && node.left.type === 'VariableDeclaration'
            && node.left.declarations.length === 1 && node.left.declarations[0].id.name === 'scenario')
        {
            loops.push(node);
        }
        for (const value of Object.values(node ?? {}))
        {
            if (Array.isArray(value))
            {
                value.filter((child) => child?.type).forEach(collect);
            }
            else if (value?.type)
            {
                collect(value);
            }
        }
    };
    assert.ok(main, 'the original runner must retain its main function');
    collect(main.body);
    assert.equal(loops.length, 1, 'the first-stop control must execute the one original scenario loop');
    const loop = source.slice(loops[0].start, loops[0].end);
    assert.ok(loop.includes('throw error;'));
    assert.doesNotMatch(loop, /await runPublicShellLocaleScenes/u);
    const execute = async (body) =>
    {
        let laterCalls = 0;
        let closed = 0;
        let clockApplications = 0;
        let observedBusinessEpochUtc = null;
        const temporalContext = qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40), sourceFingerprint: `sha256:${'b'.repeat(64)}`,
            producerId: 'browser-contract', schedulerRunId: 'first-stop-model',
            businessEpochUtc: '2024-02-29T23:59:59.000Z', locale: 'en-US', uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        });
        const failure = new Error('first product failure');
        const receipt = { scenarios: ['first', 'later'].map((id) => ({ id, status: 'pending', artifacts: [] })),
            topology: { contextCount: 0 } };
        const page = { setDefaultTimeout()
        {}, setDefaultNavigationTimeout()
        {}, isClosed: () => true,
        clock: { setFixedTime: async (businessEpochUtc) =>
        {
            assert.equal(businessEpochUtc, temporalContext.businessEpochUtc);
            observedBusinessEpochUtc = businessEpochUtc;
            clockApplications++;
        } },
        evaluate: async () => ({ locale: temporalContext.locale, timezoneId: temporalContext.timezone,
            browserBusinessEpochUtc: observedBusinessEpochUtc }) };
        const bindings = {
            selectedScenarios: receipt.scenarios.map(({ id }) => ({ id, role: 'authenticated' })),
            receivedSignal: null, browserDisconnected: false, browserTemporalObservation: {},
            applyBrowserTemporalClock, observeBrowserTemporalContext, temporalContext,
            preparedFixture: { lifecycle: { runtime: { temporalObservation: {
                backendCulture: temporalContext.backendCulture, postgresTimezone: temporalContext.postgresTimezone,
                businessEpochUtc: temporalContext.businessEpochUtc
            } } } },
            process: { env: { TZ: temporalContext.nodeTimezone } },
            localeRootBinding: { artifact: 'first-stop-model-locale-root', digest: 'c'.repeat(64) },
            browserContractScenarioRunners: { first: async () =>
            {
                throw failure;
            }, later: async () =>
            {
                laterCalls++;
            } },
            receipt, activeScenario: null, browser: { newContext: async () => ({ newPage: async () => page,
                close: async () =>
                {
                    closed++;
                } }) },
            contextOptions: () => ({}), fixture: {}, managed: { plan: { rendering: {} } },
            traceRoot: '/unused-traces', path, browserContractAppReadyTimeoutMs: 1,
            createPageAudit: () => ({ issues: [] }), outputRoot: '/unused-output',
            classifyBrowserContractFailure: () => 'product',
            serializeBrowserContractError: (error) => ({ message: error.message })
        };
        const AsyncFunction = Object.getPrototypeOf(async () =>
        {}).constructor;
        try
        {
            await new AsyncFunction(...Object.keys(bindings), body)(...Object.values(bindings));
        }
        catch (error)
        {
            assert.equal(error, failure);
        }
        finalizeBrowserContractReceipt(receipt, { primary: { status: 'failure', classification: 'product',
            error: { message: failure.message } }, cleanup: { status: 'success' } });
        assert.equal(receipt.attemptStatus, 'failed-no-retry');
        assert.equal(receipt.qualificationEligible, false);
        assert.equal(receipt.cleanFirstAttempt, false);
        assert.equal(receipt.scenarios[0].classification, 'product');
        assert.equal(closed, laterCalls + 1);
        assert.equal(clockApplications, closed, 'the real temporal adapter must run before every model scenario');
        return { laterCalls, receipt };
    };
    const actual = await execute(loop);
    assert.equal(actual.laterCalls, 0);
    assert.equal(actual.receipt.scenarios[1].status, 'pending');
    const mutated = await execute(loop.replace('                throw error;', '                /* mutation: keep running */'));
    assert.equal(mutated.laterCalls, 1, 'mutation must expose execution of the forbidden later scenario');
    if (process.env.FSUSBLOG_FIRST_STOP_FIXTURE_RECEIPT)
    {
        fs.writeFileSync(process.env.FSUSBLOG_FIRST_STOP_FIXTURE_RECEIPT, `${JSON.stringify({
            schema: 'fsusblog.browser-first-stop-negative-fixture.v1', evidenceClass: 'checker-selftest',
            qualificationEligible: false, runner: path.join(root, 'tests/browser-contract/run.mjs'),
            runnerFileDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
            laterScenarioCalls: actual.laterCalls, mutationLaterScenarioCalls: mutated.laterCalls,
            receipt: actual.receipt
        }, null, 2)}\n`);
    }
});
