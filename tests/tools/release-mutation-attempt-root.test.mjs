import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mutationAttemptFixture as fixture } from './helpers/mutation-attempt-fixture.mjs';
const {
    assertMutationMountIsolation,
    assertMutationRootLocation,
    createMutationAttemptRoot,
    prepareMutationWriteBoundary,
    publishMutationAttemptReference,
    readMutationAttemptObservation,
    verifyMutationAttemptRoot,
    writeMutationRootTerminal,
    verifyMutationRootTerminal
} = await import(new URL('../../tools/test/release-mutation-attempt-root.mjs', import.meta.url));

test('mount topology rejects bind aliases at roots, below roots and through ancestors', () =>
{
    const normal = '1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /tmp rw - tmpfs none rw';
    assert.doesNotThrow(() => assertMutationMountIsolation('/tmp/owned', normal));
    for (const mounted of ['3 1 0:1 /source /tmp/owned/alias rw - ext4 disk rw',
        '3 1 0:1 /shared /tmp/owned/build rw - ext4 disk rw',
        '3 1 0:1 /source /tmp/owned rw - ext4 disk rw'])
    {
        assert.throws(() => assertMutationMountIsolation('/tmp/owned', `${normal}\n${mounted}`), /alias/u);
    }
    assert.throws(() => assertMutationMountIsolation('/tmp/alias/attempt',
        `${normal}\n3 1 0:1 /source /tmp/alias rw - ext4 disk rw`), /alias/u);
});

test('fresh attempt has independently verified source, immutable build and filesystem bindings', async (t) =>
{
    const { options } = await fixture(t);
    const receipt = await createMutationAttemptRoot(options);
    await assert.rejects(createMutationAttemptRoot({ ...options,
        outputRoot: path.join(receipt.root, 'another-scenario'), invocationId: 'invocation-2' }), /another owned attempt/u);
    assert.equal(verifyMutationAttemptRoot(receipt, options), receipt);
    assert.equal(receipt.root, path.join(options.outputRoot, options.runId, options.invocationId, options.attemptId));
    assert.equal(receipt.authoritativeEvidence, null);
    assert.equal(receipt.producerSpawned, false);
    assert.equal(fs.statSync(path.join(receipt.root, 'root-receipt.json')).mode & 0o777, 0o400);
    await assert.rejects(createMutationAttemptRoot(options), /EEXIST/u);
    assert.equal(verifyMutationAttemptRoot(receipt, options), receipt);
});

test('source, retained evidence, shared build, case aliases and ancestor overlaps fail before allocation', async (t) =>
{
    const { options, parent, artifactRoot } = await fixture(t);
    for (const outputRoot of [options.repositoryRoot, path.join(options.repositoryRoot, '.tmp'),
        path.dirname(options.repositoryRoot), options.repositoryRoot.toUpperCase(), artifactRoot,
        path.join(artifactRoot, 'new-attempt')])
    {
        await assert.rejects(createMutationAttemptRoot({ ...options, outputRoot }), /overlaps/u);
    }
    const retained = path.join(parent, 'retained');
    fs.mkdirSync(retained);
    assert.throws(() => assertMutationRootLocation({ ...options,
        outputRoot: path.join(retained, 'attempt'), forbiddenRoots: [retained] }), /overlaps/u);
    assert.equal(fs.existsSync(options.outputRoot), false);
});

test('symlink aliases to source/shared directories and paths through alias ancestors are refused', async (t) =>
{
    const { options, parent, artifactRoot } = await fixture(t);
    for (const [name, target] of [['source-alias', options.repositoryRoot], ['build-alias', artifactRoot]])
    {
        const alias = path.join(parent, name);
        fs.symlinkSync(target, alias, 'dir');
        await assert.rejects(createMutationAttemptRoot({ ...options, outputRoot: path.join(alias, 'attempt') }), /alias/u);
    }
    assert.equal(fs.existsSync(options.outputRoot), false);
});

test('stale source, dirty worktree, cross-run build and wrong immutable digest fail before root creation', async (t) =>
{
    const { options } = await fixture(t);
    await assert.rejects(createMutationAttemptRoot({ ...options,
        sourceState: { ...options.sourceState, commit: '0'.repeat(40) } }), /source\/worktree/u);
    await assert.rejects(createMutationAttemptRoot({ ...options, buildReceiptDigest: `sha256:${'0'.repeat(64)}` }), /digest/u);
    await assert.rejects(createMutationAttemptRoot({ ...options, runId: 'another-run' }), /producer runId mismatch/u);
    fs.appendFileSync(path.join(options.repositoryRoot, 'input.txt'), 'drift');
    await assert.rejects(createMutationAttemptRoot(options), /source\/worktree/u);
    assert.equal(fs.existsSync(options.outputRoot), false);
});

