import assert from 'node:assert/strict';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { withRuntimeRoleReplayDirectory } = await import(new URL('../../tools/fact-extractors/test-matrix/extract.mjs', import.meta.url));

// These are directory-lifecycle fixtures only; they create no build identity or receipt.
function createDirectoryFixture(t)
{
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-replay-directory-'));
    t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
    const buildRoot = '.tmp/behavior-doc-contract-builds/' + 'a'.repeat(64);
    const buildDirectory = path.join(repositoryRoot, buildRoot);
    mkdirSync(buildDirectory, { recursive: true });
    writeFileSync(path.join(buildDirectory, 'retained-input.txt'), 'retained input\n');
    return { repositoryRoot, buildRoot, buildDirectory };
}

test('replay scratch is writable inside the existing cache and cleaned after success', (t) =>
{
    const { repositoryRoot, buildRoot, buildDirectory } = createDirectoryFixture(t);
    let directory;
    const result = withRuntimeRoleReplayDirectory(repositoryRoot, buildRoot, (output) =>
    {
        directory = path.dirname(output);
        assert.equal(path.dirname(directory), buildDirectory);
        assert.match(path.basename(directory), /^runtime-role-replay-/u);
        assert.equal(path.basename(output), 'runtime-role-observation.json');
        assert.equal(path.relative(repositoryRoot, output).split(path.sep).includes('..'), false);
        writeFileSync(output, 'ordinary directory fixture\n');
        assert.equal(readFileSync(output, 'utf8'), 'ordinary directory fixture\n');
        return 'completed';
    });
    assert.equal(result, 'completed');
    assert.equal(existsSync(directory), false);
    assert.equal(readFileSync(path.join(buildDirectory, 'retained-input.txt'), 'utf8'), 'retained input\n');
    assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
});

test('replay scratch is cleaned when the synchronous operation returns a failure', (t) =>
{
    const { repositoryRoot, buildRoot, buildDirectory } = createDirectoryFixture(t);
    let directory;
    const failure = { status: 'failed', reason: 'ordinary operation failure' };
    assert.equal(withRuntimeRoleReplayDirectory(repositoryRoot, buildRoot, (output) =>
    {
        directory = path.dirname(output);
        writeFileSync(output, 'partial output\n');
        return failure;
    }), failure);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
});

test('replay scratch is cleaned while preserving an interrupted operation error', (t) =>
{
    const { repositoryRoot, buildRoot, buildDirectory } = createDirectoryFixture(t);
    let directory;
    const interrupted = Object.assign(new Error('ordinary operation interrupted'), { name: 'AbortError' });
    assert.throws(() => withRuntimeRoleReplayDirectory(repositoryRoot, buildRoot, (output) =>
    {
        directory = path.dirname(output);
        writeFileSync(output, 'partial output\n');
        throw interrupted;
    }), (error) => error === interrupted);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
});

test('repeated replay scratch operations retain only the original cache files', (t) =>
{
    const { repositoryRoot, buildRoot, buildDirectory } = createDirectoryFixture(t);
    for (let index = 0; index < 2; index += 1)
    {
        withRuntimeRoleReplayDirectory(repositoryRoot, buildRoot, (output) =>
        {
            assert.equal(existsSync(output), false);
            writeFileSync(output, 'ordinary directory fixture\n');
        });
        assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
    }
});

test('replay scratch refuses a symlink cache parent before invoking the operation', (t) =>
{
    const { repositoryRoot, buildDirectory } = createDirectoryFixture(t);
    symlinkSync(buildDirectory, path.join(repositoryRoot, 'linked-cache'), 'dir');
    let invoked = false;
    assert.throws(() => withRuntimeRoleReplayDirectory(repositoryRoot, 'linked-cache', () =>
    {
        invoked = true;
    }), /symbolic link/u);
    assert.equal(invoked, false);
    assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
});

test('replay scratch refuses a noncanonical cache path before invoking the operation', (t) =>
{
    const { repositoryRoot, buildRoot, buildDirectory } = createDirectoryFixture(t);
    let invoked = false;
    assert.throws(() => withRuntimeRoleReplayDirectory(repositoryRoot, buildRoot + '/../escape', () =>
    {
        invoked = true;
    }), /canonical and repository-relative/u);
    assert.equal(invoked, false);
    assert.deepEqual(readdirSync(buildDirectory), ['retained-input.txt']);
});
