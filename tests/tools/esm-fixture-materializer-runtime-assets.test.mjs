import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertRuntimeAssetBoundary,
    materializeTestMatrixRunner
} from './support/esm-fixture-materializer-contracts.mjs';
import { materializeEsmFixture } from './support/esm-fixture-materializer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('ESM fixture materializer requires literal runtime assets and rejects missing or linked assets', assertRuntimeAssetBoundary);

test('original scheduler fixture includes its runtime-read release and containment assets', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-scheduler-runtime-assets-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, temp);
    for (const file of [
        'tools/test/native/execution-envelope-landlock.c',
        'tools/test-fixtures/producers/temporal-child-handshake.bash',
        'tools/test-fixtures/producers/temporal-child-handshake.cjs',
        'tools/test-fixtures/producers/temporal-child-handshake-emitter.cjs',
        'tools/test-fixtures/producers/temporal-child-observer.mjs',
        'tools/test/physical-execution-nested-socket.py',
        'src/shared/Contracts/Localization/locale-catalog.json',
        'tools/test/lanes/release-final.sh',
        'tools/test/physical-execution-linux-preexec.py',
        'tools/test/physical-execution-windows-job.ps1',
        'tools/test-matrix/windows-job-members.ps1',
        'tools/test-matrix/windows-job-supervisor.ps1',
        'tests/fixtures/test-matrix/release-final-evidence-inputs.json'
    ])
    {
        assert.deepEqual(fs.readFileSync(path.join(temp, file)), fs.readFileSync(path.join(root, file)), file);
    }
    function compareCopiedFiles(directory)
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) compareCopiedFiles(target);
            else
            {
                assert.ok(entry.isFile(), target);
                const file = path.relative(temp, target);
                const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
                assert.equal(digest(fs.readFileSync(target)), digest(fs.readFileSync(path.join(root, file))), file);
            }
        }
    }
    compareCopiedFiles(temp);
});

function runnerSource(t)
{
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runner-assets-source-'));
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runner-assets-target-'));
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, source);
    return { source, fixture };
}

test('runner locale permission excludes neighbouring runtime files', (t) =>
{
    const { source, fixture } = runnerSource(t);
    const unknown = 'src/shared/Contracts/Localization/unrelated.mjs';
    fs.writeFileSync(path.join(source, unknown), 'export const unrelated = true;\n');
    fs.appendFileSync(path.join(source, 'tools/run-test-matrix.mjs'), `\nimport '../${unknown}';\n`);
    assert.throws(() => materializeTestMatrixRunner(source, fixture), /resolved target escapes allowed roots.*unrelated\.mjs/u);
    assert.equal(fs.existsSync(path.join(fixture, unknown)), false);
});

test('runtime asset path aliases and unlisted locale neighbours retain the original boundary', (t) =>
{
    const { source, fixture } = runnerSource(t);
    const locale = 'src/shared/Contracts/Localization/locale-catalog.json';
    const options = { repositoryRoot: source, fixtureRoot: fixture, entries: ['tools/run-test-matrix.mjs'],
        allowedRoots: ['tools', 'src/frontend/scripts/fsusui-root.mjs', locale] };
    assert.throws(() => materializeEsmFixture({ ...options, assets: ['src/shared/Contracts/Localization/../Localization/locale-catalog.json'] }),
        /runtime assets must be unique repository-relative paths/u);
    assert.throws(() => materializeEsmFixture({ ...options, assets: [locale, locale] }),
        /runtime assets must be unique repository-relative paths/u);
    assert.throws(() => materializeEsmFixture({ ...options, assets: ['src/shared/Contracts/Localization/unlisted.json'] }),
        /resolved target escapes allowed roots/u);
});

for (const mode of ['deleted', 'linked'])
{
    test(`runner refuses ${mode} nested socket transport instead of omitting it`, (t) =>
    {
        const { source, fixture } = runnerSource(t);
        const asset = path.join(source, 'tools/test/physical-execution-nested-socket.py');
        fs.rmSync(asset);
        if (mode === 'linked') fs.symlinkSync('physical-execution-linux-preexec.py', asset);
        assert.throws(() => materializeTestMatrixRunner(source, fixture), mode === 'deleted'
            ? /runtime asset is missing.*physical-execution-nested-socket/u
            : /runtime asset must be a literal regular file.*physical-execution-nested-socket/u);
        assert.equal(fs.existsSync(path.join(fixture, 'tools/test/physical-execution-nested-socket.py')), false);
    });
}

