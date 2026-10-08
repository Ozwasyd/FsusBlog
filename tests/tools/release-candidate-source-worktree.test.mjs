import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { gitFixture, sourcePolicy } from './repository-source-snapshot-test-support.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { snapshotRepositorySourceIdentity, verifyRepositorySourceSnapshot, diffRepositorySourceSnapshots } = await import(new URL('../../tools/test/repository-source-snapshot.mjs', import.meta.url));

function snapshot(root, policy = sourcePolicy)
{
    return snapshotRepositorySourceIdentity(root, { sourcePolicy: policy });
}

test('source snapshot observes clean and dirty bytes under the same HEAD and status', (t) =>
{
    const fixture = gitFixture(t);
    const clean = snapshot(fixture.root);
    fixture.write('source.txt', 'content A');
    const a = snapshot(fixture.root);
    const status = fixture.git('status', '--porcelain');
    fixture.write('source.txt', 'content B');
    const b = snapshot(fixture.root);
    assert.equal(status, fixture.git('status', '--porcelain'));
    assert.equal(clean.commit, b.commit);
    assert.notEqual(clean.snapshotDigest, a.snapshotDigest);
    assert.notEqual(a.snapshotDigest, b.snapshotDigest);
    assert.deepEqual(diffRepositorySourceSnapshots(a, b).map((change) => change.path), ['source.txt']);
    assert.equal(verifyRepositorySourceSnapshot(b), b);
});

test('source snapshot binds staged bytes independently of unstaged bytes', (t) =>
{
    const fixture = gitFixture(t);
    fixture.write('source.txt', 'staged');
    fixture.git('add', 'source.txt');
    const staged = snapshot(fixture.root);
    fixture.write('source.txt', 'unstaged');
    const both = snapshot(fixture.root);
    assert.deepEqual(staged.indexEntries, both.indexEntries);
    assert.notEqual(staged.snapshotDigest, both.snapshotDigest);
    fixture.write('new.txt', 'untracked one');
    const untracked = snapshot(fixture.root);
    fixture.write('new.txt', 'untracked two');
    assert.notEqual(snapshot(fixture.root).snapshotDigest, untracked.snapshotDigest);
    assert.throws(() => snapshot(fixture.root, { ...sourcePolicy, untracked: 'reject' }), /rejects untracked/u);
});

test('source snapshot distinguishes modes symlinks deletion empty files and renamed paths', (t) =>
{
    const fixture = gitFixture(t);
    const clean = snapshot(fixture.root);
    fs.chmodSync(path.join(fixture.root, 'source.txt'), 0o755);
    assert.notEqual(snapshot(fixture.root).snapshotDigest, clean.snapshotDigest);
    assert.equal(snapshot(fixture.root).worktreeEntries['source.txt'].mode, '100755');
    fs.symlinkSync('source.txt', path.join(fixture.root, 'link'));
    const firstLink = snapshot(fixture.root);
    fs.unlinkSync(path.join(fixture.root, 'link'));
    fs.symlinkSync('.gitignore', path.join(fixture.root, 'link'));
    assert.notEqual(snapshot(fixture.root).snapshotDigest, firstLink.snapshotDigest);
    fixture.write('source.txt', '');
    const empty = snapshot(fixture.root);
    fs.unlinkSync(path.join(fixture.root, 'source.txt'));
    assert.notEqual(snapshot(fixture.root).snapshotDigest, empty.snapshotDigest);
    assert.equal(snapshot(fixture.root).worktreeEntries['source.txt'].fileType, 'missing');
    fixture.write('source.txt', 'original\n');
    fixture.git('mv', 'source.txt', 'renamed.txt');
    assert.notEqual(snapshot(fixture.root).snapshotDigest, clean.snapshotDigest);
});

