import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const fs = await import('node:fs');
const { createFixtureArtifactOutlet, readPrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));

const {classifyDevFixtureReceiptTransition} = await import(new URL('../../tools/test-fixtures/cli.mjs', import.meta.url));
const {buildProducerDag} = await import(new URL('../../tools/test-fixtures/dag.mjs', import.meta.url));
const {cleanup, createProducerContext, plan, prepare, verify} = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const {createTerminalState} = await import(new URL('../../tools/test-fixtures/terminal-state.mjs', import.meta.url));
const {fixtureCatalogDigest, readFixtureCatalogs} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const {validateFixtureReceipt} = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const {currentSourceState} = await import(new URL('../../tools/test/runtime-cache-evidence-contract.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixtureCliBoundaryStub(context)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-fixture-cli-boundary-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, 'node-stub');
    const capture = path.join(directory, 'invocation.json');
    const executionCapture = path.join(directory, 'execution-identity.json');
    const cliCallCapture = path.join(directory, 'cli-called');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const [entry, ...args] = process.argv.slice(2)
const fail = (message) => {
  process.stderr.write(message + '\\n')
  process.exit(31)
}
if (entry === '-e') {
  eval(args[0])
  return
}
if (String(entry).endsWith('/tests/frontend/support/fixture-paths.mjs')) {
  const fixtureRoot = process.env.FSUSBLOG_TEST_STUB_FIXTURE_ROOT
  if (!fixtureRoot) fail('fixture root is required')
  process.stdout.write(fixtureRoot)
  process.exit(0)
}
if (entry === '-e' || entry === '-' || entry === '--input-type=module') {
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
if (!String(entry).endsWith('/tools/test-fixtures/cli.mjs')) fail('unexpected node entry: ' + entry)
if (process.env.FSUSBLOG_TEST_STUB_CLI_CALL_CAPTURE) {
  fs.writeFileSync(process.env.FSUSBLOG_TEST_STUB_CLI_CALL_CAPTURE, 'fixture-cli-called')
}
const options = { _: [] }
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (!argument.startsWith('--')) {
    options._.push(argument)
    continue
  }
  const separator = argument.indexOf('=')
  if (separator >= 0) {
    options[argument.slice(2, separator)] = argument.slice(separator + 1)
    continue
  }
  const key = argument.slice(2)
  const next = args[index + 1]
  if (next != null && !next.startsWith('--')) {
    options[key] = next
    index += 1
  } else {
    options[key] = true
  }
}
if (process.env.FSUSBLOG_TEST_STUB_VERIFIED_PRIMARY === '1') {
  // Shell argument/path contract only: these markers are deliberately not production receipts.
  const command = options._[0]
  fs.appendFileSync(process.env.FSUSBLOG_TEST_STUB_CAPTURE, JSON.stringify(options) + '\\n')
  const write = (file, document) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(document), { mode: 0o600, flag: 'wx' })
  }
  if (command === 'run') {
    if (!options['artifact-dir'] || options['artifact-consumer-id'] !== options['runtime-cache-consumer-id']) fail('sealed artifact args missing')
    if (options['skip-verify'] || !options['fixture-receipt']) fail('verified primary marker required')
    fs.mkdirSync(options['artifact-dir'], { mode: 0o700 })
    write(options['prepare-state'], { unitModel: true, schema: 'fsusblog.fixture-prepare-state.v1' })
    write(options['fixture-receipt'], { unitModel: true, schema: 'fsusblog.fixture-receipt.v2' })
    if (options['runtime-cache-consumer-id'] === 'runtime-cache-hot-featured-frame') {
      write(path.join(options['runtime-cache-input-dir'], 'prerequisite-inputs.json'), { unitModel: true })
    }
    if (process.env.FSUSBLOG_TEST_STUB_FAIL_AFTER_PRIMARY === '1') fail('original primary boundary failure')
  } else if (command === 'project-verified') {
    write(options.out, { unitModel: true })
  } else if (command === 'receipt-digest') {
    process.stdout.write('sha256:' + 'f'.repeat(64))
  } else if (command === 'project-runtime-cache-input') {
    write(options.out, { unitModel: true, receipt: options.receipt, prepareState: options['prepare-state'],
      publicProjection: options['public-projection'], consumerId: options['consumer-id'] })
  } else fail('unexpected verified primary command: ' + command)
  process.exit(0)
}
if (options._[0] !== 'run') fail('fixture CLI run command is required')
if (Object.hasOwn(options, 'artifact-dir') || Object.hasOwn(options, 'artifact-consumer-id')) fail('prepared-only boundary must not enable outlet')
if (!options.profile || options.profile === 'none') fail('non-none profile is required')
if (options['skip-verify'] !== true) fail('--skip-verify is required')
if (Object.hasOwn(options, 'out')) fail('--out incorrectly requests a FixtureReceipt')
if (Object.hasOwn(options, 'fixture-receipt')) fail('--fixture-receipt is forbidden for non-none prepare')
if (typeof options['prepare-state'] !== 'string' || !options['prepare-state']) {
  fail('--prepare-state is required')
}
const prepareState = {
  schema: 'fsusblog.fixture-prepare-state.v1',
  terminalState: 'prepared',
  profileId: options.profile
}
fs.mkdirSync(path.dirname(options['prepare-state']), { recursive: true })
fs.writeFileSync(options['prepare-state'], JSON.stringify(prepareState), { mode: 0o600 })
fs.writeFileSync(process.env.FSUSBLOG_TEST_STUB_CAPTURE, JSON.stringify({
  profileId: options.profile,
  prepareState: options['prepare-state'],
  skipVerify: options['skip-verify'],
  fixtureReceiptRequested: Object.hasOwn(options, 'fixture-receipt'),
  outputRequested: Object.hasOwn(options, 'out'),
  publicContentSecret: process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET,
  authSecret: process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
}))
if (process.env.FSUSBLOG_TEST_STUB_EXECUTION_CAPTURE) {
  fs.writeFileSync(process.env.FSUSBLOG_TEST_STUB_EXECUTION_CAPTURE, JSON.stringify({
    namespace: options.namespace,
    runId: options['run-id'],
    sourceCommit: options['source-commit'],
    sourceFingerprint: options['source-fingerprint'],
    serviceGeneration: options['service-generation']
  }))
}
process.stdout.write(JSON.stringify(prepareState) + '\\n')
`);
    chmodSync(executable, 0o755);
    return { capture, executionCapture, cliCallCapture, directory, executable };
}

function mockPort(spec, hooks = {})
{
    const calls = { prepare: 0, verify: 0, cleanup: 0, prepareOrder: [] };
    const port = {
        id: spec.id,
        strategy: spec.strategy,
        providedCapabilities: [...spec.provides],
        consumedCapabilities: [...spec.consumes],
        identityRoleRequests: hooks.identityRoleRequests ?? [],
        calls,
        async prepare(context, signal)
        {
            calls.prepare += 1;
            calls.prepareOrder.push(spec.id);
            if (hooks.onPrepare)
            {
                const result = await hooks.onPrepare(context, signal, calls);
                return {
                    ...result,
                    variantIds: result?.variantIds ?? context.variantPlan.variants.map((item) => item.id),
                    producerVariantPlanDigest: result?.producerVariantPlanDigest
            ?? context.variantPlan.producerVariantPlanDigest
                };
            }
            if (signal?.aborted)
            {
                throw signal.reason ?? new Error('aborted');
            }
            return {
                producerId: spec.id,
                strategy: spec.strategy,
                ok: true,
                variantIds: context.variantPlan.variants.map((item) => item.id),
                producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest
            };
        },
        async verify(context, receipt)
        {
            calls.verify += 1;
            if (hooks.onVerify)
            {
                return hooks.onVerify(context, receipt, calls);
            }
            return { ok: true, producerId: spec.id };
        },
        async cleanup(context, receipt, signal)
        {
            calls.cleanup += 1;
            if (hooks.onCleanup)
            {
                return hooks.onCleanup(context, receipt, signal, calls);
            }
        }
    };
    return port;
}

function portsForPlan(planDocument, hookMap = {})
{
    return planDocument.producerSpecs.map((spec) => mockPort(spec, hookMap[spec.id]));
}

for (const cooperative of [true, false])
{
    test(`canonical verify passes the original signal and retains cancellation recovery (cooperative=${cooperative})`, async () =>
    {
        const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
        const ports = portsForPlan(planned);
        const prepared = await prepare(planned, ports);
        const originalState = JSON.stringify(prepared);
        const controller = new AbortController();
        const reason = new Error('cancel-during-canonical-verify');
        let verifies = 0;
        ports[0].verify = async (_context, _result, signal) =>
        {
            verifies += 1;
            if (cooperative)
            {
                assert.equal(signal, controller.signal);
            }
            queueMicrotask(() => controller.abort(reason));
            await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
            if (cooperative)
            {
                signal.throwIfAborted();
            }
            return { ok: true, producerId: 'auth-session' };
        };
        await assert.rejects(verify(prepared, ports, { signal: controller.signal }), (error) =>
        {
            assert.equal(error.cause, reason);
            assert.equal(error.receipt.schema, 'fsusblog.fixture-prepare-state.v1');
            assert.equal(error.receipt.terminalState, 'failed');
            assert.equal(error.receipt.primaryFailure.message, reason.message);
            assert.deepEqual(error.receipt.producerReceipts, []);
            const failureReceipt = validateFixtureReceipt(error.fixtureReceipt);
            assert.equal(failureReceipt.terminalStatus, 'failed');
            assert.equal(failureReceipt.primaryFailure.message, reason.message);
            assert.deepEqual(failureReceipt.producerReceipts, []);
            return true;
        });
        assert.equal(verifies, 1);
        assert.equal(ports[0].calls.cleanup, 0);
        assert.equal(JSON.stringify(prepared), originalState);
    });
}

test('none plan has empty DAG and prepare is zero-mutation', async () =>
{
    const planned = plan({ profileId: 'none', profileSource: 'dev-cli' });
    assert.deepEqual(planned.producers, []);
    assert.deepEqual(planned.order, []);
    assert.deepEqual(planned.waves, []);
    assert.equal(planned.mutationPolicy, 'zero-mutation');
    const receipt = await prepare(planned, []);
    assert.equal(receipt.schema, 'fsusblog.fixture-prepare-state.v1');
    assert.equal(receipt.terminalState, 'prepared');
    assert.equal(receipt.zeroData, true);
    assert.deepEqual(receipt.mutations, []);
    const verified = await verify(receipt, []);
    assert.equal(verified.schema, 'fsusblog.fixture-receipt.v2');
    assert.equal(verified.terminalStatus, 'verified');
    assert.equal(verified.zeroBusinessMutation, true);
    assert.deepEqual(verified.orderedProducerReceiptDigests, []);
});

test('profile expands to a single producer DAG resolver', () =>
{
    const catalogs = readFixtureCatalogs();
    const dag = buildProducerDag('scale-xs', catalogs);
    assert.deepEqual(dag.producers.map((item) => item.id), ['public-content', 'scale-data']);
    assert.deepEqual(dag.waves, [['public-content'], ['scale-data']]);
    const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' });
    assert.deepEqual(planned.producers, dag.producers.map((item) => item.id));
    assert.deepEqual(planned.order, dag.order);
});

test('auth-session receives sealed consumer identity allocation requests from planned ports', async () =>
{
    const planned = plan({ profileId: 'account-messaging', profileSource: 'dev-cli' });
    let authRequests = null;
    const request = {
        ownerProducerId: 'auth-session',
        consumerProducerId: 'account-messaging',
        role: 'primary-recipient',
        capabilityId: 'auth.user.active'
    };
    const ports = portsForPlan(planned, {
        'auth-session': {
            onPrepare: async (context) =>
            {
                authRequests = context.identityRoleRequests;
                return { ok: true };
            }
        },
        'account-messaging': { identityRoleRequests: [request] }
    });
    await prepare(planned, ports);
    assert.deepEqual(authRequests, [request]);

    ports.find((port) => port.id === 'account-messaging').identityRoleRequests = [{
        ...request,
        capabilityId: 'auth.user.deleted'
    }];
    await assert.rejects(() => prepare(planned, ports), /catalog-declared consumed capabilities/u);
});

test('producer dependency cycle fails before mutation', () =>
{
    const catalogs = readFixtureCatalogs();
    const mutated = structuredClone(catalogs);
    const auth = mutated.producer.producers.find((item) => item.id === 'auth-session');
    const messaging = mutated.producer.producers.find((item) => item.id === 'account-messaging');
    // Force a cycle between auth-session and account-messaging via consumes.
    auth.consumes = ['messages.thread'];
    auth.stateDomains = [...new Set([...auth.stateDomains, ...messaging.stateDomains])].sort();
    assert.throws(
        () => buildProducerDag('account-messaging', mutated),
        /dependency cycle|not in the producer DAG|cycle/i
    );
});

test('two producers providing the same capability fail closed', () =>
{
    const catalogs = readFixtureCatalogs();
    const mutated = structuredClone(catalogs);
    const scale = mutated.producer.producers.find((item) => item.id === 'scale-data');
    scale.provides = [...scale.provides, 'public.article.published'].sort();
    assert.throws(
        () => buildProducerDag('public-minimal', mutated),
        /two producers provide the same capability|exactly owner|public\.article\.published/
    );
});

test('API producer failure does not run later DB-style producers and records one strategy', async () =>
{
    const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' });
    const ports = portsForPlan(planned, {
        'public-content': {
            onPrepare: async () =>
            {
                throw new Error('admin API seed failed');
            }
        },
        'scale-data': {
            onPrepare: async () =>
            {
                throw new Error('scale should not run');
            }
        }
    });
    await assert.rejects(() => prepare(planned, ports), /admin API seed failed/);
    const publicPort = ports.find((item) => item.id === 'public-content');
    const scalePort = ports.find((item) => item.id === 'scale-data');
    assert.equal(publicPort.calls.prepare, 1);
    assert.equal(scalePort.calls.prepare, 0);
    assert.equal(publicPort.strategy, 'transaction-fixture');
});

test('producer cannot return a fallback strategy', async () =>
{
    const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' });
    const ports = portsForPlan(planned, {
        'public-content': {
            onPrepare: async () => ({ strategy: 'public-api-scenario', ok: true })
        }
    });
    await assert.rejects(() => prepare(planned, ports), /cannot fallback|strategy/);
});

test('producer output must exactly declare registered planned variants and entity bindings', async () =>
{
    const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' });
    const unregistered = portsForPlan(planned, {
        'public-content': {
            onPrepare: async () => ({
                ok: true,
                strategy: 'transaction-fixture',
                variantIds: ['unregistered.fixture.variant']
            })
        }
    });
    await assert.rejects(
        () => prepare(planned, unregistered),
        /output variant IDs must exactly match/
    );

    const missingVariantEvidence = portsForPlan(planned, {
        'public-content': {
            onPrepare: async (context) => ({
                ok: true,
                enforceVariantEvidence: true,
                strategy: 'transaction-fixture',
                variantIds: context.variantPlan.variants.map((item) => item.id),
                entityIdentities: [{ kind: 'article', id: '101', variantId: context.variantPlan.variants[0].id }],
                observations: { database: { entities: [{ kind: 'article', id: '101', variantId: context.variantPlan.variants[0].id, fields: {} }] } }
            })
        }
    });
    await assert.rejects(() => prepare(planned, missingVariantEvidence), /has no exact entity binding or live evidence/);

    const missingEntityBinding = portsForPlan(planned, {
        'public-content': {
            onPrepare: async (context) => ({
                ok: true,
                strategy: 'transaction-fixture',
                variantIds: context.variantPlan.variants.map((item) => item.id),
                entityIdentities: [{ kind: 'article', id: '101' }]
            })
        }
    });
    await assert.rejects(
        () => prepare(planned, missingEntityBinding),
        /has no registered planned variant/
    );

    const wrongDigest = portsForPlan(planned, {
        'public-content': {
            onPrepare: async (context) => ({
                ok: true,
                strategy: 'transaction-fixture',
                variantIds: context.variantPlan.variants.map((item) => item.id),
                producerVariantPlanDigest: `sha256:${'0'.repeat(64)}`
            })
        }
    });
    await assert.rejects(
        () => prepare(planned, wrongDigest),
        /typed variant plan digest does not match/
    );
});

test('AbortSignal stops prepare and runs reverse-topo cleanup of successes', async () =>
{
    const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' });
    const controller = new AbortController();
    const ports = portsForPlan(planned, {
        'public-content': {
            onPrepare: async () => ({ ok: true, producerId: 'public-content', strategy: 'transaction-fixture' })
        },
        'scale-data': {
            onPrepare: async (_context, signal) =>
            {
                controller.abort(new Error('cancelled-by-test'));
                if (signal.aborted)
                {
                    throw signal.reason;
                }
                return { ok: true };
            }
        }
    });
    await assert.rejects(() => prepare(planned, ports, controller.signal), /cancelled-by-test|aborted/);
    const publicPort = ports.find((item) => item.id === 'public-content');
    assert.equal(publicPort.calls.prepare, 1);
    assert.equal(publicPort.calls.cleanup, 1);
});

test('cleanup failure does not overwrite primary failure', async () =>
{
    const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' });
    const ports = portsForPlan(planned, {
        'public-content': {
            onPrepare: async () => ({ ok: true, producerId: 'public-content', strategy: 'transaction-fixture' }),
            onCleanup: async () =>
            {
                throw new Error('cleanup boom');
            }
        },
        'scale-data': {
            onPrepare: async () =>
            {
                throw new Error('primary boom');
            }
        }
    });
    try
    {
        await prepare(planned, ports);
        assert.fail('expected prepare to throw');
    }
    catch (error)
    {
        assert.match(error.message, /primary boom/);
        assert.equal(error.receipt.primaryFailure.message, 'primary boom');
        assert.equal(error.receipt.cleanupFailure.message, 'cleanup boom');
        assert.notEqual(error.receipt.terminalState, 'prepared');
    }
});

test('none profile rejects forced producer registration', () =>
{
    assert.throws(
        () => plan({ profileId: 'none', profileSource: 'dev-cli' }, { forcedProducers: ['auth-session'] }),
        /none profile cannot register producers/
    );
});

test('producer env strategy override is rejected by default ports', async () =>
{
    const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' });
    process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED = '1';
    try
    {
        const { createPublicContentPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
        const port = createPublicContentPort();
        await assert.rejects(
            () => port.prepare({
                plan: planned,
                producerOutputs: {},
                handles: {}
            }),
            /strategy\/env override|FSUSBLOG_FORCE_DIRECT_DB_SEED/
        );
    }
    finally
    {
        delete process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED;
    }
});

test('account-messaging cutover refuses structural preparation without verified identity facts', async () =>
{
    const planned = plan({ profileId: 'account-messaging', profileSource: 'dev-cli' });
    const { createAccountMessagingPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
    const port = createAccountMessagingPort();
    const context = createProducerContext({
        plan: planned,
        producerId: 'account-messaging',
        producerOutputs: {
            'auth-session': { producerId: 'auth-session', postconditions: ['user-active'] }
        }
    });
    await assert.rejects(
        () => port.prepare(context),
        /requires #1713 exact auth-session prepare references/u
    );
});

test('state-domain conflicting producers are not scheduled in the same wave', () =>
{
    const dag = buildProducerDag('account-messaging');
    // Account preference and messaging producers both consume the owned account
    // namespace, so they must not mutate it in the same wave.
    const waveSets = dag.waves.map((wave) => new Set(wave));
    for (const wave of waveSets)
    {
        assert.equal(
            wave.has('account-messaging') && wave.has('account-profile-preferences'),
            false,
            'account messaging and profile/preference producers must not share a wave'
        );
    }
});

test('partial result cannot be published as prepared', () =>
{
    const terminal = createTerminalState('planned');
    terminal.transition('preparing');
    assert.throws(() => terminal.assertPublishable('prepared'), /partial result cannot be published as prepared/);
    terminal.transition('failed');
    assert.throws(() => terminal.assertPublishable('prepared'), /partial result cannot be published as prepared/);
});

test('matrix sealed digests fail closed on catalog drift', () =>
{
    const digest = fixtureCatalogDigest();
    const live = plan({ profileId: 'none', profileSource: 'dev-cli' });
    assert.throws(
        () => plan({
            profileId: 'none',
            profileSource: 'matrix',
            sealed: {
                fixtureProfileId: 'none',
                fixtureCatalogDigest: 'sha256:deadbeef',
                expandedCapabilityDigest: digest,
                fixtureVariantIds: [],
                fixtureVariantPlanDigest: live.variantPlanDigest,
                executionClass: 'runtime'
            }
        }),
        /catalog digest drifted|fixture catalog digest/
    );
});

test('verify and cleanup succeed for prepared mock plan with observations', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    const privateHandles = { localAuthFixtureSecret: 'private-runtime-only' };
    let prepareSecret = null;
    let verifySecret = null;
    const ports = portsForPlan(planned, {
        'auth-session': {
            onPrepare: async (context) =>
            {
                prepareSecret = context.handles.localAuthFixtureSecret;
                return ({
                    ok: true,
                    producerId: 'auth-session',
                    strategy: 'transaction-fixture',
                    entityIdentities: [
                        { kind: 'user', id: 'u1', variantId: 'canonical.auth.user.active' },
                        { kind: 'admin', id: 'a1', variantId: 'canonical.auth.admin.full-permission' },
                        { kind: 'session', id: 's1', variantId: 'canonical.session.single-device' }
                    ],
                    observations: {
                        database: {
                            namespace: null,
                            schemaIdentity: 'public',
                            entities: [
                                {
                                    kind: 'user',
                                    id: 'u1',
                                    variantId: 'canonical.auth.user.active',
                                    postconditionId: 'user-active',
                                    fields: { status: 'active', deleted: false }
                                },
                                {
                                    kind: 'admin',
                                    id: 'a1',
                                    variantId: 'canonical.auth.admin.full-permission',
                                    postconditionId: 'admin-full-permission',
                                    fields: { permission: 'full' }
                                },
                                {
                                    kind: 'session',
                                    id: 's1',
                                    variantId: 'canonical.session.single-device',
                                    postconditionId: 'session-single-device',
                                    fields: {
                                        state: 'active',
                                        live: true,
                                        databaseStateVerified: true,
                                        claimStateVerified: true,
                                        cacheStateVerified: true
                                    }
                                }
                            ]
                        },
                        redis: {
                            namespace: null,
                            keys: [
                                { domain: 'redis.session', key: 'session:s1', present: true, sessionRevoked: false }
                            ]
                        },
                        cache: { namespace: null, entries: [] }
                    }
                });
            },
            onVerify: async (context) =>
            {
                verifySecret = context.handles.localAuthFixtureSecret;
                return { ok: true, producerId: 'auth-session' };
            }
        }
    });
    const prepared = await prepare(planned, ports, undefined, { handles: privateHandles });
    assert.equal(prepared.schema, 'fsusblog.fixture-prepare-state.v1');
    assert.equal(prepared.terminalState, 'prepared');
    assert.deepEqual(prepared.producerReceipts, []);
    assert.equal(prepareSecret, privateHandles.localAuthFixtureSecret);
    assert.doesNotMatch(JSON.stringify(prepared), /private-runtime-only/u);
    const verified = await verify(prepared, ports, { handles: privateHandles });
    assert.equal(verifySecret, privateHandles.localAuthFixtureSecret);
    assert.doesNotMatch(JSON.stringify(verified), /private-runtime-only/u);
    assert.equal(verified.schema, 'fsusblog.fixture-receipt.v2');
    assert.equal(verified.terminalStatus, 'verified');
    assert.ok(verified.receiptDigest.startsWith('sha256:'));
    assert.equal(verified.producerReceipts.length, 1);
    const cleaned = await cleanup(verified, ports);
    assert.equal(cleaned.terminalState, 'cleaned');
    assert.equal(ports[0].calls.cleanup, 1);
});

test('verify fails closed without service observations', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    const ports = portsForPlan(planned);
    const prepared = await prepare(planned, ports);
    await assert.rejects(() => verify(prepared, ports), /missing database\/redis\/cache observations|verify failed|postcondition/);
});

test('shell dual paths and prepare package scripts are gone', () =>
{
    const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const start = readFileSync(path.join(root, 'tools/dev/start.sh'), 'utf8');
    const suite = readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    const fixtureCli = readFileSync(path.join(root, 'tools/test-fixtures/cli.mjs'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const publicProducer = readFileSync(path.join(root, 'tools/test-fixtures/producers/public-content-producer.mjs'), 'utf8');

    for (const source of [bootstrap, start, suite])
    {
        assert.match(source, /tools\/test-fixtures\/cli\.mjs/);
        assert.doesNotMatch(source, /--skip-verify\s+--out/u);
        assert.doesNotMatch(source, /\bPrepareAuthFixturesOnce\b/);
        assert.doesNotMatch(source, /\bPreparePublicFixturesOnce\b/);
    }
    // Comment may mention the deleted name; require no callable dual orchestrator.
    assert.doesNotMatch(suite, /^\s*PrepareRuntimeFixturesOnce\b/mu);
    assert.doesNotMatch(suite, /\bPrepareRuntimeFixturesOnce\s*\(/u);
    assert.match(suite, /\bInvokeLaneFixtureOrchestrator\b/);
    assert.doesNotMatch(bootstrap, /\bPrepareFixtures\s*\(/);
    assert.doesNotMatch(bootstrap, /RunParallel "bootstrap-runtime-fixtures"/);
    assert.equal(pkg.scripts['prepare:binary-smoke:auth-users'], undefined);
    assert.equal(pkg.scripts['prepare:playwright:fixtures'], undefined);
    assert.equal(pkg.scripts['prepare:playwright:sessions'], undefined);
    assert.doesNotMatch(publicProducer, /using direct DB seed|seedPublicFixturesViaApi|buildSeededArticleFallback/);
    assert.match(publicProducer, /transaction-fixture/);
    assert.match(
        fixtureCli,
        /FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET[\s\S]*handles\.localPublicContentFixtureSecret/u
    );
});

test('acceptance bootstrap non-none boundary writes prepare-state without requesting FixtureReceipt', (context) =>
{
    const stub = fixtureCliBoundaryStub(context);
    const fixtureRoot = path.join(stub.directory, 'bootstrap-fixtures');
    const namespace = 'bootstrap-fixture-boundary';
    const result = spawnSync('bash', ['-c', `