test('runner locale destination cannot follow a linked leaf or parent', (t) =>
{
    const { source, fixture } = runnerSource(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runner-assets-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, 'sentinel.json');
    fs.writeFileSync(sentinel, 'sentinel');
    const directory = path.join(fixture, 'src/shared/Contracts/Localization');
    fs.mkdirSync(directory, { recursive: true });
    const locale = path.join(directory, 'locale-catalog.json');
    fs.symlinkSync(sentinel, locale);
    assert.throws(() => materializeTestMatrixRunner(source, fixture), /destination must be a literal regular file/u);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel');
    fs.rmSync(locale);
    fs.rmdirSync(directory);
    fs.symlinkSync(outside, directory);
    assert.throws(() => materializeTestMatrixRunner(source, fixture), /destination parent must be a literal directory/u);
    assert.deepEqual(fs.readdirSync(outside), ['sentinel.json']);
});

test('late destination refusal preserves earlier files and permits a clean retry', async (t) =>
{
    for (const boundary of ['leaf', 'parent'])
    {
        await t.test(boundary, (t) =>
        {
            const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-late-destination-')));
            t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
            const source = path.join(temp, 'source');
            const fixture = path.join(temp, 'fixture');
            const outside = path.join(temp, 'outside');
            for (const directory of [source, fixture, outside])
            {
                fs.mkdirSync(path.join(directory, 'tools'), { recursive: true });
            }
            fs.mkdirSync(path.join(source, 'tools/z'), { recursive: true });
            fs.writeFileSync(path.join(source, 'tools/a.mjs'), 'export const fresh = 1;\n');
            fs.writeFileSync(path.join(source, 'tools/b.mjs'), 'export const fresh = 2;\n');
            const asset = 'tools/z/worker.py';
            fs.writeFileSync(path.join(source, asset), 'print("fresh")\n', { mode: 0o755 });
            const retained = path.join(fixture, 'tools/a.mjs');
            fs.writeFileSync(retained, 'retained earlier destination\n', { mode: 0o640 });
            const retainedMode = fs.statSync(retained).mode & 0o777;
            const sentinel = path.join(outside, 'sentinel.py');
            fs.writeFileSync(sentinel, 'outside sentinel\n');
            const obstruction = boundary === 'leaf' ? path.join(fixture, asset) : path.join(fixture, 'tools/z');
            if (boundary === 'leaf')
            {
                fs.mkdirSync(path.dirname(obstruction), { recursive: true });
            }
            fs.symlinkSync(boundary === 'leaf' ? sentinel : outside, obstruction);
            const options = { repositoryRoot: source, fixtureRoot: fixture,
                entries: ['tools/a.mjs', 'tools/b.mjs'], assets: [asset], allowedRoots: ['tools'] };
            for (let attempt = 0; attempt < 2; attempt += 1)
            {
                assert.throws(() => materializeEsmFixture(options), boundary === 'leaf'
                    ? /destination must be a literal regular file/u : /destination parent must be a literal directory/u);
                assert.equal(fs.readFileSync(retained, 'utf8'), 'retained earlier destination\n');
                assert.equal(fs.statSync(retained).mode & 0o777, retainedMode);
                assert.equal(fs.existsSync(path.join(fixture, 'tools/b.mjs')), false);
                assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside sentinel\n');
                assert.deepEqual(fs.readdirSync(outside).sort(), ['sentinel.py', 'tools']);
            }
            fs.unlinkSync(obstruction);
            assert.deepEqual(materializeEsmFixture(options).files, ['tools/a.mjs', 'tools/b.mjs', asset]);
            for (const file of ['tools/a.mjs', 'tools/b.mjs', asset])
            {
                assert.deepEqual(fs.readFileSync(path.join(fixture, file)), fs.readFileSync(path.join(source, file)));
                assert.equal(fs.statSync(path.join(fixture, file)).mode & 0o777,
                    fs.statSync(path.join(source, file)).mode & 0o777);
            }
        });
    }
});
