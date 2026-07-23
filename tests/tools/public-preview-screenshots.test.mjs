import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = path.join(root, 'tools/docs/public-preview-screenshots.mjs');
const sourceDirectory = path.join(root, 'docs/assets/screenshots');

function fixture()
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-'));
    fs.cpSync(sourceDirectory, directory, { recursive: true });
    return directory;
}

function check(directory)
{
    return spawnSync(process.execPath, [tool, 'check', '--dir', directory], {
        cwd: root,
        encoding: 'utf8'
    });
}

function mutateManifest(directory, mutate)
{
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(manifest);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 4)}\n`);
}

test('checked-in public-preview screenshot manifest is complete and fresh', () =>
{
    const result = spawnSync(process.execPath, [tool, 'sync'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sync ok screenshots=9/u);
});

test('manifest checker reports missing, extra, and modified PNG files', () =>
{
    const directory = fixture();
    try
    {
        fs.rmSync(path.join(directory, 'public-dark.png'));
        let result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /missing screenshot file: public-dark\.png/u);

        fs.cpSync(sourceDirectory, directory, { recursive: true });
        fs.copyFileSync(path.join(directory, 'public-dark.png'), path.join(directory, 'extra.png'));
        result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unregistered screenshot file: extra\.png/u);

        fs.rmSync(path.join(directory, 'extra.png'));
        fs.appendFileSync(path.join(directory, 'public-dark.png'), 'changed');
        result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /public-dark\.png hash mismatch/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('manifest checker rejects duplicate and unknown registry values', () =>
{
    const directory = fixture();
    try
    {
        mutateManifest(directory, (manifest) =>
        {
            manifest.screenshots[1].id = manifest.screenshots[0].id;
            manifest.screenshots[3].file = manifest.screenshots[0].file;
            manifest.screenshots[2].theme = 'sepia';
        });
        const result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /duplicate screenshot id/u);
        assert.match(result.stderr, /duplicate screenshot file/u);
        assert.match(result.stderr, /unknown theme: sepia/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('manifest checker rejects reordered fields, reordered entries, and cross-entry identity drift', () =>
{
    const directory = fixture();
    try
    {
        mutateManifest(directory, (manifest) =>
        {
            const schema = manifest.schema;
            delete manifest.schema;
            manifest.schema = schema;
            manifest.screenshots.reverse();
            manifest.screenshots[0].frontendBuildIdentity = `${manifest.screenshots[0].sourceCommit}:src/other`;
            manifest.screenshots[1].fsusUi.lockDigest = '0'.repeat(64);
            manifest.screenshots[2] = {
                file: manifest.screenshots[2].file,
                id: manifest.screenshots[2].id,
                ...Object.fromEntries(Object.entries(manifest.screenshots[2]).filter(([key]) => !['file', 'id'].includes(key)))
            };
        });
        const result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /manifest fields must use canonical order/u);
        assert.match(result.stderr, /canonical registry order/u);
        assert.match(result.stderr, /frontendBuildIdentity is invalid/u);
        assert.match(result.stderr, /FsusUI identity differs from manifest/u);
        assert.match(result.stderr, /fields must use canonical order/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('manifest generation is byte-identical for the same source and visual inputs', () =>
{
    const directory = fixture();
    try
    {
        const sourceCommit = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).screenshots[0].sourceCommit;
        const first = spawnSync(process.execPath, [tool, 'generate', '--dir', directory, '--source-commit', sourceCommit], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(first.status, 0, first.stderr);
        const firstBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
        const second = spawnSync(process.execPath, [tool, 'generate', '--dir', directory, '--source-commit', sourceCommit], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(second.status, 0, second.stderr);
        assert.deepEqual(fs.readFileSync(path.join(directory, 'manifest.json')), firstBytes);
        assert.equal(check(directory).status, 0);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('capture contracts keep shards temporary and release verification explicit', () =>
{
    const specification = fs.readFileSync(
        path.join(root, 'tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts'),
        'utf8'
    );
    const runner = fs.readFileSync(path.join(root, 'tools/docs/run-public-preview-capture.sh'), 'utf8');
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    assert.match(specification, /manual screenshot shards cannot write docs assets/u);
    assert.match(specification, /public-preview docs capture requires the complete unfiltered registry/u);
    assert.match(runner, /public-preview-docs\.lock/u);
    assert.match(runner, /ROOT_DIR=.*\ncd "\$ROOT_DIR"/u);
    assert.doesNotMatch(runner, /source "\$ENV_FILE"/u);
    assert.match(runner, /export "\$key=\$value"/u);
    assert.match(runner, /public-preview-screenshots\.mjs" publish/u);
    assert.match(runner, /cleanupLocalRuntime/u);
    assert.match(matrix, /id: browser-contract[\s\S]*?public-preview-screenshots\.json/u);
    assert.match(matrix, /id: release-final[\s\S]*?browser-contract/u);
});