export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1
export FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1
export FSUSBLOG_TEST_NAMESPACE="${namespace}"
export FSUSBLOG_TEST_RUN_ID=bootstrap-fixture-boundary-run
export FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT="$FSUSBLOG_TEST_STUB_ROOT/acceptance"
export FSUSBLOG_ACCEPTANCE_ENV_ROOT="$FSUSBLOG_TEST_STUB_ROOT/env"
export FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT="$FSUSBLOG_TEST_STUB_ROOT/bootstrap-fixtures"
export FSUSBLOG_TEST_SOURCE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export FSUSBLOG_TEST_SOURCE_FINGERPRINT=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export FSUSBLOG_FIXTURE_SERVICE_GENERATION=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
export FSUSBLOG_RELEASE_ID=20260826000000-aaaaaaaaaaaa
export FSUSBLOG_TEST_HUMAN_READ_PROOF_SIGNING_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export FSUSBLOG_TEST_HUMAN_READ_PROOF_DEDUP_KEY=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
export FSUSBLOG_TEST_READ_ANALYTICS_NOISE_KEY=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=
export FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET=public-content-secret
export FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET=auth-secret
export FSUSBLOG_NODE="$FSUSBLOG_TEST_STUB_NODE"
source ./tools/bootstrap-acceptance-env.sh
FIXTURE_PROFILE_ID=acceptance-representative
FIXTURE_PROFILE_SOURCE=dev-cli
FIXTURE_PRODUCER_IDS=auth-session
FIXTURE_REQUIRES_DEMO=0
FIXTURE_REQUIRES_SECURITY_RESET=0
InvokeFixtureOrchestrator
`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            ...process.env,
            FSUSBLOG_TEST_STUB_CAPTURE: stub.capture,
            FSUSBLOG_TEST_STUB_NODE: stub.executable,
            FSUSBLOG_TEST_STUB_ROOT: stub.directory,
            FSUSBLOG_RELEASE_ID: 'fixture-release-id',
            FSUSBLOG_TEST_HUMAN_READ_PROOF_SIGNING_KEY: 'fixture-signing-key',
            FSUSBLOG_TEST_HUMAN_READ_PROOF_DEDUP_KEY: 'fixture-dedup-key',
            FSUSBLOG_TEST_READ_ANALYTICS_NOISE_KEY: 'fixture-noise-key'
        }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const prepareState = path.join(fixtureRoot, namespace, 'prepare-state.json');
    assert.equal(existsSync(prepareState), true);
    assert.equal(existsSync(path.join(fixtureRoot, namespace, 'fixture-receipt.json')), false);
    assert.deepEqual(JSON.parse(readFileSync(prepareState, 'utf8')), {
        schema: 'fsusblog.fixture-prepare-state.v1',
        terminalState: 'prepared',
        profileId: 'acceptance-representative'
    });
    assert.deepEqual(JSON.parse(readFileSync(stub.capture, 'utf8')), {
        profileId: 'acceptance-representative',
        prepareState,
        skipVerify: true,
        fixtureReceiptRequested: false,
        outputRequested: false,
        publicContentSecret: 'public-content-secret',
        authSecret: 'auth-secret'
    });
});

for (const [boundary, consumerId, profileId] of [
    ['bootstrap', 'runtime-cache-pagination', 'runtime-cache-pagination'],
    ['lane', 'runtime-cache-pagination', 'runtime-cache-pagination'],
    ['bootstrap', 'runtime-cache-hot-featured-frame', 'public-content-lifecycle'],
    ['lane', 'runtime-cache-hot-featured-frame', 'public-content-lifecycle']
])
{
    test(`${boundary} ${consumerId} sealed primary boundary owns fresh invocation markers and exact typed consumer paths`, (context) =>
    {
        const stub = fixtureCliBoundaryStub(context);
        const fixtureRoot = path.join(stub.directory, 'primary-fixtures');
        const env = { ...process.env, FSUSBLOG_TEST_STUB_CAPTURE: stub.capture, FSUSBLOG_TEST_STUB_NODE: stub.executable,
            FSUSBLOG_TEST_STUB_ROOT: stub.directory, FSUSBLOG_TEST_STUB_FIXTURE_ROOT: fixtureRoot,
            FSUSBLOG_TEST_STUB_VERIFIED_PRIMARY: '1', FSUSBLOG_NODE: stub.executable,
            FSUSBLOG_TEST_NAMESPACE: 'primary-boundary', FSUSBLOG_TEST_RUN_ID: 'primary-boundary-unit-model',
            FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
            FSUSBLOG_FIXTURE_SERVICE_GENERATION: 'c'.repeat(64), FSUSBLOG_TEST_SESSION_ISOLATION: '0',
            FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: profileId,
            FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: consumerId, FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'matrix',
            FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST: `sha256:${'d'.repeat(64)}`,
            FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST: `sha256:${'e'.repeat(64)}`,
            FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: consumerId === 'runtime-cache-pagination' ? '[]'
                : JSON.stringify([{ id: 'typed-admin-session', profileId: 'auth-basic', producerId: 'auth-session',
                    capabilityId: 'auth.admin.full-permission', semanticRole: 'admin.full-permission', consumerId }]),
            FSUSBLOG_BOOTSTRAP_SOURCE_ONLY: '1', FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
            FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT: path.join(stub.directory, 'acceptance'),
            FSUSBLOG_ACCEPTANCE_ENV_ROOT: path.join(stub.directory, 'env'),
            FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: fixtureRoot, FSUSBLOG_RELEASE_ID: '20260826000000-aaaaaaaaaaaa',
            FSUSBLOG_TEST_HUMAN_READ_PROOF_SIGNING_KEY: `${'A'.repeat(43)}=`,
            FSUSBLOG_TEST_HUMAN_READ_PROOF_DEDUP_KEY: `${'B'.repeat(43)}=`,
            FSUSBLOG_TEST_READ_ANALYTICS_NOISE_KEY: `${'C'.repeat(43)}=`,
            FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET: 'unit-public-secret', FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET: 'unit-auth-secret' };
        const setup = boundary === 'bootstrap'
            ? `source ./tools/bootstrap-acceptance-env.sh