test('path escape, cross-attempt receipt reuse, tamper and replaced directories fail closed', async (t) =>
{
    const { options } = await fixture(t);
    for (const attemptId of ['../escape', '/absolute', '..', 'case/alias'])
    {
        await assert.rejects(createMutationAttemptRoot({ ...options, attemptId }), /path-safe/u);
    }
    const receipt = await createMutationAttemptRoot(options);
    assert.throws(() => verifyMutationAttemptRoot(receipt, { ...options, attemptId: 'attempt-2' }), /identity/u);
    assert.throws(() => verifyMutationAttemptRoot({ ...receipt, paths: { ...receipt.paths, build: '/tmp' } }, options), /identity/u);
    fs.renameSync(receipt.paths.build, `${receipt.paths.build}-old`);
    fs.mkdirSync(receipt.paths.build, { mode: 0o700 });
    assert.throws(() => verifyMutationAttemptRoot(receipt, options), /directory identity drift/u);
});

test('modified immutable payload or a removed read-only seal cannot admit an attempt', async (t) =>
{
    const { options, artifactRoot } = await fixture(t);
    const payload = path.join(artifactRoot, 'backend', 'fixture.dll');
    fs.chmodSync(payload, 0o600);
    await assert.rejects(createMutationAttemptRoot(options), /seal/u);
    assert.equal(fs.statSync(payload).mode & 0o777, 0o600);
    fs.writeFileSync(payload, 'tampered');
    fs.chmodSync(payload, 0o400);
    await assert.rejects(createMutationAttemptRoot(options), /digest|size/u);
    assert.equal(fs.existsSync(options.outputRoot), false);
});

