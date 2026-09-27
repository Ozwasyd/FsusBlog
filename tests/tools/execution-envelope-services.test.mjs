import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {createAndAdmitServiceEnvelope, executionServiceImageReference, loadExecutionServiceCatalog, observeContainerService, observeRunOwnedService, parseExecutionEnvelopeServicesOptions, requiredExecutionServices, resolveExecutionServiceContainers, validateExecutionServiceCatalog, verifyLiveServiceEnvelope} = await import(new URL('../../tools/test/execution-envelope-services.mjs', import.meta.url));
const {loadExecutionEnvelopeApplicability} = await import(new URL('../../tools/test-matrix/execution-envelope-policy.mjs', import.meta.url));
const {parseMatrix} = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const {prepareMySqlFixtureService, recoverMySqlFixtureService, verifyMySqlFixtureServiceCleanup, withMySqlFixtureService} = await import(new URL('../../tools/test-fixtures/services/mysql.mjs', import.meta.url));
const {digestReceiptBody} = await import(new URL('../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url));
const matrix = parseMatrix(
    fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8')
);
const catalog = loadExecutionServiceCatalog();
const applicability = loadExecutionEnvelopeApplicability();

function controlledMySqlLifecycle(t)
{
    const temporaryRoot = new URL('../../.tmp/mysql-service-lifecycle-contracts/', import.meta.url);
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(new URL('owned-', temporaryRoot));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = controlledMySqlServiceFixture('mysql-lifecycle-contract');
    const context = {
        root, runId: 'mysql-lifecycle-contract', namespace: 'mysql-contract',
        bundleId: 'matrix:backend-unit', stepId: 'migration-services',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        resourceGrant: { cpuUnits: 1, memoryHighBytes: 536870912, memoryMaxBytes: 1073741824, pidsMax: 128 },
        startupBudgetMs: 1000, commandBudgetMs: 1000, cleanupBudgetMs: 1000
    };
    const state = {
        calls: [], container: null, createCount: 0, removalIds: [],
        held: true, source: structuredClone(context.sourceState), heldChecks: 0,
        failCreateAfterEffect: false, ready: true, failSqlObservation: false,
        corruptCreateOutput: false, resourceDrift: false, existingName: false,
        runtimeIdentity: { serverVersion: '29.5.3', serverId: 'fixture-engine', operatingSystem: 'Linux',
            architecture: 'x86_64', cgroupDriver: 'systemd' }
    };
    const image = { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [fixture.catalog.services.mysql.imageReference] };
    const id = 'd'.repeat(64);
    const docker = (command, args, options) =>
    {
        state.calls.push({ command, args, options });
        assert.equal(command, 'docker');
        assert.equal(options.shell, false);
        assert.ok(Number.isSafeInteger(options.timeout) && options.timeout > 0);
        const ok = (stdout = '') => ({ status: 0, stdout });
        if (args[0] === 'image')
        {
            return ok(JSON.stringify([image]));
        }
        if (args[0] === 'version')
        {
            return ok(JSON.stringify({ Version: state.runtimeIdentity.serverVersion, Os: 'linux', Arch: state.runtimeIdentity.architecture }));
        }
        if (args[0] === 'info')
        {
            return ok(JSON.stringify({ ID: state.runtimeIdentity.serverId, OperatingSystem: state.runtimeIdentity.operatingSystem,
                Architecture: state.runtimeIdentity.architecture, CgroupDriver: state.runtimeIdentity.cgroupDriver }));
        }
        if (args[0] === 'container')
        {
            state.onContainerLookup?.(args);
            if (state.existingName && state.createCount === 0)
            {
                return ok('e'.repeat(64));
            }
            const filter = args.at(-1);
            return ok(state.container && (filter === `id=${id}` || filter === `name=^/${state.container.Name}$`
                || filter === `label=io.fsusblog.test.mysql-recovery-binding=${state.container.Config.Labels['io.fsusblog.test.mysql-recovery-binding']}`) ? id : '');
        }
        if (args[0] === 'inspect')
        {
            assert.equal(args[1], id);
            return state.container ? ok(JSON.stringify([state.container])) : { status: 1, stderr: 'absent' };
        }
        if (args[0] === 'run')
        {
            const argument = (key) => args[args.indexOf(key) + 1];
            state.beforeCreateRecord = fs.readFileSync(path.join(path.dirname(argument('--cidfile')), 'lifecycle.json'));
            const labels = {};
            args.forEach((value, index) =>
            {
                if (value === '--label')
                {
                    const text = args[index + 1];
                    const split = text.indexOf('=');
                    labels[text.slice(0, split)] = text.slice(split + 1);
                }
            });
            state.createCount++;
            state.container = {
                Id: id, Name: argument('--name'), Created: '2026-09-24T00:00:00.000Z',
                Config: { Image: args.at(-1), Labels: labels }, Image: image.Id,
                State: { Running: true },
                HostConfig: { NetworkMode: 'bridge', NanoCpus: Number(argument('--cpus')) * 1e9,
                    Memory: Number(argument('--memory')), MemoryReservation: Number(argument('--memory-reservation')),
                    PidsLimit: Number(argument('--pids-limit')) },
                NetworkSettings: { SandboxKey: '/run/netns/mysql-lifecycle', Ports: {
                    '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '23306' }], '33060/tcp': null
                } }
            };
            fs.writeFileSync(argument('--cidfile'), id, { flag: 'wx', mode: 0o600 });
            if (state.resourceDrift)
            {
                state.container.HostConfig.Memory++;
            }
            if (state.failCreateAfterEffect)
            {
                return { status: 1, stderr: 'private-create-error' };
            }
            return ok(state.corruptCreateOutput ? 'bad-id' : id);
        }
        if (args[0] === 'rm')
        {
            assert.deepEqual(args, ['rm', '-f', '-v', id]);
            state.removalIds.push(id);
            state.container = null;
            return ok(id);
        }
        if (args[0] === 'cp')
        {
            return ok();
        }
        assert.equal(args[0], 'exec');
        assert.equal(args[1] === '-i' ? args[2] : args[1], id);
        if (args.includes('--version'))
        {
            return ok(fixture.service.serviceVersion);
        }
        if (args.includes('--execute'))
        {
            return state.failSqlObservation
                ? { status: 1, stderr: 'private-sql-error' } : ok(JSON.stringify(fixture.service.databaseIdentity));
        }
        if (options.input === 'SELECT 1;')
        {
            state.onReadyProbe?.();
            return state.ready ? ok('1') : { status: 1, stderr: 'not ready' };
        }
        return ok();
    };
    const options = {
        catalog: fixture.catalog, docker, observeSource: async () => structuredClone(state.source),
        retainRecoveryBinding: async (binding) =>
        {
            assert.equal(state.createCount, 0);
            state.recoveryBinding = structuredClone(binding);
            state.boundRecord = fs.readFileSync(binding.stateFile);
        },
        assertResourcesHeld: async (observed) =>
        {
            assert.deepEqual(observed, context);
            state.heldChecks++;
            if (!state.held)
            {
                throw new Error('resource owner no longer holds the grant');
            }
        }
    };
    return { context, options, state, id };
}

test('MySQL lifecycle exclusively prepares a pinned bounded service and removes only its exact identity', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    await service.verify();
    const create = fixture.state.calls.find(({ args }) => args[0] === 'run');
    assert.equal(create.args[create.args.indexOf('--pull') + 1], 'never');
    assert.equal(create.args[create.args.indexOf('--publish') + 1], '127.0.0.1::3306');
    assert.match(service.databasePrefix, /^ddl_[a-f0-9]{20}_$/u);
    const sql = fixture.state.calls.find(({ options }) => options.input?.startsWith('CREATE USER'));
    assert.ok(sql.options.input.includes(service.databasePrefix.replaceAll('_', '\\_') + '%'));
    assert.ok(sql.options.input.includes(service.databasePrefix.toUpperCase().replaceAll('_', '\\_') + '%'));
    assert.equal(sql.args.some((item) => item.includes('IDENTIFIED BY')), false);
    const credential = fs.readFileSync(service.clientOptionsFile, 'utf8').split('password=')[1].trim();
    assert.equal(fs.statSync(service.clientOptionsFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(service.stateFile, 'utf8').includes(credential), false);
    assert.equal(JSON.stringify(service.envelope).includes(credential), false);
    fixture.state.held = false;
    await service.cleanup();
    await service.cleanup();
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
    assert.equal(fs.existsSync(service.clientOptionsFile), false);
    assert.equal(fs.existsSync(path.join(service.directory, 'container.env')), false);
    const state = JSON.parse(fs.readFileSync(service.stateFile, 'utf8'));
    assert.equal(state.phase, 'cleaned');
    assert.equal(state.qualificationEligible, false);
    await assert.rejects(service.verify, /no longer prepared/u);
});

test('MySQL lifecycle rejects missing identity, grant, registration and source before creation', async (t) =>
{
    for (const mutate of [
        (value) =>
        {
            value.context.runId = '../foreign';
        },
        (value) =>
        {
            delete value.context.sourceState.commit;
        },
        (value) =>
        {
            value.context.resourceGrant = {};
        },
        (value) =>
        {
            value.context.resourceGrant.cpuUnits = 0;
        },
        (value) =>
        {
            value.context.resourceGrant.cpuUnits = 0.5;
        },
        (value) =>
        {
            value.context.resourceGrant.memoryHighBytes = value.context.resourceGrant.memoryMaxBytes + 1;
        },
        (value) =>
        {
            value.context.resourceGrant.pidsMax = 0;
        },
        (value) =>
        {
            value.context.commandBudgetMs = 0;
        },
        (value) =>
        {
            value.context.password = 'must-not-persist';
        },
        (value) =>
        {
            delete value.options.assertResourcesHeld;
        },
        (value) =>
        {
            delete value.options.retainRecoveryBinding;
        },
        (value) =>
        {
            delete value.options.catalog.services.mysql;
        },
        (value) =>
        {
            value.state.source.commit = 'e'.repeat(40);
        },
        (value) =>
        {
            value.state.held = false;
        }
    ])
    {
        const fixture = controlledMySqlLifecycle(t);
        mutate(fixture);
        await assert.rejects(prepareMySqlFixtureService(fixture.context, fixture.options));
        assert.equal(fixture.state.createCount, 0);
        assert.equal(fs.existsSync(path.join(fixture.context.root, '.tmp')), false);
    }
});

test('MySQL lifecycle refuses existing names and symlinked storage without adopting resources', async (t) =>
{
    const existing = controlledMySqlLifecycle(t);
    existing.state.existingName = true;
    await assert.rejects(prepareMySqlFixtureService(existing.context, existing.options), /refuses to adopt/u);
    assert.equal(existing.state.createCount, 0);
    assert.deepEqual(existing.state.removalIds, []);
    const linked = controlledMySqlLifecycle(t);
    const foreign = path.join(linked.context.root, 'foreign');
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(linked.context.root, '.tmp'));
    await assert.rejects(prepareMySqlFixtureService(linked.context, linked.options), /symlink or special/u);
    assert.equal(linked.state.createCount, 0);
    assert.deepEqual(fs.readdirSync(foreign), []);
});

test('MySQL lifecycle cleans partial creation, invalid create output, SQL and resource failures', async (t) =>
{
    for (const field of ['failCreateAfterEffect', 'corruptCreateOutput', 'failSqlObservation', 'resourceDrift'])
    {
        const fixture = controlledMySqlLifecycle(t);
        fixture.state[field] = true;
        await assert.rejects(prepareMySqlFixtureService(fixture.context, fixture.options), undefined, field);
        assert.equal(fixture.state.container, null, field);
        assert.deepEqual(fixture.state.removalIds, [fixture.id], field);
        const create = fixture.state.calls.find(({ args }) => args[0] === 'run');
        const secretFile = create.args[create.args.indexOf('--env-file') + 1];
        assert.equal(fs.existsSync(secretFile), false, field);
        assert.equal(fs.existsSync(path.join(path.dirname(secretFile), 'client.cnf')), false, field);
    }
});

test('MySQL lifecycle cancellation and startup exhaustion clean the created service', async (t) =>
{
    for (const cancelled of [false, true])
    {
        const fixture = controlledMySqlLifecycle(t);
        fixture.state.ready = false;
        fixture.context.startupBudgetMs = 5;
        const controller = new AbortController();
        fixture.options.signal = controller.signal;
        if (cancelled)
        {
            fixture.state.onReadyProbe = () => controller.abort(new Error('cancelled fixture'));
        }
        await assert.rejects(prepareMySqlFixtureService(fixture.context, fixture.options));
        assert.equal(fixture.state.container, null);
        assert.deepEqual(fixture.state.removalIds, [fixture.id]);
    }
});

test('MySQL lifecycle refuses changed cleanup ownership and retries only after exact identity is restored', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    const labels = fixture.state.container.Config.Labels;
    const token = labels['io.fsusblog.test.mysql-lifecycle-token'];
    labels['io.fsusblog.test.mysql-lifecycle-token'] = 'foreign';
    await assert.rejects(service.cleanup, /ownership or image mismatch/u);
    assert.deepEqual(fixture.state.removalIds, []);
    assert.ok(fs.existsSync(service.clientOptionsFile));
    assert.equal(JSON.parse(fs.readFileSync(service.stateFile, 'utf8')).phase, 'cleanup-failed');
    await assert.rejects(service.verify, /no longer prepared/u);
    labels['io.fsusblog.test.mysql-lifecycle-token'] = token;
    fixture.state.container.Name = 'renamed-but-same-owned-id';
    await service.cleanup();
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
});

