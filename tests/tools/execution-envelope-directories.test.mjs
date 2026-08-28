import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    finalizeRunOwnedDirectories,
    prepareRunOwnedDirectories
} from '../../tools/test/execution-envelope-directories.mjs';

test('HOME, TMP, npm, NuGet, and tool caches are unique run-attempt owned roots', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directories-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const prepared = prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run-1',
        producerId: 'producer-1',
        attemptId: 'attempt-1',
        outputs: ['outputs/result']
    });
    const values = Object.values(prepared.environment);
    assert.equal(prepared.environment.HOME, prepared.environment.USERPROFILE);
    assert.equal(prepared.environment.TMP, prepared.environment.TEMP);
    assert.equal(prepared.environment.TMP, prepared.environment.TMPDIR);
    assert.equal(new Set(values).size, 6);
    assert.ok(values.every((directory) => directory.startsWith(prepared.fragment.ownedRoot)));
    assert.ok(values.every((directory) => (fs.statSync(directory).mode & 0o777) === 0o700));
    fs.writeFileSync(path.join(prepared.environment.HOME, 'fixture'), 'value');
    fs.writeFileSync(path.join(root, 'outputs/result/output.json'), 'output');
    const fragment = finalizeRunOwnedDirectories(prepared);
    assert.equal(fragment.cleanup.status, 'complete');
    assert.equal(fragment.cleanup.removedOwnedRoot, true);
    assert.equal(fragment.postInventory.some((entry) => entry.path === 'home/fixture'), true);
    assert.deepEqual(
        fragment.externalWriteObservation.preAllowedRootInventory[0].entries,
        []
    );
    assert.equal(
        fragment.externalWriteObservation.postAllowedRootInventory[0].entries
            .some((entry) => entry.path === 'output.json'),
        true
    );
});

test('symlink escape and output paths outside the worktree fail closed', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-escape-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-outside-'));
    context.after(() =>
    {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, '.tmp/test-execution-envelope'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.tmp/test-execution-envelope/run-owned'));
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt'
    }), /resolves outside its repository/u);
    fs.rmSync(path.join(root, '.tmp/test-execution-envelope/run-owned'));
    assert.throws(() => prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt',
        outputs: ['../outside']
    }), /escapes the worktree/u);
});

test('cleanup never removes sibling retained evidence or user files', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-cleanup-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const retained = path.join(root, '.tmp/test-execution-envelope/retained.json');
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    fs.writeFileSync(retained, 'retained');
    const prepared = prepareRunOwnedDirectories({
        repositoryRoot: root,
        cwd: root,
        runId: 'run',
        producerId: 'producer',
        attemptId: 'attempt'
    });
    finalizeRunOwnedDirectories(prepared);
    assert.equal(fs.readFileSync(retained, 'utf8'), 'retained');
});