test('source snapshot is stable under mtime branch and physical clone root changes', (t) =>
{
    const fixture = gitFixture(t);
    const before = snapshot(fixture.root);
    fs.utimesSync(path.join(fixture.root, 'source.txt'), 10, 20);
    fixture.git('checkout', '-qb', 'other-name');
    assert.equal(snapshot(fixture.root).snapshotDigest, before.snapshotDigest);
    const second = gitFixture(t);
    // Equal tree/commit objects, different physical repository root.
    second.git('fetch', '-q', fixture.root, 'HEAD');
    second.git('reset', '--hard', 'FETCH_HEAD');
    assert.equal(snapshot(second.root).snapshotDigest, before.snapshotDigest);
});

test('source snapshot refuses hidden index flags and shallow repositories', (t) =>
{
    const fixture = gitFixture(t);
    fixture.git('update-index', '--assume-unchanged', 'source.txt');
    fixture.write('source.txt', 'hidden change');
    assert.throws(() => snapshot(fixture.root), /assume-unchanged/u);
    fixture.git('update-index', '--no-assume-unchanged', 'source.txt');
    fixture.git('update-index', '--skip-worktree', 'source.txt');
    assert.throws(() => snapshot(fixture.root), /skip-worktree/u);
    fixture.git('update-index', '--no-skip-worktree', 'source.txt');
    fs.writeFileSync(path.join(fixture.root, '.git', 'shallow'), `${fixture.git('rev-parse', 'HEAD')}\n`);
    assert.throws(() => snapshot(fixture.root), /shallow/u);
});

test('source snapshot uses only explicit registered ignored inputs with owner and consumer', (t) =>
{
    const fixture = gitFixture(t);
    fixture.write('ignored-config', 'one');
    fixture.write('ignored-cache', 'one');
    const policy = { ...sourcePolicy, ignoredInputs: [{ ownerId: 'frontend', path: 'ignored-config',
        reason: 'consumed configuration', consumedBy: ['frontend-build'], required: true }] };
    const before = snapshot(fixture.root, policy);
    fixture.write('ignored-cache', 'two');
    assert.equal(snapshot(fixture.root, policy).snapshotDigest, before.snapshotDigest);
    fixture.write('ignored-config', 'two');
    assert.notEqual(snapshot(fixture.root, policy).snapshotDigest, before.snapshotDigest);
    assert.throws(() => snapshot(fixture.root, { ...policy, ignoredInputs: [...policy.ignoredInputs, ...policy.ignoredInputs] }), /duplicate/u);
    assert.throws(() => snapshot(fixture.root, { ...policy, ignoredInputs: [{ path: 'ignored-config' }] }), /owner/u);
});

test('source snapshot rejects implicit parent roots path escape and physical aliases', (t) =>
{
    const fixture = gitFixture(t);
    fs.mkdirSync(path.join(fixture.root, 'nested'));
    assert.throws(() => snapshot(path.join(fixture.root, 'nested')), /explicit physical/u);
    fs.symlinkSync('/tmp', path.join(fixture.root, 'escape'));
    assert.throws(() => snapshot(fixture.root), /escapes/u);
    assert.throws(() => snapshot(fixture.root, { ...sourcePolicy, ignoredInputs: [{ ownerId: 'test', path: '../escape',
        reason: 'bad', consumedBy: ['test'], required: true }] }), /canonical/u);
});

test('source snapshot binds gitlinks without scanning submodule checkout contents', (t) =>
{
    const fixture = gitFixture(t);
    const commit = fixture.git('rev-parse', 'HEAD');
    fixture.git('update-index', '--add', '--cacheinfo', `160000,${commit},module`);
    const before = snapshot(fixture.root);
    assert.equal(before.submoduleEntries.module[0].objectId, commit);
    assert.equal(before.worktreeEntries.module, undefined);
    fixture.write('source.txt', 'next commit');
    fixture.git('add', 'source.txt');
    fixture.git('commit', '-qm', 'fixture second');
    fixture.git('update-index', '--cacheinfo', `160000,${fixture.git('rev-parse', 'HEAD')},module`);
    assert.notDeepEqual(snapshot(fixture.root).submoduleEntries, before.submoduleEntries);
});