test('MySQL lifecycle scope cleans on consumer failure and rejects source or grant drift after preparation', async (t) =>
{
    for (const reason of ['consumer', 'source', 'grant'])
    {
        const fixture = controlledMySqlLifecycle(t);
        await assert.rejects(withMySqlFixtureService(fixture.context, fixture.options, async () =>
        {
            if (reason === 'consumer')
            {
                throw new Error('consumer failed');
            }
            if (reason === 'source')
            {
                fixture.state.source.commit = 'f'.repeat(40);
            }
            if (reason === 'grant')
            {
                fixture.state.held = false;
            }
        }), /consumer failed|source identity drift|no longer holds/u);
        assert.deepEqual(fixture.state.removalIds, [fixture.id]);
    }
});

test('MySQL lifecycle cleanup consumes one total budget and does not reset it per Docker command', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    fixture.state.onContainerLookup = () =>
    {
        now += fixture.context.cleanupBudgetMs;
    };
    await assert.rejects(service.cleanup, /exhausted its total cleanup budget/u);
    assert.deepEqual(fixture.state.removalIds, []);
    assert.equal(JSON.parse(fs.readFileSync(service.stateFile, 'utf8')).phase, 'cleanup-failed');
    assert.ok(fs.existsSync(service.clientOptionsFile));
    fixture.state.onContainerLookup = null;
    await service.cleanup();
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
});

function recoveryOptions(fixture)
{
    return {
        expectedBindingDigest: fixture.state.recoveryBinding.bindingDigest,
        docker: fixture.options.docker,
        observeController: () => ({ status: 'dead' })
    };
}

test('MySQL supervisor verifies exact cleanup read-only without requiring a dead controller or current source/grant', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    await service.cleanup();
    fixture.state.held = false;
    fixture.state.source.commit = 'e'.repeat(40);
    const bytes = fs.readFileSync(service.stateFile);
    const calls = fixture.state.calls.length;
    const proof = verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture));
    assert.deepEqual(proof, {
        qualificationEligible: false, stateFile: service.stateFile,
        bindingDigest: fixture.state.recoveryBinding.bindingDigest,
        stateDigest: JSON.parse(bytes).stateDigest,
        cleanup: { containerAbsent: true, credentialsRemoved: true }
    });
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.cleanup));
    const observations = fixture.state.calls.slice(calls);
    assert.equal(observations.length, 7);
    assert.deepEqual(observations.map(({ args }) => args[0]), ['version', 'info', 'container', 'container', 'container', 'version', 'info']);
    const lookups = observations.filter(({ args }) => args[0] === 'container');
    assert.ok(lookups.every(({ args }) => args.slice(0, 2).join(' ') === 'container ls'));
    assert.deepEqual(new Set(lookups.map(({ args }) => args.at(-1))), new Set([
        `label=io.fsusblog.test.mysql-recovery-binding=${proof.bindingDigest}`,
        `name=^/${JSON.parse(bytes).name}$`,
        `id=${fixture.id}`
    ]));
    assert.deepEqual(fs.readFileSync(service.stateFile), bytes);
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
    assert.equal(fs.existsSync(path.join(service.directory, 'recovery.lock')), false);
});

test('MySQL cleanup verification rejects absent/crossed supervisor binding and unfinished lifecycle before Docker', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    const options = recoveryOptions(fixture);
    const calls = fixture.state.calls.length;
    assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, options), /completed lifecycle cleanup/u);
    assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, { ...options, expectedBindingDigest: undefined }), /supervisor-retained/u);
    assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, { ...options, expectedBindingDigest: `sha256:${'f'.repeat(64)}` }), /retained binding/u);
    assert.equal(fixture.state.calls.length, calls);
    assert.deepEqual(fixture.state.removalIds, []);
    await service.cleanup();
});