FIXTURE_PROFILE_ID=${profileId}
FIXTURE_PROFILE_SOURCE=matrix
FIXTURE_PRODUCER_IDS=public-content
FIXTURE_REQUIRES_DEMO=0
FIXTURE_REQUIRES_PUBLIC=1
FIXTURE_REQUIRES_SECURITY_RESET=0`
            : 'source ./tools/test/lanes/_suite-support.sh';
        const command = boundary === 'bootstrap' ? 'InvokeFixtureOrchestrator' : 'InvokeLaneFixtureOrchestrator';
        const result = spawnSync('bash', ['-c', `${setup}\n${command}\n${command}\nprintf '%s\\n%s' "$FSUSBLOG_FIXTURE_ROOT" "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR"`],
            { cwd: root, encoding: 'utf8', timeout: 15_000, env });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const calls = readFileSync(stub.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const runs = calls.filter((call) => call._[0] === 'run');
        const projections = calls.filter((call) => call._[0] === 'project-runtime-cache-input');
        assert.equal(runs.length, 2);
        assert.equal(projections.length, 2);
        assert.notEqual(runs[0]['fixture-receipt'], runs[1]['fixture-receipt']);
        assert.notEqual(runs[0]['artifact-dir'], runs[1]['artifact-dir']);
        for (const [index, call] of runs.entries())
        {
            const invocation = path.dirname(call['fixture-receipt']);
            assert.equal(fs.statSync(invocation).mode & 0o777, 0o700);
            assert.equal(fs.statSync(call['artifact-dir']).mode & 0o777, 0o700);
            assert.equal(call['artifact-dir'], path.join(invocation, 'artifacts'));
            assert.equal(call['artifact-consumer-id'], env.FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID);
            assert.equal(call['runtime-cache-consumer-id'], env.FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID);
            assert.equal(call['prepare-state'], path.join(invocation, 'prepare-state.json'));
            assert.equal(call['private-carrier-dir'], path.join(invocation, 'auth-private-carriers'));
            assert.equal(call['public-projection'], path.join(invocation, 'public-content-projection.json'));
            assert.equal(projections[index].receipt, call['fixture-receipt']);
            assert.equal(projections[index]['prepare-state'], call['prepare-state']);
            assert.equal(projections[index]['public-projection'], call['public-projection']);
            assert.equal(projections[index]['consumer-id'], call['artifact-consumer-id']);
            assert.equal(Object.hasOwn(projections[index], 'prerequisite-inputs'), consumerId === 'runtime-cache-hot-featured-frame');
            if (consumerId === 'runtime-cache-hot-featured-frame')
            {
                assert.equal(projections[index]['prerequisite-inputs'], path.join(call['runtime-cache-input-dir'], 'prerequisite-inputs.json'));
                assert.equal(JSON.parse(readFileSync(projections[index]['prerequisite-inputs'])).unitModel, true);
            }
            assert.equal(projections[index].out, path.join(call['runtime-cache-input-dir'], `${call['artifact-consumer-id']}.json`));
            assert.equal(JSON.parse(readFileSync(call['fixture-receipt'])).unitModel, true);
        }
        if (boundary === 'bootstrap')
        {
            const writtenEnv = readFileSync(path.join(stub.directory, 'env', 'primary-boundary.env'), 'utf8');
            assert.ok(writtenEnv.includes(`FSUSBLOG_FIXTURE_ROOT=${path.dirname(runs[1]['fixture-receipt'])}\n`));
            assert.ok(writtenEnv.includes(`FSUSBLOG_PUBLIC_ID_PROJECTION_FILE=${runs[1]['public-projection']}\n`));
            assert.ok(writtenEnv.includes(`FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR=${runs[1]['runtime-cache-input-dir']}\n`));
        }
        const failed = spawnSync('bash', ['-c', `${setup}\n${command}`], { cwd: root, encoding: 'utf8', timeout: 15_000,
            env: { ...env, FSUSBLOG_TEST_STUB_FAIL_AFTER_PRIMARY: '1' } });
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /original primary boundary failure/u);
        const last = readFileSync(stub.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).at(-1);
        assert.equal(last._[0], 'run');
        assert.notEqual(last['prepare-state'], runs[0]['prepare-state']);
        assert.equal(existsSync(last['prepare-state']), true);
        assert.equal(JSON.parse(readFileSync(runs[0]['fixture-receipt'])).unitModel, true);
    });
}

test('shared lane non-none boundary writes prepare-state without requesting FixtureReceipt', (context) =>
{
    const stub = fixtureCliBoundaryStub(context);
    const fixtureRoot = path.join(stub.directory, 'lane-fixtures');
    const source = currentSourceState(root);
    // Read the real source owner; service generation remains an explicit unit model, not runtime authority.
    const serviceGeneration = `sha256:${'c'.repeat(64)}`;
    const result = spawnSync('bash', ['-c', `