test('a retained root whose exact allocating owner exited cannot admit producer writes', async (t) =>
{
    const { options } = await fixture(t);
    const moduleUrl = new URL('../../tools/test/release-mutation-attempt-root.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        'const { createMutationAttemptRoot } = await import(process.argv[1]); process.stdout.write(JSON.stringify(await createMutationAttemptRoot(JSON.parse(process.argv[2]))));',
        moduleUrl, JSON.stringify(options)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.throws(() => verifyMutationAttemptRoot(receipt, options), /owner is stale/u);
    assert.equal(fs.existsSync(path.join(receipt.root, 'root-receipt.json')), true);
    assert.equal(receipt.authoritativeEvidence, null);
});

test('unavailable enforcement fails before producer admission and cannot create authoritative evidence', async (t) =>
{
    const { options } = await fixture(t);
    const receipt = await createMutationAttemptRoot(options);
    assert.throws(() => prepareMutationWriteBoundary(receipt, options,
        { PATH: '/nonexistent-toolchain', HOME: receipt.paths.home, TMPDIR: receipt.paths.scratch }), /unavailable/u);
    assert.equal(receipt.producerSpawned, false);
    assert.equal(receipt.authoritativeEvidence, null);
    assert.equal(fs.existsSync(path.join(receipt.root, 'release-parity-receipt.json')), false);
});

test('native Landlock denies direct, descendant and symlink escape writes; failed producer output is retained', async (t) =>
{
    const { options, parent } = await fixture(t);
    const receipt = await createMutationAttemptRoot(options);
    const environment = { PATH: process.env.PATH, HOME: receipt.paths.home, TMPDIR: receipt.paths.scratch,
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
    const boundary = prepareMutationWriteBoundary(receipt, options, environment);
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel');
    fs.writeFileSync(sentinel, 'unchanged');
    fs.symlinkSync(outside, path.join(receipt.root, 'escape'), 'dir');
    const program = `
        const fs = require('node:fs');
        const { spawnSync } = require('node:child_process');
        fs.writeFileSync(${JSON.stringify(path.join(receipt.root, 'allowed'))}, 'owned');
        try { fs.readFileSync(${JSON.stringify(sentinel)}); process.exit(97); }
        catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
        for (const target of ${JSON.stringify([sentinel, path.join(outside, 'new'), path.join(receipt.root, 'escape', 'new')])}) {
            try { fs.writeFileSync(target, 'escape'); process.exit(99); }
            catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
        }
        const child = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "escape")', ${JSON.stringify(sentinel)}]);
        if (child.status === 0) process.exit(98);
        process.exit(7);
    `;
    const result = await boundary.run(process.execPath, ['-e', program], { encoding: 'utf8' });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    assert.equal(fs.readFileSync(path.join(receipt.root, 'allowed'), 'utf8'), 'owned');
    assert.equal(fs.existsSync(path.join(outside, 'new')), false);
    assert.equal(receipt.cleanupPolicy, 'retain-on-failure');
    assert.equal(receipt.authoritativeEvidence, null);
});

test('unsafe real build entry refuses before reading authority or deleting prior evidence', () =>
{
    const result = spawnSync(process.execPath, ['tools/test/run-release-mutation-parity-build.mjs',
        '--authority', '/nonexistent/authority', '--policy', '/nonexistent/policy',
        '--output-root', path.resolve('.tmp/mutation/backend-critical/release-parity'), '--run-id', 'run-1951'],
    { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overlaps a forbidden/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
});

test('failed attempt records actual admission failure and retained cleanup without producer evidence', async (t) =>
{
    const { options } = await fixture(t);
    const receipt = await createMutationAttemptRoot(options);
    const reference = writeMutationRootTerminal(receipt, options, {
        phase: 'write-boundary-precondition', producerSpawned: false, producerOutcome: null,
        firstBlockingReason: 'native capability unavailable'
    });
    assert.equal(reference.terminal.status, 'failed');
    assert.equal(reference.terminal.authoritativeEvidence, null);
    assert.deepEqual(reference.terminal.cleanup, { policy: 'retain-on-failure', outcome: 'retained', rootExists: true });
    await assert.rejects(verifyMutationRootTerminal(receipt, options, reference), /no successful/u);
    assert.throws(() => writeMutationRootTerminal(receipt, options, {
        phase: 'retry', producerSpawned: false, producerOutcome: null
    }), /EEXIST/u);
});

test('controlled terminal verifies after owner exit without granting writable reuse', async (t) =>
{
    const { options } = await fixture(t);
    const moduleUrl = new URL('../../tools/test/release-mutation-attempt-root.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const fs = await import('node:fs');
        const { createHash } = await import('node:crypto');
        const { createMutationAttemptRoot, writeMutationRootTerminal } = await import(process.argv[1]);
        const options = JSON.parse(process.argv[2]);
        const receipt = await createMutationAttemptRoot(options);
        const evidence = receipt.paths.physical + '/controlled-fixture.json';
        fs.writeFileSync(evidence, 'controlled test fixture; not real mutation evidence');
        const reference = writeMutationRootTerminal(receipt, options, {
            phase: 'controlled-fixture-complete', producerSpawned: true,
            producerOutcome: { exitCode: 0, signal: null },
            authoritativeEvidence: { path: evidence,
                fileDigest: 'sha256:' + createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') }
        });
        process.stdout.write(JSON.stringify({ receipt, reference }));
    `, moduleUrl, JSON.stringify(options)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { receipt, reference } = JSON.parse(result.stdout);
    assert.throws(() => verifyMutationAttemptRoot(receipt, options), /owner is stale/u);
    assert.equal((await verifyMutationRootTerminal(receipt, options, reference)).status, 'passed');
    await assert.rejects(verifyMutationRootTerminal(receipt, { ...options, attemptId: 'different' }, reference), /identity/u);
    fs.writeFileSync(path.join(receipt.paths.physical, 'controlled-fixture.json'), 'tampered');
    await assert.rejects(verifyMutationRootTerminal(receipt, options, reference), /differs/u);
});

test('current invocation observes failed retained root independently and refuses cross-attempt control references', async (t) =>
{
    const { options } = await fixture(t);
    options.attemptId = `${options.invocationId}.attempt-1`;
    const receipt = await createMutationAttemptRoot(options);
    publishMutationAttemptReference(receipt, options);
    writeMutationRootTerminal(receipt, options, {
        phase: 'mutation-producer', producerSpawned: true,
        producerOutcome: { exitCode: 7, signal: null }, firstBlockingReason: 'controlled failed producer'
    });
    const observation = await readMutationAttemptObservation(options);
    assert.equal(observation.status, 'retained');
    assert.equal(observation.root, receipt.root);
    assert.equal(observation.producerOutcome.exitCode, 7);
    assert.equal(observation.terminal.status, 'failed');
    assert.deepEqual(observation.writeDomain, [receipt.root]);
    assert.throws(() => publishMutationAttemptReference(receipt, options), /EEXIST/u);
    await assert.rejects(readMutationAttemptObservation({ ...options, runId: 'wrong-run' }), /identity/u);
    fs.chmodSync(path.join(receipt.root, 'root-receipt.json'), 0o600);
    fs.writeFileSync(path.join(receipt.root, 'root-receipt.json'), '{}');
    await assert.rejects(readMutationAttemptObservation(options), /bytes/u);
});

test('fresh Debug/Release entry cannot select an authority without a sealed invocation', () =>
{
    const result = spawnSync(process.execPath, ['tools/test/run-release-mutation-parity-build.mjs',
        '--produce-source', '--authority', '/nonexistent/authority', '--policy', '/nonexistent/policy',
        '--run-id', 'run-1951', '--invocation-id', 'invocation-1', '--attempt-id', 'attempt-1',
        '--build-receipt', '/nonexistent/build', '--build-receipt-digest', `sha256:${'0'.repeat(64)}`],
    { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical sealed run identity/u);
    assert.doesNotMatch(result.stderr, /ENOENT/u);
});