test('MySQL cleanup verification rejects fabricated cleanup and finds renamed allocations even after local ID loss', async (t) =>
{
    for (const mutation of ['live', 'renamed-with-lost-id', 'recorded-id-only', 'name-conflict', 'daemon-unavailable'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        const container = structuredClone(fixture.state.container);
        await service.cleanup();
        const options = recoveryOptions(fixture);
        const document = JSON.parse(fs.readFileSync(service.stateFile));
        if (['live', 'renamed-with-lost-id', 'recorded-id-only'].includes(mutation))
        {
            fixture.state.container = container;
        }
        if (mutation === 'renamed-with-lost-id')
        {
            container.Name = 'renamed-owned-allocation';
            document.containerId = null;
            document.createdAt = null;
            document.stateDigest = digestReceiptBody(document, 'stateDigest');
            fs.writeFileSync(service.stateFile, JSON.stringify(document));
            fs.unlinkSync(path.join(service.directory, 'container.id'));
        }
        if (mutation === 'recorded-id-only')
        {
            container.Name = 'renamed-conflicting-allocation';
            container.Config.Labels['io.fsusblog.test.mysql-recovery-binding'] = `sha256:${'f'.repeat(64)}`;
        }
        if (mutation === 'name-conflict' || mutation === 'daemon-unavailable')
        {
            options.docker = (command, args, parameters) => mutation === 'daemon-unavailable'
                ? { status: 1, stderr: 'private daemon error' }
                : args.at(-1).startsWith('name=') ? { status: 0, stdout: 'e'.repeat(64) }
                    : fixture.options.docker(command, args, parameters);
        }
        const bytes = fs.readFileSync(service.stateFile);
        assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, options),
            /remaining or conflicting container|Docker version failed/u, mutation);
        assert.deepEqual(fs.readFileSync(service.stateFile), bytes, mutation);
        assert.deepEqual(fixture.state.removalIds, [fixture.id], mutation);
    }
});

test('MySQL cleanup verification refuses changed/linked journals, CID records, residual credentials and recovery locks', async (t) =>
{
    for (const mutation of ['journal-digest', 'journal-symlink', 'journal-hardlink', 'cid-crossed', 'cid-symlink',
        'credential', 'credential-dangling-link', 'directory-symlink', 'recovery-lock'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        await service.cleanup();
        const foreign = path.join(fixture.context.root, 'preserved.json');
        const bytes = fs.readFileSync(service.stateFile);
        fs.writeFileSync(foreign, bytes, { mode: 0o600 });
        if (mutation.startsWith('journal-'))
        {
            if (mutation === 'journal-digest')
            {
                const state = JSON.parse(bytes);
                state.stateDigest = `sha256:${'0'.repeat(64)}`;
                fs.writeFileSync(service.stateFile, JSON.stringify(state));
            }
            else
            {
                fs.unlinkSync(service.stateFile);
                if (mutation === 'journal-symlink')
                {
                    fs.symlinkSync(foreign, service.stateFile);
                }
                else
                {
                    fs.linkSync(foreign, service.stateFile);
                }
            }
        }
        if (mutation.startsWith('cid-'))
        {
            const cid = path.join(service.directory, 'container.id');
            fs.unlinkSync(cid);
            if (mutation === 'cid-symlink')
            {
                fs.symlinkSync(foreign, cid);
            }
            else
            {
                fs.writeFileSync(cid, 'e'.repeat(64));
            }
        }
        if (mutation === 'credential')
        {
            fs.writeFileSync(service.clientOptionsFile, 'private', { mode: 0o600 });
        }
        if (mutation === 'credential-dangling-link')
        {
            fs.symlinkSync(path.join(fixture.context.root, 'absent'), service.clientOptionsFile);
        }
        if (mutation === 'directory-symlink')
        {
            fs.renameSync(service.directory, `${service.directory}.preserved`);
            fs.symlinkSync(`${service.directory}.preserved`, service.directory);
        }
        if (mutation === 'recovery-lock')
        {
            fs.mkdirSync(path.join(service.directory, 'recovery.lock'), { mode: 0o700 });
        }
        const calls = fixture.state.calls.length;
        assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)), undefined, mutation);
        assert.equal(fixture.state.calls.length, calls, mutation);
        assert.deepEqual(fs.readFileSync(foreign), bytes, mutation);
        assert.deepEqual(fixture.state.removalIds, [fixture.id], mutation);
    }
});

test('MySQL cleanup verification rereads state, directory, CID, credentials and lock after actual observations', async (t) =>
{
    for (const mutation of ['journal', 'directory', 'cid-change', 'cid-remove', 'cid-add', 'credential', 'lock'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        await service.cleanup();
        const cid = path.join(service.directory, 'container.id');
        if (mutation === 'cid-add')
        {
            fs.unlinkSync(cid);
        }
        let observed = false;
        fixture.state.onContainerLookup = () =>
        {
            if (observed)
            {
                return;
            }
            observed = true;
            if (mutation === 'journal')
            {
                fs.appendFileSync(service.stateFile, '\n');
            }
            if (mutation === 'directory')
            {
                fs.renameSync(service.directory, `${service.directory}.preserved`);
                fs.cpSync(`${service.directory}.preserved`, service.directory, { recursive: true });
                fs.chmodSync(service.directory, 0o700);
            }
            if (mutation === 'cid-change' || mutation === 'cid-add')
            {
                fs.writeFileSync(cid, 'e'.repeat(64));
            }
            if (mutation === 'cid-remove')
            {
                fs.unlinkSync(cid);
            }
            if (mutation === 'credential')
            {
                fs.writeFileSync(service.clientOptionsFile, 'private', { mode: 0o600 });
            }
            if (mutation === 'lock')
            {
                fs.mkdirSync(path.join(service.directory, 'recovery.lock'), { mode: 0o700 });
            }
        };
        assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)),
            /changed during observation|retained credential|unresolved recovery lock/u, mutation);
        assert.ok(observed, mutation);
        assert.deepEqual(fixture.state.removalIds, [fixture.id], mutation);
    }
});

test('MySQL cleanup verification uses one bounded observation budget without mutating successful cleanup', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    await service.cleanup();
    const bytes = fs.readFileSync(service.stateFile);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    fixture.state.onContainerLookup = () =>
    {
        now += fixture.context.cleanupBudgetMs;
    };
    const calls = fixture.state.calls.length;
    assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)), /total cleanup budget/u);
    assert.equal(fixture.state.calls.length, calls + 3);
    assert.deepEqual(fs.readFileSync(service.stateFile), bytes);
    fixture.state.onContainerLookup = null;
    assert.deepEqual(verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)).cleanup,
        { containerAbsent: true, credentialsRemoved: true });
});

test('MySQL creation binds a complete Docker runtime and refuses a switch before any credentials or container', async (t) =>
{
    for (const mutation of ['missing-runtime', 'switched-runtime'])
    {
        const fixture = controlledMySqlLifecycle(t);
        if (mutation === 'missing-runtime')
        {
            fixture.state.runtimeIdentity.serverId = '';
        }
        else
        {
            const retain = fixture.options.retainRecoveryBinding;
            fixture.options.retainRecoveryBinding = async (binding) =>
            {
                await retain(binding);
                fixture.state.runtimeIdentity.serverId = 'another-engine';
            };
        }
        await assert.rejects(prepareMySqlFixtureService(fixture.context, fixture.options),
            /runtime identity is incomplete|preparation and exact cleanup failed/u, mutation);
        assert.equal(fixture.state.createCount, 0, mutation);
        assert.deepEqual(fixture.state.removalIds, [], mutation);
        if (mutation === 'switched-runtime')
        {
            const binding = fixture.state.recoveryBinding;
            for (const file of ['container.env', 'client.cnf'])
            {
                assert.equal(fs.existsSync(path.join(path.dirname(binding.stateFile), file)), false, mutation);
            }
            fixture.state.runtimeIdentity.serverId = 'fixture-engine';
            await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
            assert.deepEqual(verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)).cleanup,
                { containerAbsent: true, credentialsRemoved: true });
        }
    }
});

test('MySQL cleanup, recovery and verification reject another Docker runtime and preserve the original allocation', async (t) =>
{
    for (const actor of ['cleanup', 'recovery', 'verification'])
    {
        for (const field of ['serverId', 'serverVersion', 'operatingSystem', 'architecture', 'cgroupDriver'])
        {
            const fixture = controlledMySqlLifecycle(t);
            const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
            if (actor === 'verification')
            {
                await service.cleanup();
            }
            const before = fs.readFileSync(service.stateFile);
            const original = fixture.state.runtimeIdentity[field];
            fixture.state.runtimeIdentity[field] = 'foreign-runtime';
            const calls = fixture.state.calls.length;
            if (actor === 'cleanup')
            {
                await assert.rejects(service.cleanup, /runtime identity changed/u, field);
            }
            else if (actor === 'recovery')
            {
                await assert.rejects(recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture)), /runtime identity changed/u, field);
            }
            else
            {
                assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)), /runtime identity changed/u, field);
                assert.deepEqual(fs.readFileSync(service.stateFile), before, field);
            }
            assert.deepEqual(fixture.state.calls.slice(calls).map(({ args }) => args[0]), ['version', 'info'], field);
            assert.deepEqual(fixture.state.removalIds, actor === 'verification' ? [fixture.id] : [], field);
            assert.equal(fs.existsSync(service.clientOptionsFile), actor !== 'verification', field);
            fixture.state.runtimeIdentity[field] = original;
            // Recovery owns the changed journal after a failed recovery attempt.
            if (actor === 'recovery')
            {
                await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
            }
            else if (actor === 'cleanup')
            {
                await service.cleanup();
            }
            assert.deepEqual(verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)).cleanup,
                { containerAbsent: true, credentialsRemoved: true });
        }
    }
});