export FSUSBLOG_NODE="$FSUSBLOG_TEST_STUB_NODE"
export FSUSBLOG_TEST_NAMESPACE=lane-fixture-boundary
export FSUSBLOG_TEST_RUN_ID=lane-fixture-boundary-run
export FSUSBLOG_TEST_SESSION_ISOLATION=0
export FSUSBLOG_SEALED_FIXTURE_PROFILE_ID=acceptance-representative
export FSUSBLOG_FIXTURE_PROFILE_SOURCE=dev-cli
source ./tools/test/lanes/_suite-support.sh
InvokeLaneFixtureOrchestrator
`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            ...process.env,
            FSUSBLOG_TEST_STUB_CAPTURE: stub.capture,
            FSUSBLOG_TEST_STUB_FIXTURE_ROOT: fixtureRoot,
            FSUSBLOG_TEST_STUB_NODE: stub.executable,
            FSUSBLOG_TEST_STUB_EXECUTION_CAPTURE: stub.executionCapture,
            FSUSBLOG_TEST_STUB_CLI_CALL_CAPTURE: stub.cliCallCapture,
            FSUSBLOG_TEST_SOURCE_COMMIT: source.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: source.worktreeFingerprint,
            FSUSBLOG_FIXTURE_SERVICE_GENERATION: serviceGeneration
        }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const prepareState = path.join(fixtureRoot, 'prepare-state.json');
    assert.equal(existsSync(prepareState), true);
    assert.equal(existsSync(path.join(fixtureRoot, 'fixture-receipt.json')), false);
    assert.deepEqual(JSON.parse(readFileSync(prepareState, 'utf8')), {
        schema: 'fsusblog.fixture-prepare-state.v1',
        terminalState: 'prepared',
        profileId: 'acceptance-representative'
    });
    assert.deepEqual(JSON.parse(readFileSync(stub.capture, 'utf8')), {
        profileId: 'acceptance-representative',
        prepareState,
        skipVerify: true,
        fixtureReceiptRequested: false,
        outputRequested: false,
        publicContentSecret: 'fsusblog-local-public-content-fixture-secret-lane-fixture-boundary-lane-fixture-boundary-run'
    });
    assert.equal(readFileSync(stub.cliCallCapture, 'utf8'), 'fixture-cli-called');
    assert.deepEqual(JSON.parse(readFileSync(stub.executionCapture, 'utf8')), {
        namespace: 'lane-fixture-boundary',
        runId: 'lane-fixture-boundary-run',
        sourceCommit: source.commit,
        sourceFingerprint: source.worktreeFingerprint,
        serviceGeneration
    });
});

test('shared lane missing source commit fails before fixture CLI invocation', (context) =>
{
    const stub = fixtureCliBoundaryStub(context);
    const fixtureRoot = path.join(stub.directory, 'missing-source-lane-fixtures');
    const source = currentSourceState(root);
    const result = spawnSync('bash', ['-c', `
