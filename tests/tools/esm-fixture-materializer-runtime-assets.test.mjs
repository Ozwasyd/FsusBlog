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

function assertReleaseFinalSourceRefusal(t, linked)
{
    const { source, fixture } = runnerSource(t);
    const relative = 'tools/test/lanes/release-final.sh';
    const asset = path.join(source, relative);
    const bytes = fs.readFileSync(asset);
    materializeTestMatrixRunner(source, fixture);
    fs.rmSync(asset);
    if (linked)
    {
        fs.symlinkSync(path.join(fixture, relative), asset);
    }
    for (let attempt = 0; attempt < 2; attempt += 1)
    {
        assert.throws(() => materializeTestMatrixRunner(source, fixture), linked
            ? /runtime asset must be a literal regular file.*release-final\.sh/u
            : /runtime asset is missing.*release-final\.sh/u);
        assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes);
    }
    if (linked)
    {
        fs.rmSync(asset);
    }
    fs.writeFileSync(asset, bytes);
    materializeTestMatrixRunner(source, fixture);
    assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes);
}

test('original runner refuses missing release-final source despite an existing fixture copy', (t) =>
{
    assertReleaseFinalSourceRefusal(t, false);
});

test('original runner refuses linked release-final source despite an existing fixture copy', (t) =>
{
    assertReleaseFinalSourceRefusal(t, true);
});