test('MySQL cleanup and verification reobserve runtime identity after absence queries', async (t) =>
{
    for (const actor of ['cleanup', 'verification'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        if (actor === 'verification')
        {
            await service.cleanup();
        }
        const before = fs.readFileSync(service.stateFile);
        fixture.state.onContainerLookup = () =>
        {
            fixture.state.runtimeIdentity.serverId = 'another-engine';
        };
        if (actor === 'cleanup')
        {
            await assert.rejects(service.cleanup, /runtime identity changed/u);
            assert.ok(fs.existsSync(service.clientOptionsFile));
            assert.deepEqual(fixture.state.removalIds, []);
        }
        else
        {
            assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)), /runtime identity changed/u);
            assert.deepEqual(fs.readFileSync(service.stateFile), before);
        }
        fixture.state.onContainerLookup = null;
        fixture.state.runtimeIdentity.serverId = 'fixture-engine';
        if (actor === 'cleanup')
        {
            await service.cleanup();
        }
        assert.deepEqual(verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)).cleanup,
            { containerAbsent: true, credentialsRemoved: true });
    }
});

test('MySQL retained runtime binding rejects rehashed daemon substitution and old unbound lifecycle records', async (t) =>
{
    for (const mutation of ['runtime', 'legacy'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        await service.cleanup();
        const state = JSON.parse(fs.readFileSync(service.stateFile));
        assert.equal(state.schema, 'fsusblog.mysql-service-lifecycle.v3');
        assert.deepEqual(state.runtimeIdentity, fixture.state.runtimeIdentity);
        if (mutation === 'runtime')
        {
            state.runtimeIdentity.serverId = 'forged-engine';
        }
        else
        {
            state.schema = 'fsusblog.mysql-service-lifecycle.v2';
            delete state.runtimeIdentity;
        }
        state.stateDigest = digestReceiptBody(state, 'stateDigest');
        fs.writeFileSync(service.stateFile, JSON.stringify(state));
        const calls = fixture.state.calls.length;
        assert.throws(() => verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)), /retained binding/u, mutation);
        await assert.rejects(recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture)), /retained binding/u, mutation);
        assert.equal(fixture.state.calls.length, calls, mutation);
    }
});

test('MySQL recovery requires a retained binding and refuses live, reused or unverifiable controllers', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    const options = recoveryOptions(fixture);
    const calls = fixture.state.calls.length;
    await assert.rejects(recoverMySqlFixtureService(fixture.context, { ...options, expectedBindingDigest: undefined }), /supervisor-retained/u);
    await assert.rejects(recoverMySqlFixtureService(fixture.context, { ...options, expectedBindingDigest: `sha256:${'0'.repeat(64)}` }), /retained binding/u);
    await assert.rejects(recoverMySqlFixtureService(fixture.context, { ...options, observeController: undefined }), /proven dead/u);
    for (const status of ['live', 'mismatch', 'unverifiable'])
    {
        await assert.rejects(recoverMySqlFixtureService(fixture.context, { ...options, observeController: () => ({ status }) }), /proven dead/u);
    }
    assert.equal(fixture.state.calls.length, calls);
    assert.deepEqual(fixture.state.removalIds, []);
    assert.equal(fs.existsSync(path.join(service.directory, 'recovery.lock')), false);
    await service.cleanup();
});

test('MySQL recovery reuses exact cleanup after source and grant expiry and rereads already-cleaned identity', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    fixture.state.held = false;
    fixture.state.source.commit = 'e'.repeat(40);
    fixture.state.container.Name = 'renamed-owned-id';
    const result = await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
    assert.deepEqual(result, { qualificationEligible: false, stateFile: service.stateFile,
        cleanup: { containerAbsent: true, credentialsRemoved: true } });
    assert.equal(fs.existsSync(service.clientOptionsFile), false);
    assert.equal(fs.existsSync(path.join(service.directory, 'container.env')), false);
    assert.equal(fs.existsSync(path.join(service.directory, 'recovery.lock')), false);
    await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
});

test('MySQL recovery covers durable pre-create, CID-only, exact-name and post-removal crash boundaries', async (t) =>
{
    for (const phase of ['pre-create', 'cid-only', 'name-only', 'post-removal'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        const cid = path.join(service.directory, 'container.id');
        if (phase === 'pre-create')
        {
            fixture.state.container = null;
            fs.unlinkSync(cid);
            fs.writeFileSync(service.stateFile, fixture.state.boundRecord);
        }
        else if (phase === 'post-removal')
        {
            fixture.state.container = null;
        }
        else
        {
            fs.writeFileSync(service.stateFile, fixture.state.beforeCreateRecord);
            if (phase === 'name-only')
            {
                fs.unlinkSync(cid);
            }
        }
        await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
        assert.deepEqual(verifyMySqlFixtureServiceCleanup(fixture.context, recoveryOptions(fixture)).cleanup,
            { containerAbsent: true, credentialsRemoved: true }, phase);
        assert.equal(fixture.state.container, null, phase);
        assert.equal(fs.existsSync(service.clientOptionsFile), false, phase);
        assert.equal(JSON.parse(fs.readFileSync(service.stateFile)).phase, 'cleaned', phase);
        assert.deepEqual(fixture.state.removalIds, phase === 'pre-create' || phase === 'post-removal' ? [] : [fixture.id], phase);
    }
});

test('MySQL recovery rejects missing, malformed, forged, linked or concurrently owned records without deletion', async (t) =>
{
    for (const mutation of ['missing', 'json', 'digest', 'binding', 'identity', 'controller', 'extra', 'cid', 'state-symlink', 'hardlink', 'directory-symlink', 'lock'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        const original = fs.readFileSync(service.stateFile);
        const document = JSON.parse(original);
        const foreign = path.join(fixture.context.root, 'preserved-state.json');
        fs.writeFileSync(foreign, original, { mode: 0o600 });
        if (mutation === 'missing' || mutation === 'state-symlink' || mutation === 'hardlink')
        {
            fs.unlinkSync(service.stateFile);
            if (mutation === 'state-symlink')
            {
                fs.symlinkSync(foreign, service.stateFile);
            }
            if (mutation === 'hardlink')
            {
                fs.linkSync(foreign, service.stateFile);
            }
        }
        else if (mutation === 'directory-symlink')
        {
            fs.renameSync(service.directory, `${service.directory}.preserved`);
            fs.symlinkSync(`${service.directory}.preserved`, service.directory);
        }
        else if (mutation === 'lock')
        {
            fs.mkdirSync(path.join(service.directory, 'recovery.lock'));
        }
        else if (mutation === 'cid')
        {
            fs.writeFileSync(path.join(service.directory, 'container.id'), 'e'.repeat(64));
        }
        else if (mutation === 'json')
        {
            fs.writeFileSync(service.stateFile, '{');
        }
        else
        {
            if (mutation === 'digest')
            {
                document.stateDigest = `sha256:${'0'.repeat(64)}`;
            }
            if (mutation === 'binding')
            {
                document.labels['io.fsusblog.test.mysql-lifecycle-token'] = 'f'.repeat(64);
            }
            if (mutation === 'identity')
            {
                document.identity.namespace = 'foreign';
            }
            if (mutation === 'controller')
            {
                document.controllerIdentity.pid++;
            }
            if (mutation === 'extra')
            {
                document.unreviewedAuthority = true;
            }
            if (mutation !== 'digest')
            {
                document.stateDigest = digestReceiptBody(document, 'stateDigest');
            }
            fs.writeFileSync(service.stateFile, JSON.stringify(document));
        }
        await assert.rejects(recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture)), undefined, mutation);
        assert.deepEqual(fixture.state.removalIds, [], mutation);
        assert.ok(fs.existsSync(service.clientOptionsFile), mutation);
        assert.deepEqual(fs.readFileSync(foreign), original, mutation);
    }
});

test('MySQL recovery refuses changed container identity and permits only an exact explicit retry', async (t) =>
{
    for (const field of ['token', 'binding', 'created', 'image', 'pin', 'id'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        const original = structuredClone(fixture.state.container);
        const container = fixture.state.container;
        if (field === 'token')
        {
            container.Config.Labels['io.fsusblog.test.mysql-lifecycle-token'] = 'f'.repeat(64);
        }
        if (field === 'binding')
        {
            container.Config.Labels['io.fsusblog.test.mysql-recovery-binding'] = `sha256:${'f'.repeat(64)}`;
        }
        if (field === 'created')
        {
            container.Created = '2026-09-25T00:00:00.000Z';
        }
        if (field === 'image')
        {
            container.Image = `sha256:${'f'.repeat(64)}`;
        }
        if (field === 'pin')
        {
            container.Config.Image = 'mysql:latest';
        }
        if (field === 'id')
        {
            container.Id = 'f'.repeat(64);
        }
        await assert.rejects(recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture)), /ownership or image mismatch/u, field);
        assert.deepEqual(fixture.state.removalIds, [], field);
        assert.ok(fs.existsSync(service.clientOptionsFile), field);
        assert.equal(JSON.parse(fs.readFileSync(service.stateFile)).phase, 'cleanup-failed', field);
        fixture.state.container = original;
        await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
        assert.deepEqual(fixture.state.removalIds, [fixture.id], field);
    }
});