export FSUSBLOG_NODE="$FSUSBLOG_TEST_STUB_NODE"
export FSUSBLOG_TEST_NAMESPACE=lane-missing-source-boundary
export FSUSBLOG_TEST_RUN_ID=lane-missing-source-boundary-run
export FSUSBLOG_TEST_SESSION_ISOLATION=0
export FSUSBLOG_SEALED_FIXTURE_PROFILE_ID=acceptance-representative
export FSUSBLOG_FIXTURE_PROFILE_SOURCE=dev-cli
source ./tools/test/lanes/_suite-support.sh
unset FSUSBLOG_TEST_SOURCE_COMMIT
InvokeLaneFixtureOrchestrator
`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            ...process.env,
            FSUSBLOG_TEST_STUB_CAPTURE: stub.capture,
            FSUSBLOG_TEST_STUB_FIXTURE_ROOT: fixtureRoot,
            FSUSBLOG_TEST_STUB_NODE: stub.executable,
            FSUSBLOG_TEST_STUB_EXECUTION_CAPTURE: stub.executionCapture,
            FSUSBLOG_TEST_STUB_CLI_CALL_CAPTURE: stub.cliCallCapture,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: source.worktreeFingerprint,
            FSUSBLOG_FIXTURE_SERVICE_GENERATION: `sha256:${'c'.repeat(64)}`
        }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture source commit is required/u);
    assert.equal(existsSync(stub.cliCallCapture), false);
    assert.equal(existsSync(stub.capture), false);
    assert.equal(existsSync(stub.executionCapture), false);
    assert.equal(existsSync(path.join(fixtureRoot, 'prepare-state.json')), false);
    assert.equal(existsSync(path.join(fixtureRoot, 'fixture-receipt.json')), false);
});

test('dev receipt transition reuses only the exact run and cleans profile or service drift', () =>
{
    const executionIdentity = {
        runId: 'dev-0123456789abcdef',
        namespace: 'dev-0123456789abcdef',
        sourceIdentity: {
            commit: 'a'.repeat(40),
            worktreeFingerprint: `sha256:${'b'.repeat(64)}`
        },
        handles: {
            serviceGeneration: `sha256:${'c'.repeat(64)}`
        }
    };
    const receipt = {
        schema: 'fsusblog.fixture-receipt.v2',
        terminalStatus: 'verified',
        profileIdentity: {
            profileId: 'demo-public',
            profileSource: 'dev-cli',
            executionClass: 'development'
        },
        executionIdentity: {
            runId: executionIdentity.runId,
            namespace: executionIdentity.namespace,
            source: executionIdentity.sourceIdentity,
            serviceGeneration: executionIdentity.handles.serviceGeneration
        }
    };
    assert.deepEqual(
        classifyDevFixtureReceiptTransition(receipt, {
            profileId: 'demo-public',
            executionIdentity
        }),
        { action: 'reuse', reason: 'same-execution-identity' }
    );
    assert.deepEqual(
        classifyDevFixtureReceiptTransition(receipt, {
            profileId: 'none',
            executionIdentity
        }),
        { action: 'cleanup', reason: 'profile-changed' }
    );
    assert.deepEqual(
        classifyDevFixtureReceiptTransition({
            ...receipt,
            profileIdentity: {
                ...receipt.profileIdentity,
                executionClass: 'diagnostic'
            }
        }, {
            profileId: 'demo-public',
            executionIdentity
        }),
        { action: 'cleanup', reason: 'profile-evidence-changed' }
    );
    assert.deepEqual(
        classifyDevFixtureReceiptTransition(receipt, {
            profileId: 'demo-public',
            executionIdentity: {
                ...executionIdentity,
                handles: { serviceGeneration: `sha256:${'d'.repeat(64)}` }
            }
        }),
        { action: 'cleanup', reason: 'execution-identity-changed' }
    );
    assert.deepEqual(
        classifyDevFixtureReceiptTransition(null, {
            profileId: 'demo-public',
            executionIdentity
        }),
        { action: 'none', reason: 'no-previous-demo-receipt' }
    );
    assert.throws(
        () => classifyDevFixtureReceiptTransition(receipt, {
            profileId: 'demo-public',
            executionIdentity: {}
        }),
        /requires exact run, namespace, source, and service generation identity/
    );
});

test('acceptance orchestrator waves run auth and public before dependents', async () =>
{
    const planned = plan({ profileId: 'acceptance-representative', profileSource: 'dev-cli' });
    const order = [];
    const ports = portsForPlan(planned, {
        'auth-session': { onPrepare: async () =>
        {
            order.push('auth-session');
            return { ok: true, strategy: 'transaction-fixture', producerId: 'auth-session' };
        } },
        'public-content': { onPrepare: async () =>
        {
            order.push('public-content');
            return { ok: true, strategy: 'transaction-fixture', producerId: 'public-content' };
        } },
        'account-messaging': { onPrepare: async () =>
        {
            order.push('account-messaging');
            return { ok: true, strategy: 'transaction-fixture', producerId: 'account-messaging' };
        } },
        'comment-moderation': { onPrepare: async () =>
        {
            order.push('comment-moderation');
            return { ok: true, strategy: 'transaction-fixture', producerId: 'comment-moderation' };
        } }
    });
    const receipt = await prepare(planned, ports);
    assert.equal(receipt.terminalState, 'prepared');
    assert.ok(order.indexOf('auth-session') < order.indexOf('account-messaging'));
    assert.ok(order.indexOf('public-content') < order.indexOf('comment-moderation'));
});

test('prepare passes only a verified exact-run prior FixtureReceipt to its producer', async () =>
{
    const planned = plan(
        { profileId: 'demo-public', profileSource: 'dev-cli', executionClass: 'development' },
        { runId: 'demo-run', namespace: 'demo-namespace' }
    );
    const demoResult = {
        producerId: 'development-demo',
        strategy: 'transaction-fixture',
        entityIdentities: [{
            kind: 'article',
            id: '101',
            variantId: 'diagnostic.development.demo.dataset',
            owner: 'demo-fixture:0123456789abcdef01234567',
            digest: `sha256:${'a'.repeat(64)}`
        }],
        observations: {
            source: 'service',
            database: {
                namespace: 'demo-namespace',
                schemaIdentity: 'public',
                entities: [{
                    kind: 'article',
                    id: '101',
                    owned: true,
                    variantId: 'diagnostic.development.demo.dataset',
                    owner: 'demo-fixture:0123456789abcdef01234567'
                }]
            },
            redis: { namespace: 'demo-namespace', keys: [] },
            cache: { namespace: 'demo-namespace', entries: [] }
        },
        providedCapabilities: ['development.demo.dataset'],
        cleanupContract: { kind: 'receipt-exact-identities' }
    };
    const firstPorts = portsForPlan(planned, {
        'development-demo': {
            onPrepare: async () => demoResult,
            onVerify: async () => ({ ok: true })
        }
    });
    const firstPrepared = await prepare(planned, firstPorts);
    const verified = await verify(firstPrepared, firstPorts);

    let receivedPrevious = null;
    const secondPorts = portsForPlan(planned, {
        'development-demo': {
            onPrepare: async (context) =>
            {
                receivedPrevious = context.previousProducerReceipt;
                return demoResult;
            }
        }
    });
    await prepare(planned, secondPorts, undefined, { previousFixtureReceipt: verified });
    assert.deepEqual(receivedPrevious, verified.producerReceipts[0]);

    const crossRun = plan(
        { profileId: 'demo-public', profileSource: 'dev-cli', executionClass: 'development' },
        { runId: 'other-run', namespace: 'demo-namespace' }
    );
    const crossRunPorts = portsForPlan(crossRun);
    await assert.rejects(
        prepare(crossRun, crossRunPorts, undefined, { previousFixtureReceipt: verified }),
        /execution identity mismatch|cross-run/
    );
    assert.equal(crossRunPorts[0].calls.prepare, 0);
});

test('outlet: late ignored cleanup cancellation retains first reason, never publishes cleaned or calls cleanup twice', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    const controller = new AbortController();
    const reason = new Error('late-cleanup-outlet-abort');
    let records = 0;
    const ports = portsForPlan(planned, { 'auth-session': { onCleanup: async (_, __, signal) =>
    {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        return { exact: true };
    } } });
    const prepared = await prepare(planned, ports);
    await assert.rejects(cleanup(prepared, ports, controller.signal, { artifactOutlet: { recordPort: () =>
    {
        records++;
    } } }), (error) =>
    {
        assert.equal(error.cause, reason);
        assert.equal(error.receipt.terminalState, 'cleanup-failed');
        return true;
    });
    assert.equal(records, 0);
    assert.equal(ports[0].calls.cleanup, 1);
});

test('outlet: canonical orchestration retains checked postconditions and pure receipt digest with actual file refs', async (t) =>
{
    // Injected observation model only; no PG/Redis/runtime qualification.
    const directory = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'orchestrator-outlet-model-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const planned = plan({ profileId: 'public-empty', profileSource: 'dev-cli' }, {
        runId: 'outlet-positive-unit', namespace: 'outlet-positive-unit',
        sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        handles: { serviceGeneration: `sha256:${'c'.repeat(64)}` }
    });
    const ports = portsForPlan(planned, { 'public-content': { onPrepare: async (context) =>
    {
        const entity = { kind: 'namespace', id: context.namespace, variantId: context.variantPlan.variants[0].id };
        return { ok: true, entityIdentities: [entity], observations: {
            database: { namespace: context.namespace, schemaIdentity: 'unit-model', entities: [{ ...entity, fields: { articleCount: 0, taxonomyCount: 0 } }] },
            redis: { namespace: context.namespace, keys: [] }, cache: { namespace: context.namespace, entries: [] }
        } };
    } } });
    const outlet = createFixtureArtifactOutlet(path.join(directory, 'artifacts'), { plan: planned, consumerId: 'unit-contract-consumer' });
    const prepared = await prepare(planned, ports, undefined, { artifactOutlet: outlet });
    const withoutOutlet = await verify(prepared, ports);
    const withOutlet = await verify(prepared, ports, { artifactOutlet: outlet });
    validateFixtureReceipt(withOutlet, { requireVerified: true });
    assert.deepEqual(withOutlet.producerReceipts, withoutOutlet.producerReceipts);
    assert.equal(withOutlet.outputArtifacts.length, 2);
    for (const ref of withOutlet.outputArtifacts)
    {
        assert.equal(readPrivateJson(ref.path).contentDigest, ref.digest);
    }
    const checked = readPrivateJson(withOutlet.outputArtifacts.find((item) => item.role === 'fixture-verify-port-result').path).document.checkedPostconditions;
    assert.deepEqual(checked, [{ capabilityId: 'public.empty', postconditionId: 'public-empty', ok: true, detail: null }]);
    assert.deepEqual(withOutlet.producerReceipts[0].postconditionObservations,
        [{ capabilityId: 'public.empty', postconditionId: 'public-empty', ok: true, detail: null, reason: null }]);
    assert.equal('portPostconditions' in withOutlet, false);
});

test('outlet: late ignored verify cancellation prevents both artifact and verified publication', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    const controller = new AbortController();
    const reason = new Error('late-verify-outlet-abort');
    const ports = portsForPlan(planned);
    const prepared = await prepare(planned, ports);
    let records = 0;
    let publications = 0;
    ports[0].verify = async (_, __, signal) =>
    {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        await Promise.resolve();
        return { ok: true };
    };
    await assert.rejects(verify(prepared, ports, { signal: controller.signal, artifactOutlet: {
        recordPort: () =>
        {
            records++;
        }, publish: () =>
        {
            publications++;
            return [];
        }
    } }), (error) => error.cause === reason);
    assert.equal(records, 0);
    assert.equal(publications, 0);
    assert.equal(ports[0].calls.cleanup, 0);
});

test('outlet: structural verify preserves rejected result and original failure, never invokes success publisher', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    let publications = 0;
    let rejected;
    const ports = portsForPlan(planned, { 'auth-session': { onVerify: async () => ({ ok: true, structuralOnly: true }) } });
    const prepared = await prepare(planned, ports);
    await assert.rejects(verify(prepared, ports, { artifactOutlet: {
        recordRejectedPort: (_, result) =>
        {
            rejected = result;
        },
        publish: () =>
        {
            publications++;
            return [];
        }
    } }), /structural-only/);
    assert.deepEqual(rejected, { ok: true, structuralOnly: true });
    assert.equal(publications, 0);
    assert.equal(ports[0].calls.cleanup, 0);
});

test('outlet: prepare outlet rejection cleans the actual success once and preserves primary over cleanup failure', async () =>
{
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' });
    const ports = portsForPlan(planned, { 'auth-session': { onCleanup: async () =>
    {
        throw new Error('cleanup-second-error');
    } } });
    const reason = new Error('outlet-primary-error');
    await assert.rejects(prepare(planned, ports, undefined, { artifactOutlet: {
        recordPort: () =>
        {
            throw reason;
        }
    } }), (error) =>
    {
        assert.equal(error.cause, reason);
        assert.equal(error.receipt.primaryFailure.message, reason.message);
        assert.equal(error.receipt.cleanupFailure.message, 'cleanup-second-error');
        return true;
    });
    assert.equal(ports[0].calls.prepare, 1);
    assert.equal(ports[0].calls.cleanup, 1);
});

test('outlet: canonical CLI keeps none artifacts empty and rejects wrong actual consumer before business mutation', (t) =>
{
    const directory = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'fixture-cli-outlet-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = currentSourceState(root);
    const args = [path.join(root, 'tools/test-fixtures/cli.mjs'), 'run', '--profile', 'none',
        '--run-id', 'none-outlet-model', '--namespace', 'none-outlet-model', '--source-commit', source.commit,
        '--source-fingerprint', source.worktreeFingerprint, '--service-generation', `sha256:${'c'.repeat(64)}`,
        '--artifact-dir', path.join(directory, 'artifacts'), '--artifact-consumer-id', 'fixture-cli:run',
        '--out', path.join(directory, 'receipt.json')];
    const valid = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    const receipt = JSON.parse(valid.stdout);
    assert.deepEqual(receipt.outputArtifacts, []);
    assert.equal(receipt.terminalStatus, 'verified');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'artifacts')), []);
    const wrongArgs = [...args];
    wrongArgs[wrongArgs.indexOf('fixture-cli:run')] = 'foreign-consumer';
    const wrong = spawnSync(process.execPath, wrongArgs, { encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    assert.equal(wrong.stdout, '');
    assert.match(wrong.stderr, /actual CLI command|consumer/);
    assert.deepEqual(readPrivateJson(path.join(directory, 'receipt.json')).document, receipt);
});

function shellClosureFunction(file, name, nextName)
{
    const source = readFileSync(path.join(root, file), 'utf8');
    const start = source.indexOf(`${name}() {`);
    const end = source.indexOf(`\n${nextName}() {`, start);
    assert.ok(start >= 0 && end > start, `actual Shell owner function ${name} is required`);
    return source.slice(start, end);
}

test('Shell closure: bootstrap PATH resolution preserves the original command failure', () =>
{
    const source = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const prefix = source.slice(0, source.indexOf('set -euo pipefail\n'));
    const result = spawnSync('bash', ['-c', `
set -e
dirname() { return 41; }
${prefix}
printf 'unexpected continuation\\n'
`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 41, result.stderr);
    assert.equal(result.stdout, '');
});

test('Shell closure: FsusUI resolver failure cannot invoke identity verification', () =>
{
    const result = spawnSync('bash', ['-c', `
source ./tools/test/lanes/_suite-support.sh
ResolverPort() { printf 'unit resolver failed\\n' >&2; return 43; }
Run() { printf 'unexpected identity verification\\n'; }
FSUSBLOG_NODE=ResolverPort
EnsureFrontendFsusUiBaseline
printf 'unexpected continuation\\n'
`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 43, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unit resolver failed/u);
});

test('Shell closure: current-schema digest failure retains its status before admission', () =>
{
    const body = shellClosureFunction('tools/bootstrap-acceptance-env.sh',
        'RequireCurrentSchemaRuntimeReady', 'EnsureAntiSpamModelRuntime');
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
${body}
ROOT_DIR=/unit-model
TMP_DIR=/unit-model/runtime
FSUSBLOG_TEST_RUN_ID=unit-digest-failure
FSUSBLOG_TEST_SOURCE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CurrentSchemaRunDigest() { return 44; }
Log() { printf 'unexpected admission branch\\n'; }
RequireCurrentSchemaRuntimeReady
printf 'unexpected continuation\\n'
`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 44, result.stderr);
    assert.equal(result.stdout, '');
});