test('source collection leaves Git and worktree bytes unchanged and rejects receipt tamper', (t) =>
{
    const fixture = gitFixture(t);
    const indexBefore = fs.readFileSync(path.join(fixture.root, '.git', 'index'));
    const statusBefore = fixture.git('status', '--porcelain');
    const receipt = snapshot(fixture.root);
    assert.deepEqual(fs.readFileSync(path.join(fixture.root, '.git', 'index')), indexBefore);
    assert.equal(fixture.git('status', '--porcelain'), statusBefore);
    assert.throws(() => verifyRepositorySourceSnapshot({ ...receipt, snapshotDigest: `sha256:${'0'.repeat(64)}` }), /digest mismatch/u);
    const changed = structuredClone(receipt);
    changed.worktreeEntries['source.txt'].contentDigest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => verifyRepositorySourceSnapshot(changed), /digest mismatch/u);
    assert.throws(() => snapshotRepositorySourceIdentity(fixture.root), /explicit source policy/u);
});

test('source snapshot refuses bytes changed after an earlier path was read', (t) =>
{
    const fixture = gitFixture(t);
    fixture.write('z-last', 'one');
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (...args)
    {
        const bytes = originalRead.apply(this, args);
        if (typeof args[0] === 'number' && ++reads === 3)
        {
            fixture.write('source.txt', 'changed during scan');
        }
        return bytes;
    };
    try
    {
        assert.throws(() => snapshot(fixture.root), /changed during snapshot/u);
    }
    finally
    {
        fs.readFileSync = originalRead;
    }
});

test('source independent verifier rejects resealed malformed inventory and missing objects', (t) =>
{
    const fixture = gitFixture(t);
    const receipt = snapshot(fixture.root);
    const changed = structuredClone(receipt);
    changed.worktreeEntries['source.txt'].mode = 'directory';
    const payload = Object.fromEntries(Object.entries(changed).filter(([key]) => !['contentDigest', 'snapshotDigest', 'diagnostics'].includes(key)));
    const resealed = sealContentDigest({ ...payload, snapshotDigest: digestCanonical(payload), diagnostics: changed.diagnostics });
    assert.throws(() => verifyRepositorySourceSnapshot(resealed), /invalid source content/u);
    fixture.git('update-index', '--cacheinfo', `100644,${'1'.repeat(40)},source.txt`);
    assert.throws(() => snapshot(fixture.root), /cat-file failed/u);
});

test('source snapshot records deletion of an entire tracked directory', (t) =>
{
    const fixture = gitFixture(t);
    fs.mkdirSync(path.join(fixture.root, 'nested'));
    fixture.write('nested/source', 'one');
    fixture.git('add', '.');
    fixture.git('commit', '-qm', 'fixture nested');
    fs.rmSync(path.join(fixture.root, 'nested'), { recursive: true });
    assert.equal(snapshot(fixture.root).worktreeEntries['nested/source'].fileType, 'missing');
});

test('source snapshot refuses promisor lookup before a missing object can trigger repair', (t) =>
{
    const fixture = gitFixture(t);
    fixture.git('config', 'remote.source.promisor', 'true');
    fixture.git('update-index', '--cacheinfo', `100644,${'1'.repeat(40)},source.txt`);
    const objectsBefore = fixture.git('count-objects', '-v');
    assert.throws(() => snapshot(fixture.root), /partial\/promisor/u);
    assert.equal(fixture.git('count-objects', '-v'), objectsBefore);
});

test('source snapshot disables configured fsmonitor hooks instead of executing source callbacks', (t) =>
{
    const fixture = gitFixture(t);
    const hook = path.join(fixture.root, '.git', 'candidate-fsmonitor.sh');
    const marker = path.join(fixture.root, '.git', 'candidate-fsmonitor-observed');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf observed > .git/candidate-fsmonitor-observed\nprintf "candidate-token\\0"\n', { mode: 0o755 });
    fixture.git('config', 'core.fsmonitor', hook);
    fixture.git('ls-files');
    assert.equal(fs.existsSync(marker), true, 'actual configured hook must be executable in the setup control');
    fs.rmSync(marker);
    snapshot(fixture.root);
    assert.equal(fs.existsSync(marker), false);
});