test('MySQL creation is refused if the supervisor cannot retain the pre-create binding', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    fixture.options.retainRecoveryBinding = async () =>
    {
        throw new Error('supervisor storage failed');
    };
    await assert.rejects(prepareMySqlFixtureService(fixture.context, fixture.options), /supervisor storage failed/u);
    assert.equal(fixture.state.createCount, 0);
    assert.deepEqual(fixture.state.removalIds, []);
});

test('MySQL recovery checks controller and journal again after acquiring exclusive ownership', async (t) =>
{
    for (const mutation of ['live-controller', 'changed-record'])
    {
        const fixture = controlledMySqlLifecycle(t);
        const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
        const bytes = fs.readFileSync(service.stateFile);
        let checks = 0;
        const options = { ...recoveryOptions(fixture), observeController: () =>
        {
            checks++;
            if (checks === 2)
            {
                if (mutation === 'live-controller')
                {
                    return { status: 'live' };
                }
                fs.writeFileSync(service.stateFile, '{}');
            }
            return { status: 'dead' };
        } };
        await assert.rejects(recoverMySqlFixtureService(fixture.context, options));
        assert.equal(checks, 2);
        assert.deepEqual(fixture.state.removalIds, []);
        assert.ok(fs.existsSync(service.clientOptionsFile));
        assert.equal(fs.existsSync(path.join(service.directory, 'recovery.lock')), false);
        fs.writeFileSync(service.stateFile, bytes);
        await service.cleanup();
    }
});

test('MySQL recovery retains its total cleanup budget and permits only a new explicit bounded retry', async (t) =>
{
    const fixture = controlledMySqlLifecycle(t);
    const service = await prepareMySqlFixtureService(fixture.context, fixture.options);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    fixture.state.onContainerLookup = () =>
    {
        now += fixture.context.cleanupBudgetMs;
    };
    await assert.rejects(recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture)), /total cleanup budget/u);
    assert.deepEqual(fixture.state.removalIds, []);
    assert.ok(fs.existsSync(service.clientOptionsFile));
    assert.equal(fs.existsSync(path.join(service.directory, 'recovery.lock')), false);
    fixture.state.onContainerLookup = null;
    await recoverMySqlFixtureService(fixture.context, recoveryOptions(fixture));
    assert.deepEqual(fixture.state.removalIds, [fixture.id]);
});

test('service catalog exactly covers matrix services with immutable container references', () =>
{
    assert.deepEqual(validateExecutionServiceCatalog(catalog, matrix), []);
    assert.deepEqual(catalog.services.mysql.resourceGrant, {
        cpuUnits: 1, memoryHighBytes: 536870912, memoryMaxBytes: 1073741824, pidsMax: 128
    });
    assert.match(catalog.services.postgres.imageReference, /@sha256:[a-f0-9]{64}$/u);
    assert.match(catalog.services.redis.imageReference, /@sha256:[a-f0-9]{64}$/u);
    assert.equal(catalog.correctnessPhase.imagePull, 'denied');
    assert.equal(catalog.correctnessPhase.hostFallback, 'denied');
    assert.equal(catalog.schema, 'fsusblog.test-execution-service-catalog.v2');
    assert.equal(catalog.version, 2);
    assert.equal(
        catalog.services.postgres.databaseIdentityAuthority,
        'postgres-control-system-exact'
    );
    assert.equal(catalog.services.postgres.database, 'fsusblog');
    assert.equal(catalog.services.postgres.username, 'fsusblog');
    assert.equal(catalog.services.postgres.serverVersionNumber, '160015');
    assert.equal(executionServiceImageReference('postgres'), catalog.services.postgres.imageReference);
    assert.throws(() => executionServiceImageReference('unknown'), /pinned execution service image/u);
    assert.deepEqual(requiredExecutionServices('integration', applicability), [
        'backend', 'frontend', 'postgres', 'redis'
    ]);
});

test('run-owned services require live process, source, artifact, config, topology, and limits', () =>
{
    const processIdentity = {
        pid: 42,
        processStartIdentity: 'linux:boot:100',
        executablePath: '/run/backend',
        executableDigest: `sha256:${'a'.repeat(64)}`,
        commandDigest: `sha256:${'b'.repeat(64)}`
    };
    const evidence = {
        sourceCommit: 'c'.repeat(40),
        worktreeFingerprint: `sha256:${'d'.repeat(64)}`,
        artifactDigest: `sha256:${'e'.repeat(64)}`,
        configDigest: `sha256:${'f'.repeat(64)}`,
        processIdentity,
        topology: {
            port: 24001,
            networkNamespace: 'run-owned-loopback',
            resourceLimits: { cpuUnits: 1, memoryGiB: 1 }
        }
    };
    const observed = observeRunOwnedService({
        id: 'backend',
        evidence,
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'live', actual: processIdentity })
    });
    assert.equal(observed.artifactDigest, evidence.artifactDigest);
    assert.throws(() => observeRunOwnedService({
        id: 'backend',
        evidence: { ...evidence, configDigest: null },
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'live', actual: processIdentity })
    }), /configDigest is incomplete/u);
    assert.throws(() => observeRunOwnedService({
        id: 'backend',
        evidence,
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'dead' })
    }), /process identity drift/u);
});

test('floating tags, implicit host services, and missing matrix services fail closed', () =>
{
    for (const mutate of [
        (candidate) =>
        {
            candidate.services.postgres.imageReference = 'postgres:16-alpine';
        },
        (candidate) =>
        {
            candidate.services.redis.hostNativeAllowed = true;
        },
        (candidate) =>
        {
            delete candidate.services.backend;
        },
        (candidate) =>
        {
            candidate.correctnessPhase.imagePull = 'allowed';
        },
        (candidate) =>
        {
            candidate.services.postgres.databaseIdentityAuthority = 'container-env';
        },
        (candidate) =>
        {
            candidate.services.postgres.database = 'postgres';
        },
        (candidate) =>
        {
            candidate.services.postgres.username = 'postgres';
        },
        (candidate) =>
        {
            candidate.services.postgres.serverVersionNumber = '160014';
        },
        (candidate) =>
        {
            candidate.services.postgres.requiredIdentityFields.pop();
        },
        (candidate) =>
        {
            candidate.services.postgres.unownedAuthority = true;
        }
    ])
    {
        const candidate = structuredClone(catalog);
        mutate(candidate);
        assert.notDeepEqual(validateExecutionServiceCatalog(candidate, matrix), []);
    }
});

test('runtime, image, version, topology, ports, and limits are exact-match admission facts', () =>
{
    let generation = 0;
    const runtime = {
        serverVersion: '29.0.0',
        serverId: 'engine',
        operatingSystem: 'linux',
        architecture: 'amd64',
        cgroupDriver: 'systemd'
    };
    const service = ({ id, catalogEntry }) => ({
        id,
        kind: 'container',
        containerId: `${id}-${generation}`,
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalogEntry.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalogEntry.imageReference,
        serviceVersion: catalogEntry.version,
        networkMode: 'bridge',
        networkNamespace: '/run/netns/fixture',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        ...(id === 'postgres' ? {
            databaseIdentity: {
                systemIdentifier: '7612345678901234567',
                database: 'fsusblog',
                username: 'fsusblog',
                serverVersion: '16.15',
                serverVersionNumber: '160015'
            }
        } : {})
    });
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-1',
        containers: { postgres: 'pg', redis: 'redis' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: service
    });
    assert.equal(envelope.schema, 'fsusblog.test-execution-envelope-services.v2');
    assert.equal(envelope.admission, 'planned-actual-exact');
    assert.deepEqual(envelope.planned, envelope.actual);
    assert.equal(
        envelope.actual.services.find((entry) => entry.id === 'postgres')
            .databaseIdentity.systemIdentifier,
        '7612345678901234567'
    );
    generation = 1;
    assert.throws(() => createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-1',
        containers: { postgres: 'pg' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: () =>
        {
            generation += 1;
            return service({ id: 'postgres', catalogEntry: catalog.services.postgres });
        }
    }), /planned\/actual service envelope drift/u);
});

function postgresDocker(identityOutput)
{
    const calls = [];
    const imageId = `sha256:${'a'.repeat(64)}`;
    const docker = (command, args) =>
    {
        calls.push([command, args]);
        if (args[0] === 'inspect')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: 'postgres-container',
                    Created: '2026-01-01T00:00:00Z',
                    State: { Running: true },
                    Config: { Image: catalog.services.postgres.imageReference },
                    Image: imageId,
                    HostConfig: {
                        NetworkMode: 'bridge',
                        NanoCpus: 1,
                        Memory: 2,
                        MemoryReservation: 1,
                        PidsLimit: 64
                    },
                    NetworkSettings: {
                        SandboxKey: '/run/netns/postgres',
                        Ports: {
                            '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }]
                        }
                    }
                }])
            };
        }
        if (args[0] === 'image')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: imageId,
                    RepoDigests: [catalog.services.postgres.imageReference]
                }])
            };
        }
        if (args[0] === 'exec' && args.includes('postgres'))
        {
            return { status: 0, stdout: 'postgres (PostgreSQL) 16.15\n' };
        }
        if (args[0] === 'exec' && args.includes('psql'))
        {
            return {
                status: 0,
                stdout: typeof identityOutput === 'string'
                    ? identityOutput
                    : `${JSON.stringify(identityOutput)}\n`
            };
        }
        throw new Error(`unexpected Docker call: ${args.join(' ')}`);
    };
    return { calls, docker };
}