test('Shell closure: malformed planned JSON fails before fixture mutation', () =>
{
    const body = shellClosureFunction('tools/bootstrap-acceptance-env.sh',
        'ResolveFixtureProfilePlan', 'InvokeFixtureOrchestrator');
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
${body}
ROOT_DIR=/unit-model
FIXTURE_DIR=/unit-model/fixtures
FSUSBLOG_FIXTURE_PROFILE_SOURCE=dev-cli
FSUSBLOG_SEALED_FIXTURE_PROFILE_ID=auth-basic
unset FSUSBLOG_FIXTURE_PROFILE FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS
MalformedPlanPort() {
    if [[ "$1" == '-e' ]]; then
        "${process.execPath}" "$@"
    else
        printf '{malformed'
    fi
}
FSUSBLOG_NODE=MalformedPlanPort
Log() { printf '%s\\n' "$*"; }
ResolveFixtureProfilePlan full
printf 'unexpected mutation boundary\\n'
`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /SyntaxError|JSON/u);
});

test('Shell closure: fixture CLI secrets are process-local and parent enable-disable lifecycle is retained', (context) =>
{
    const stub = fixtureCliBoundaryStub(context);
    const invoke = shellClosureFunction('tools/bootstrap-acceptance-env.sh',
        'InvokeFixtureOrchestrator', 'EnsureFixtureTemporalContext');
    const configurePublic = shellClosureFunction('tools/bootstrap-acceptance-env.sh',
        'ConfigureLocalPublicContentFixture', 'ConfigureLocalAuthFixture');
    const configureAuth = shellClosureFunction('tools/bootstrap-acceptance-env.sh',
        'ConfigureLocalAuthFixture', 'ConfigureAccountProfilePreferenceFixture');
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
${invoke}
${configurePublic}
${configureAuth}
ROOT_DIR="$FSUSBLOG_UNIT_REPOSITORY_ROOT"
FIXTURE_DIR="$FSUSBLOG_TEST_STUB_ROOT/fixtures"
FIXTURE_RECEIPT_FILE="$FIXTURE_DIR/fixture-receipt.json"
PUBLIC_ID_PROJECTION_FILE="$FIXTURE_DIR/public-content-projection.json"
FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR="$FIXTURE_DIR/runtime-cache-inputs/unit-model"
FIXTURE_PROFILE_ID=acceptance-representative
FIXTURE_PROFILE_SOURCE=dev-cli
FIXTURE_PRODUCER_IDS=auth-session
FIXTURE_REQUIRES_DEMO=0
FSUSBLOG_TEST_NAMESPACE=unit-secret-lifecycle
FSUSBLOG_TEST_RUN_ID=unit-secret-lifecycle
FSUSBLOG_TEST_SOURCE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FSUSBLOG_TEST_SOURCE_FINGERPRINT=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FSUSBLOG_FIXTURE_SERVICE_GENERATION=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
DEBUG_BACKEND_URL=http://127.0.0.1:1
DEBUG_FRONTEND_URL=http://127.0.0.1:2
POSTGRES_CONTAINER=unit-postgres-not-running
REDIS_CONTAINER=unit-redis-not-running
LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET=unit-public-value
LOCAL_AUTH_FIXTURE_SECRET=unit-auth-value
JWT_KEY_VERSION=unit-model
JWT_SECRET=unit-model
JWT_ISSUER=unit-model
JWT_AUDIENCE=unit-model
JWT_ACCESS_TOKEN_EXPIRES_MINUTES=1
JWT_ROTATION_WINDOW_DAYS=1
ANONYMOUS_SUBJECT_HASH_PEPPER=unit-model
unset FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID FSUSBLOG_SEALED_FIXTURE_PREREQUISITES
Log() { :; }
WriteEnvFile() { :; }
FIXTURE_REQUIRES_PUBLIC=0
FIXTURE_REQUIRES_LOCAL_AUTH=0
ConfigureLocalPublicContentFixture
ConfigureLocalAuthFixture
InvokeFixtureOrchestrator
[[ ! -v FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET && ! -v FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET ]]
[[ ! -v fsus__allowLocalPublicContentFixture && ! -v fsus__allowLocalAuthFixture ]]
printf 'disabled-parent-clean\\n'
FIXTURE_REQUIRES_PUBLIC=1
FIXTURE_REQUIRES_LOCAL_AUTH=1
ConfigureLocalPublicContentFixture
ConfigureLocalAuthFixture
InvokeFixtureOrchestrator
[[ "$FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET" == "$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET" ]]
[[ "$FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET" == "$LOCAL_AUTH_FIXTURE_SECRET" ]]
[[ "$fsus__allowLocalPublicContentFixture" == true && "$fsus__allowLocalAuthFixture" == true ]]
printf 'enabled-parent-retained\\n'
FIXTURE_REQUIRES_PUBLIC=0
FIXTURE_REQUIRES_LOCAL_AUTH=0
ConfigureLocalPublicContentFixture
ConfigureLocalAuthFixture
[[ ! -v FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET && ! -v FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET ]]
[[ ! -v fsus__allowLocalPublicContentFixture && ! -v fsus__allowLocalAuthFixture ]]
printf 'disabled-again-clean\\n'
`], { cwd: root, encoding: 'utf8', timeout: 10_000, env: {
        ...process.env, FSUSBLOG_NODE: stub.executable, FSUSBLOG_TEST_STUB_ROOT: stub.directory,
        FSUSBLOG_TEST_STUB_CAPTURE: stub.capture, FSUSBLOG_UNIT_REPOSITORY_ROOT: root
    } });
    assert.equal(result.status, 0, result.stderr);
    const prepared = `${JSON.stringify({ schema: 'fsusblog.fixture-prepare-state.v1',
        terminalState: 'prepared', profileId: 'acceptance-representative' })}\n`;
    assert.equal(result.stdout, `${prepared}disabled-parent-clean\n${prepared}enabled-parent-retained\ndisabled-again-clean\n`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unit-public-value|unit-auth-value/u);
    const captured = JSON.parse(readFileSync(stub.capture, 'utf8'));
    assert.equal(captured.publicContentSecret, 'unit-public-value');
    assert.equal(captured.authSecret, 'unit-auth-value');
    assert.equal(captured.skipVerify, true);
    assert.equal(captured.fixtureReceiptRequested, false);
});

