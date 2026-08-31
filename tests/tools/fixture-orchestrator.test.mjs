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

import { classifyDevFixtureReceiptTransition } from '../../tools/test-fixtures/cli.mjs';
import {
    buildProducerDag
} from '../../tools/test-fixtures/dag.mjs';
import {
    cleanup,
    createProducerContext,
    plan,
    prepare,
    verify
} from '../../tools/test-fixtures/orchestrator.mjs';
import { createTerminalState } from '../../tools/test-fixtures/terminal-state.mjs';
import {
    fixtureCatalogDigest,
    readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixtureCliBoundaryStub(context)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-fixture-cli-boundary-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, 'node-stub');
    const capture = path.join(directory, 'invocation.json');
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
if (options._[0] !== 'run') fail('fixture CLI run command is required')
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
process.stdout.write(JSON.stringify(prepareState) + '\\n')
`);
    chmodSync(executable, 0o755);
    return { capture, directory, executable };
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
        const { createPublicContentPort } = await import('../../tools/test-fixtures/producers/catalog-ports.mjs');
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
    const { createAccountMessagingPort } = await import('../../tools/test-fixtures/producers/catalog-ports.mjs');
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

test('shared lane non-none boundary writes prepare-state without requesting FixtureReceipt', (context) =>
{
    const stub = fixtureCliBoundaryStub(context);
    const fixtureRoot = path.join(stub.directory, 'lane-fixtures');
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
            FSUSBLOG_TEST_STUB_NODE: stub.executable
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