test('PostgreSQL observation exact-binds the live database and cluster identity', () =>
{
    const identity = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15',
        serverVersionNumber: '160015'
    };
    const fixture = postgresDocker(identity);
    const observed = observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: fixture.docker
    });
    assert.deepEqual(observed.databaseIdentity, identity);
    const psql = fixture.calls.find(([, args]) => args.includes('psql'))?.[1];
    assert.deepEqual(psql.slice(0, 4), [
        'exec',
        'fsusblog-test-postgres-run',
        'psql',
        '--no-psqlrc'
    ]);
    assert.equal(psql[psql.indexOf('--dbname') + 1], 'fsusblog');
    assert.equal(psql[psql.indexOf('--username') + 1], 'fsusblog');
    assert.match(psql.at(-1), /pg_control_system\(\)/u);
    assert.match(psql.at(-1), /current_setting\('server_version_num'\)/u);
});

test('PostgreSQL catalog version admits a distro suffix with an exact prefix boundary', () =>
{
    const identity = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15 (Debian 16.15-1.pgdg120+1)',
        serverVersionNumber: '160015'
    };
    assert.equal(observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: postgresDocker(identity).docker
    }).databaseIdentity.serverVersion, identity.serverVersion);
    assert.throws(() => observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: postgresDocker({ ...identity, serverVersion: '16.150 vendor' }).docker
    }), /database identity drift/u);
});

test('malformed or drifting PostgreSQL live identity fails closed', () =>
{
    const valid = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15',
        serverVersionNumber: '160015'
    };
    const candidates = [
        '{not-json',
        { ...valid, systemIdentifier: 761234 },
        { ...valid, database: 'postgres' },
        { ...valid, username: 'postgres' },
        { ...valid, serverVersion: '16.14' },
        { ...valid, serverVersionNumber: '160014' },
        { ...valid, extra: true }
    ];
    for (const candidate of candidates)
    {
        assert.throws(() => observeContainerService({
            id: 'postgres',
            containerName: 'fsusblog-test-postgres-run',
            catalogEntry: catalog.services.postgres,
            docker: postgresDocker(candidate).docker
        }), /database identity (?:is malformed|drift)/u);
    }
});

test('planned and actual PostgreSQL cluster identity drift fails closed', () =>
{
    let observation = 0;
    const service = ({ id, catalogEntry }) => ({
        id,
        kind: 'container',
        containerId: 'postgres-container',
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalogEntry.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalogEntry.imageReference,
        serviceVersion: '16.15',
        networkMode: 'bridge',
        networkNamespace: '/run/netns/postgres',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        databaseIdentity: {
            systemIdentifier: String(7612345678901234567n + BigInt(observation++)),
            database: 'fsusblog',
            username: 'fsusblog',
            serverVersion: '16.15',
            serverVersionNumber: '160015'
        }
    });
    assert.throws(() => createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-database-drift',
        requiredServices: ['postgres'],
        containers: { postgres: 'pg' },
        catalog,
        observeRuntime: () => ({
            serverVersion: '29.0.0',
            serverId: 'engine',
            operatingSystem: 'linux',
            architecture: 'amd64',
            cgroupDriver: 'systemd'
        }),
        observeService: service
    }), /planned\/actual service envelope drift/u);
});

function liveEnvelopeFixture()
{
    const runtime = {
        serverVersion: '29.0.0',
        serverId: 'engine',
        operatingSystem: 'linux',
        architecture: 'amd64',
        cgroupDriver: 'systemd'
    };
    const service = {
        id: 'postgres',
        kind: 'container',
        containerId: 'exact-postgres-container-id',
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalog.services.postgres.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalog.services.postgres.imageReference,
        serviceVersion: 'postgres (PostgreSQL) 16.15',
        networkMode: 'bridge',
        networkNamespace: '/run/netns/postgres',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        databaseIdentity: {
            systemIdentifier: '7612345678901234567',
            database: 'fsusblog',
            username: 'fsusblog',
            serverVersion: '16.15 (Debian 16.15-1.pgdg120+1)',
            serverVersionNumber: '160015'
        }
    };
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-live-verification',
        requiredServices: ['postgres'],
        containers: { postgres: 'mutable-name-is-not-reused' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: () => structuredClone(service)
    });
    return { envelope, runtime, service };
}

test('live verification addresses containers by admitted ID and exact-matches all identity', () =>
{
    const { envelope, runtime, service } = liveEnvelopeFixture();
    let addressedContainer;
    const verified = verifyLiveServiceEnvelope({
        envelope,
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: ({ containerName }) =>
        {
            addressedContainer = containerName;
            return structuredClone(service);
        }
    });
    assert.equal(verified, envelope);
    assert.equal(addressedContainer, service.containerId);
});

test('forged planned-equals-actual envelopes fail against live runtime and service identity', () =>
{
    const cases = [
        ['runtime', (candidate) =>
        {
            candidate.actual.runtime.serverId = 'forged-engine';
        }],
        ['imageId', (candidate) =>
        {
            candidate.actual.services[0].imageId = `sha256:${'b'.repeat(64)}`;
        }],
        ['network mode', (candidate) =>
        {
            candidate.actual.services[0].networkMode = 'host';
        }],
        ['network namespace', (candidate) =>
        {
            candidate.actual.services[0].networkNamespace = '/run/netns/forged';
        }],
        ['resource limit', (candidate) =>
        {
            candidate.actual.services[0].resourceLimits.memory = 3;
        }],
        ['port topology', (candidate) =>
        {
            candidate.actual.services[0].ports[0].hostPort = '15433';
        }],
        ['creation identity', (candidate) =>
        {
            candidate.actual.services[0].createdAt = '2026-01-02T00:00:00Z';
        }],
        ['service version', (candidate) =>
        {
            candidate.actual.services[0].serviceVersion = 'postgres (PostgreSQL) 16.15 forged';
        }],
        ['database instance', (candidate) =>
        {
            candidate.actual.services[0].databaseIdentity.systemIdentifier =
                '7612345678901234568';
        }]
    ];
    for (const [label, mutate] of cases)
    {
        const { envelope, runtime, service } = liveEnvelopeFixture();
        mutate(envelope);
        envelope.planned = structuredClone(envelope.actual);
        assert.throws(() => verifyLiveServiceEnvelope({
            envelope,
            catalog,
            observeRuntime: () => structuredClone(runtime),
            observeService: () => structuredClone(service)
        }), /live planned\/actual service envelope drift/u, label);
    }
});

test('live verification option parsing is closed and single-occurrence', () =>
{
    assert.deepEqual(
        [...parseExecutionEnvelopeServicesOptions([
            '--verify-envelope', 'envelope.json',
            '--service-catalog', 'catalog.json'
        ])],
        [
            ['--verify-envelope', 'envelope.json'],
            ['--service-catalog', 'catalog.json']
        ]
    );
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--verify-envelope', 'one.json',
        '--verify-envelope', 'two.json'
    ]), /duplicate execution envelope service option/u);
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--unowned-option', 'value'
    ]), /unknown execution envelope service option/u);
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--verify-envelope'
    ]), /name\/value pairs/u);
});

test('container publication options bind exactly the declared PostgreSQL, Redis and MySQL services', () =>
{
    for (const ids of [[], ['postgres'], ['redis'], ['mysql'], ['postgres', 'redis', 'mysql']])
    {
        const options = ids.flatMap((id) => [`--${id}-container`, `owned-${id}`]);
        const values = parseExecutionEnvelopeServicesOptions(options);
        assert.deepEqual(resolveExecutionServiceContainers(values, ids),
            Object.fromEntries(ids.map((id) => [id, `owned-${id}`])));
    }
    for (const id of ['postgres', 'redis', 'mysql'])
    {
        assert.throws(() => resolveExecutionServiceContainers(new Map(), [id]),
            /must be present exactly when/u);
        assert.throws(() => resolveExecutionServiceContainers(
            new Map([[`--${id}-container`, `owned-${id}`]]), []),
        /must be present exactly when/u);
    }
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--mysql-container', 'first', '--mysql-container', 'second'
    ]), /duplicate execution envelope service option/u);
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--mysql-container', ' '
    ]), /requires a value/u);
    assert.throws(() => resolveExecutionServiceContainers(
        new Map([['--postgres-container', 'owned-postgres']]), ['mysql']),
    /must be present exactly when/u);
});