test('Shell closure: security stages retain three callee arguments, nonzero aggregation and parent isolation', () =>
{
    const result = spawnSync('bash', ['-c', `
source ./tools/test/lanes/_suite-support.sh
ROOT_DIR='/unit root'
FSUSBLOG_NODE=node-unit-port
FSUSBLOG_RUNTIME_SCENARIO_HOST=0
FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG=1
FSUSBLOG_SKIP_ZAP=1
FSUSBLOG_FIREWALL_POLICY_EVIDENCE='/unit evidence/firewall.json'
FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE=1
FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE='/unit evidence/exposure.json'
FSUSBLOG_USER_USERNAME=unit-user
FSUSBLOG_ADMIN_USERNAME=unit-admin
FSUSBLOG_DEVICE_FP=unit-device
leak=parent-value
label=parent-label
status=parent-status
suffix=parent-suffix
securityFailures=(parent-failures)
Log() { printf 'log|%s\\n' "$*"; }
Fail() { printf 'failure|%s\\n' "$*"; return 29; }
RequireDebugStack() { :; }
NamespaceSlug() { printf '%s' "$1"; }
BeginLegacyRuntimeScenarioObservation() { printf 'begin|%s\\n' "$*"; }
EndLegacyRuntimeScenarioObservation() { printf 'end|%s\\n' "$*"; }
InvokeLaneFixtureOrchestrator() { leak=child-fixture; printf 'default|fixture-port\\n'; return 13; }
RunInClient() {
    leak=child-client
    printf 'client|%s|%s|%s' "$FSUSBLOG_USER_USERNAME" "$FSUSBLOG_ADMIN_USERNAME" "$FSUSBLOG_DEVICE_FP"
    printf '|<%s>' "$@"
    printf '\\n'
    if [[ "$*" == *auth-session-smoke.mjs* ]]; then return 17; fi
}
Run() {
    leak=child-run
    printf 'run'
    printf '|<%s>' "$@"
    printf '\\n'
    case "$1" in
        */verify-production-firewall-policy-evidence.sh) return 19 ;;
        */check-production-exposure-live.sh) return 23 ;;
        */verify-production-exposure-evidence.sh) return 0 ;;
        *) printf 'unexpected product port\\n' >&2; return 97 ;;
    esac
}
ParentProof() {
    [[ "$leak" == parent-value && "$label" == parent-label && "$status" == parent-status && "$suffix" == parent-suffix ]] || return 98
    [[ "\${securityFailures[*]}" == parent-failures ]] || return 98
    [[ "$FSUSBLOG_USER_USERNAME" == unit-user && "$FSUSBLOG_ADMIN_USERNAME" == unit-admin && "$FSUSBLOG_DEVICE_FP" == unit-device ]] || return 98
    for functionName in RunSecurityStage RunSecurityLegacyIsolatedClientCheck CheckSecurityFirewallEvidence CheckExternalProductionExposure; do
        if declare -F "$functionName" >/dev/null; then return 98; fi
    done
    printf 'parent|isolated-and-functions-removed\\n'
}
if RunSecurityRuntimeCoreOnly; then
    resultStatus=0
else
    resultStatus=$?
fi
ParentProof
exit "$resultStatus"
`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 29, result.stderr);
    assert.equal(result.stderr, '[test:security] production exposure failures: live-check\n');
    assert.match(result.stdout, /default\|fixture-port/u);
    assert.match(result.stdout, /client\|unit-user-security-auth-session\|unit-admin-security-auth-session\|unit-device-security-auth-session\|<node-unit-port>\|<\.\.\/\.\.\/tests\/frontend\/checks\/runtime\/auth-session-smoke\.mjs>/u);
    assert.match(result.stdout, /client\|unit-user-security-auth-mfa[^\n]*\|<npm>\|<run>\|<check:security:auth-mfa>/u);
    assert.match(result.stdout, /client\|unit-user-security-auth-passkey[^\n]*\|<npm>\|<run>\|<check:security:auth-passkey>/u);
    assert.match(result.stdout, /run\|<\/unit root\/tools\/security\/verify-production-firewall-policy-evidence\.sh>\|<\/unit evidence\/firewall\.json>/u);
    assert.match(result.stdout, /run\|<\/unit root\/tools\/security\/check-production-exposure-live\.sh>/u);
    assert.match(result.stdout, /run\|<\/unit root\/tools\/security\/verify-production-exposure-evidence\.sh>\|<\/unit evidence\/exposure\.json>/u);
    assert.match(result.stdout, /end\|failure/u);
    assert.match(result.stdout, /failure\|security runtime failures \(prepare-runtime-fixtures:13 auth-session:17 firewall-evidence:19 external-production-exposure:1\)/u);
    assert.match(result.stdout, /parent\|isolated-and-functions-removed\n$/u);
});