test('publication rejects incomplete, extra and wrong-kind bindings before any observation', () =>
{
    const base = {
        producerId: 'backend-unit',
        runId: 'run-service-admission',
        requiredServices: ['postgres'],
        containers: { postgres: 'owned-postgres' },
        runOwnedProcesses: {},
        catalog
    };
    const cases = [
        ['missing container', { containers: {} }],
        ['extra container', { containers: { postgres: 'owned-postgres', redis: 'extra' } }],
        ['wrong binding kind', { containers: {}, runOwnedProcesses: { postgres: {} } }],
        ['missing process', { requiredServices: ['backend'], containers: {} }],
        ['extra process', { runOwnedProcesses: { backend: {} } }],
        ['duplicate service', { requiredServices: ['postgres', 'postgres'] }],
        ['unknown service', { requiredServices: ['unknown'] }],
        ['inherited property', { requiredServices: ['toString'] }],
        ['empty service', { requiredServices: ['postgres', ''] }],
        ['invalid roster', { requiredServices: 'postgres' }],
        ['null roster', { requiredServices: null }],
        ['invalid container map', { containers: [] }],
        ['null process map', { runOwnedProcesses: null }],
        ['absent container identity', { containers: { postgres: undefined } }],
        ['blank container identity', { containers: { postgres: ' ' } }],
        ['container option injection', { containers: { postgres: '--all' } }],
        ['nonstring container identity', { containers: { postgres: 123 } }],
        ['missing producer', { producerId: '' }],
        ['missing run', { runId: '' }],
        ['invalid catalog', { catalog: { ...catalog, version: 1 } }],
        ['unregistered MySQL', {
            requiredServices: ['mysql'],
            containers: { mysql: 'owned-mysql' },
            catalog: {
                ...catalog,
                services: Object.fromEntries(Object.entries(catalog.services).filter(([id]) => id !== 'mysql'))
            }
        }],
        ['implicit duplicate ownership', {
            requiredServices: undefined, runOwnedProcesses: { postgres: {} }
        }]
    ];
    for (const [label, override] of cases)
    {
        let observations = 0;
        const unexpectedObservation = () =>
        {
            observations += 1;
            throw new Error('unexpected observation before input rejection');
        };
        assert.throws(() => createAndAdmitServiceEnvelope({
            ...base,
            ...override,
            observeRuntime: unexpectedObservation,
            observeService: unexpectedObservation,
            observeProcessService: unexpectedObservation
        }), /service (bindings|roster|catalog|admission)|container name or ID/u, label);
        assert.equal(observations, 0, label);
    }
});

function controlledMySqlServiceFixture(runId = 'run-mysql-observer-fixture')
{
    // A controlled observer contract, not live MySQL qualification.
    const fixtureCatalog = structuredClone(catalog);
    fixtureCatalog.services.mysql = {
        ...fixtureCatalog.services.redis,
        imageReference: 'mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d',
        version: '8.4.11',
        versionCommand: ['mysql', '--version'],
        databaseIdentityAuthority: 'mysql-server-uuid-exact',
        username: 'fixture_user',
        clientOptionsFile: '/run/fsusblog-mysql/client.cnf',
        resourceGrant: structuredClone(catalog.services.mysql.resourceGrant),
        requiredIdentityFields: [...fixtureCatalog.services.redis.requiredIdentityFields, 'databaseIdentity', 'ownership']
    };
    const { runtime, service: postgresService } = liveEnvelopeFixture();
    const service = structuredClone(postgresService);
    Object.assign(service, {
        id: 'mysql',
        containerId: 'owned-mysql-id',
        imageReference: fixtureCatalog.services.mysql.imageReference,
        repositoryDigest: fixtureCatalog.services.mysql.imageReference,
        serviceVersion: 'mysql  Ver 8.4.11 for Linux on x86_64 (MySQL Community Server - GPL)',
        networkNamespace: '/run/netns/mysql-fixture',
        ports: [{ containerPort: '3306/tcp', hostIp: '127.0.0.1', hostPort: '23306' }],
        databaseIdentity: {
            serverUuid: '12345678-1234-1234-1234-123456789abc',
            serverVersion: '8.4.11',
            currentUser: 'fixture_user@%',
            database: null,
            port: 3306
        },
        ownership: {
            runId,
            bundleId: 'matrix:backend-unit',
            stepId: 'migration-services',
            namespace: 'migration-test',
            repositoryRootDigest: `sha256:${'c'.repeat(64)}`
        }
    });
    return { catalog: fixtureCatalog, runtime, service };
}

test('a catalog-bound MySQL observer is admitted twice and live verification uses its exact ID', () =>
{
    const fixture = controlledMySqlServiceFixture();
    const values = parseExecutionEnvelopeServicesOptions(['--mysql-container', 'owned-mysql']);
    const addressed = [];
    const observeService = ({ id, containerName, catalogEntry }) =>
    {
        assert.equal(id, 'mysql');
        assert.deepEqual(catalogEntry, fixture.catalog.services.mysql);
        addressed.push(containerName);
        return structuredClone(fixture.service);
    };
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'backend-unit',
        runId: 'run-mysql-observer-fixture',
        requiredServices: ['mysql'],
        containers: resolveExecutionServiceContainers(values, ['mysql']),
        catalog: fixture.catalog,
        observeRuntime: () => structuredClone(fixture.runtime),
        observeService
    });
    assert.deepEqual(envelope.requiredServices, ['mysql']);
    assert.deepEqual(envelope.planned, envelope.actual);
    assert.equal(envelope.correctnessImagePull, 'denied');
    assert.equal(envelope.hostFallback, 'denied');
    verifyLiveServiceEnvelope({
        envelope,
        catalog: fixture.catalog,
        observeRuntime: () => structuredClone(fixture.runtime),
        observeService
    });
    assert.deepEqual(addressed, ['owned-mysql', 'owned-mysql', 'owned-mysql-id']);
    assert.throws(() => verifyLiveServiceEnvelope({
        envelope,
        catalog: fixture.catalog,
        observeRuntime: () => structuredClone(fixture.runtime),
        observeService: () => ({ ...fixture.service, id: 'redis' })
    }), /observed service identity owner drift/u);
});

test('controlled MySQL identity drift and a substituted service owner cannot publish admission', () =>
{
    for (const field of ['containerId', 'imageId', 'networkNamespace', 'ports', 'resourceLimits', 'id'])
    {
        const fixture = controlledMySqlServiceFixture('run-mysql-drift-fixture');
        let observations = 0;
        assert.throws(() => createAndAdmitServiceEnvelope({
            producerId: 'backend-unit',
            runId: 'run-mysql-drift-fixture',
            containers: { mysql: 'owned-mysql' },
            catalog: fixture.catalog,
            observeRuntime: () => structuredClone(fixture.runtime),
            observeService: () =>
            {
                const identity = structuredClone(fixture.service);
                if (observations++ > 0)
                {
                    identity[field] = field === 'imageId' ? `sha256:${'b'.repeat(64)}`
                        : field === 'ports' ? [{ ...identity.ports[0], hostPort: '23307' }]
                            : field === 'resourceLimits' ? { ...identity.resourceLimits, memory: 4 }
                                : 'substituted';
                }
                return identity;
            }
        }), /planned\/actual service envelope drift|observed service identity owner drift/u, field);
    }
});

function mysqlDockerFixture()
{
    const fixture = controlledMySqlServiceFixture();
    const entry = fixture.catalog.services.mysql;
    const identity = fixture.service;
    const container = {
        Id: identity.containerId,
        Created: identity.createdAt,
        State: { Running: true },
        Config: {
            Image: entry.imageReference,
            Labels: {
                'io.fsusblog.test.run-id': identity.ownership.runId,
                'io.fsusblog.test.bundle-id': identity.ownership.bundleId,
                'io.fsusblog.test.step-id': identity.ownership.stepId,
                'io.fsusblog.test.namespace': identity.ownership.namespace,
                'io.fsusblog.test.repository-root-digest': identity.ownership.repositoryRootDigest
            }
        },
        Image: identity.imageId,
        HostConfig: {
            NetworkMode: 'bridge',
            NanoCpus: identity.resourceLimits.nanoCpus,
            Memory: identity.resourceLimits.memory,
            MemoryReservation: identity.resourceLimits.memoryReservation,
            PidsLimit: identity.resourceLimits.pidsLimit
        },
        NetworkSettings: {
            SandboxKey: identity.networkNamespace,
            Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '23306' }], '33060/tcp': null }
        }
    };
    const calls = [];
    const queryResult = { status: 0, stdout: JSON.stringify(identity.databaseIdentity) };
    const docker = (command, args, options) =>
    {
        calls.push({ command, args, options });
        assert.equal(command, 'docker');
        assert.equal(options.shell, false);
        if (args[0] === 'inspect')
        {
            return { status: 0, stdout: JSON.stringify([container]) };
        }
        if (args[0] === 'image')
        {
            return { status: 0, stdout: JSON.stringify([{ Id: identity.imageId, RepoDigests: [entry.imageReference] }]) };
        }
        if (args[0] === 'exec' && args.includes('--version'))
        {
            return { status: 0, stdout: identity.serviceVersion };
        }
        assert.equal(args[0], 'exec');
        assert.equal(args[1], identity.containerId);
        assert.equal(args[2], 'mysql');
        return queryResult;
    };
    const observe = () => observeContainerService({ id: 'mysql', containerName: 'owned-mysql', catalogEntry: entry, docker });
    return { ...fixture, container, queryResult, calls, observe };
}

test('MySQL observes the live non-root SQL identity with private options and explicit TCP arguments', () =>
{
    const fixture = mysqlDockerFixture();
    assert.deepEqual(fixture.observe(), fixture.service);
    const query = fixture.calls.find(({ args }) => args.includes('--execute'));
    assert.deepEqual(query.args.slice(0, -1), [
        'exec', fixture.service.containerId, 'mysql',
        '--defaults-file=/run/fsusblog-mysql/client.cnf',
        '--no-login-paths', '--protocol=TCP', '--host=127.0.0.1', '--port=3306',
        '--user=fixture_user', '--batch', '--raw', '--skip-column-names', '--execute'
    ]);
    assert.match(query.args.at(-1), /@@server_uuid/u);
    assert.match(query.args.at(-1), /CURRENT_USER\(\)/u);
    assert.match(query.args.at(-1), /DATABASE\(\)/u);
    assert.match(query.args.at(-1), /@@port/u);
    assert.equal(JSON.stringify(query).includes('password'), false);
});

test('MySQL catalog authority rejects mutable, root, foreign config and incomplete identity contracts', () =>
{
    const wrongKind = controlledMySqlServiceFixture();
    wrongKind.catalog.services.mysql = { ...wrongKind.catalog.services.backend };
    assert.throws(() => createAndAdmitServiceEnvelope({
        producerId: 'backend-unit', runId: wrongKind.service.ownership.runId,
        requiredServices: ['mysql'], runOwnedProcesses: { mysql: {} }, catalog: wrongKind.catalog,
        observeRuntime: () => assert.fail('wrong service kind reached observation'),
        observeProcessService: () => assert.fail('host MySQL service reached observation')
    }), /mysql: service identity must be a pinned container/u);
    for (const [field, value] of [
        ['imageReference', 'mysql:8.4'], ['hostNativeAllowed', true],
        ['version', '8.4.110'], ['username', 'root'],
        ['databaseIdentityAuthority', 'container-env'],
        ['clientOptionsFile', '/root/.my.cnf'],
        ['versionCommand', ['sh', '-c', 'mysql --version']],
        ['requiredIdentityFields', ['containerId']]
    ])
    {
        const fixture = mysqlDockerFixture();
        fixture.catalog.services.mysql[field] = value;
        assert.notDeepEqual(validateExecutionServiceCatalog(fixture.catalog, {
            tiers: [{ services: Object.keys(fixture.catalog.services) }]
        }), [], field);
        assert.throws(() => createAndAdmitServiceEnvelope({
            producerId: 'backend-unit', runId: fixture.service.ownership.runId,
            requiredServices: ['mysql'], containers: { mysql: 'owned-mysql' }, catalog: fixture.catalog,
            observeRuntime: () => assert.fail('invalid authority reached observation')
        }), /service catalog is invalid/u, field);
    }
    for (const resourceGrant of [null, {},
        { ...catalog.services.mysql.resourceGrant, cpuUnits: 1 / 3 },
        { ...catalog.services.mysql.resourceGrant, memoryHighBytes: 536870913 },
        { ...catalog.services.mysql.resourceGrant, memoryMaxBytes: 268435456 },
        { ...catalog.services.mysql.resourceGrant, pidsMax: 0 },
        { ...catalog.services.mysql.resourceGrant, extra: true }])
    {
        const fixture = mysqlDockerFixture();
        fixture.catalog.services.mysql.resourceGrant = resourceGrant;
        assert.match(validateExecutionServiceCatalog(fixture.catalog, {
            tiers: [{ services: Object.keys(fixture.catalog.services) }]
        }).join('\n'), /mysql: resource grant/u);
    }
});

test('MySQL SQL observation rejects malformed, missing, duplicate, wrong-engine and root identities', () =>
{
    const valid = controlledMySqlServiceFixture().service.databaseIdentity;
    const candidates = [
        '', '{not-json', 'null', '[]', JSON.stringify(valid) + '\n' + JSON.stringify(valid),
        { ...valid, extra: true }, { ...valid, serverUuid: null },
        { ...valid, serverUuid: '00000000-0000-0000-0000-000000000000' },
        { ...valid, serverUuid: 'not-a-uuid' },
        { ...valid, serverVersion: '8.4.110' }, { ...valid, serverVersion: '8.4.11-MariaDB' },
        { ...valid, currentUser: 'root@localhost' }, { ...valid, currentUser: 'fixture_user@localhost' },
        { ...valid, database: 'foreign' }, { ...valid, port: '3306' }, { ...valid, port: 33060 }
    ];
    for (const candidate of candidates)
    {
        const fixture = mysqlDockerFixture();
        fixture.queryResult.stdout = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
        assert.throws(fixture.observe, /mysql: database identity (?:is malformed|drift)/u);
    }
    for (const result of [
        { status: 1, stderr: 'private-secret-must-not-escape' },
        { error: new Error('private-secret-must-not-escape'), status: null }
    ])
    {
        const fixture = mysqlDockerFixture();
        Object.assign(fixture.queryResult, result);
        assert.throws(fixture.observe, { message: 'mysql: database identity is unobservable' });
    }
});

test('MySQL observation requires run ownership, a single loopback endpoint and bounded resources', () =>
{
    const mutations = [
        (value) =>
        {
            delete value.Config.Labels['io.fsusblog.test.run-id'];
        },
        (value) =>
        {
            value.Config.Labels['io.fsusblog.test.namespace'] = 'bad namespace';
        },
        (value) =>
        {
            value.Config.Labels['io.fsusblog.test.repository-root-digest'] = 'not-a-digest';
        },
        (value) =>
        {
            value.HostConfig.NetworkMode = 'host';
        },
        (value) =>
        {
            value.HostConfig.NetworkMode = 'none';
        },
        (value) =>
        {
            value.NetworkSettings.Ports = {};
        },
        (value) =>
        {
            value.NetworkSettings.Ports['3306/tcp'][0].HostIp = '0.0.0.0';
        },
        (value) =>
        {
            value.NetworkSettings.Ports['3306/tcp'][0].HostPort = '0';
        },
        (value) =>
        {
            value.NetworkSettings.Ports['3306/tcp'][0].HostPort = '65536';
        },
        (value) =>
        {
            value.NetworkSettings.Ports['3306/tcp'][0].HostPort = 23306;
        },
        (value) =>
        {
            value.NetworkSettings.Ports['33060/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '23307' }];
        },
        (value) =>
        {
            value.HostConfig.NanoCpus = 0;
        },
        (value) =>
        {
            value.HostConfig.Memory = 0;
        },
        (value) =>
        {
            value.HostConfig.MemoryReservation = 0;
        },
        (value) =>
        {
            value.HostConfig.MemoryReservation = value.HostConfig.Memory + 1;
        },
        (value) =>
        {
            value.HostConfig.PidsLimit = 0;
        }
    ];
    for (const mutate of mutations)
    {
        const fixture = mysqlDockerFixture();
        mutate(fixture.container);
        assert.throws(fixture.observe, /mysql: (?:run ownership|isolated loopback|positive bounded)/u);
    }
});

test('MySQL admission rejects a foreign run and live SQL or ownership changes', () =>
{
    const fixture = controlledMySqlServiceFixture();
    const input = {
        producerId: 'backend-unit', runId: fixture.service.ownership.runId,
        requiredServices: ['mysql'], containers: { mysql: 'owned-mysql' }, catalog: fixture.catalog,
        observeRuntime: () => fixture.runtime, observeService: () => structuredClone(fixture.service)
    };
    assert.throws(() => createAndAdmitServiceEnvelope({ ...input, runId: 'foreign-run' }), /service run ownership drift/u);
    const envelope = createAndAdmitServiceEnvelope(input);
    for (const mutate of [
        (value) =>
        {
            value.databaseIdentity.serverUuid = '87654321-4321-4321-4321-cba987654321';
        },
        (value) =>
        {
            value.ownership.runId = 'foreign-run';
        },
        (value) =>
        {
            value.ownership.namespace = 'foreign-namespace';
        },
        (value) =>
        {
            value.ownership.stepId = 'foreign-step';
        },
        (value) =>
        {
            value.ownership.bundleId = 'foreign-bundle';
        },
        (value) =>
        {
            value.ownership.repositoryRootDigest = `sha256:${'d'.repeat(64)}`;
        }
    ])
    {
        const service = structuredClone(fixture.service);
        mutate(service);
        assert.throws(() => verifyLiveServiceEnvelope({
            envelope, catalog: fixture.catalog,
            observeRuntime: input.observeRuntime, observeService: () => service
        }), /service run ownership drift|service envelope drift/u);
        let calls = 0;
        assert.throws(() => createAndAdmitServiceEnvelope({
            ...input, observeService: () => calls++ === 0 ? fixture.service : service
        }), /service run ownership drift|service envelope drift/u);
    }
    const alteredEnvelope = structuredClone(envelope);
    alteredEnvelope.runId = 'foreign-run';
    assert.throws(() => verifyLiveServiceEnvelope({
        envelope: alteredEnvelope, catalog: fixture.catalog,
        observeRuntime: input.observeRuntime, observeService: input.observeService
    }), /service run ownership drift/u);
});
