import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/docs/check-authoritative-development-docs.mjs');
const dependencyOverlayArchive = {
    path: 'config/dependencies/fsusui-public-npm-migration.patch.gz',
    sha256: '7cc634569551a238c331469bd042ee1aab964b8a4c794503a3e56fb80c05956c'
};
const manifestPath = path.join(root, 'config/development/authoritative-development-docs.json');

function read(relativePath)
{
    return readFileSync(path.join(root, relativePath), 'utf8');
}

function writeOverlay(overlay, relativePath, content)
{
    const target = path.join(overlay, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
}

function createOverlay()
{
    return mkdtempSync(path.join(tmpdir(), 'fsusblog-authority-docs-'));
}

function readManifest()
{
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function writeManifest(overlay, manifest)
{
    writeOverlay(
        overlay,
        'config/development/authoritative-development-docs.json',
        JSON.stringify(manifest, null, 2)
    );
}

function runChecker(overlay)
{
    return spawnSync(process.execPath, [checker, '--overlay', overlay], {
        cwd: root,
        encoding: 'utf8'
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function withOverlay(callback)
{
    const overlay = createOverlay();
    try
    {
        callback(overlay);
    }
    finally
    {
        rmSync(overlay, { recursive: true, force: true });
    }
}

test('authoritative development documentation authoritative development documents pass from the canonical repository state', () =>
{
    withOverlay((overlay) =>
    {
        const result = runChecker(overlay);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /\[authoritative-development-docs] ok/);
    });
});

test('authoritative development documentation assigns only the sealed FsusUI migration archive to its dependency owner', () =>
{
    const archivePath = 'config/dependencies/fsusui-public-npm-migration.patch.gz';
    const manifest = readManifest();
    const vendor = manifest.pathClassifications.find((entry) => entry.id === 'dependency-migration-archive');
    assert.ok(vendor.patterns.includes(archivePath));
    assert.deepEqual(manifest.pathClassifications.filter((entry) => entry.patterns.includes(archivePath))
        .map((entry) => ({ id: entry.id, owner: entry.owner })), [{ id: 'dependency-migration-archive', owner: 'DependencyOwner' }]);
    assert.ok(!manifest.nonSourceExtensions.includes('.gz'));
    assert.ok(!vendor.patterns.includes('config/dependencies/**'));

    const archive = readFileSync(path.join(root, archivePath));
    const owner = read('tools/dependencies/migrate-fsusui-public-npm.mjs');
    const digest = owner.match(/FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256 = '([0-9a-f]{64})'/u)?.[1];
    assert.ok(digest, 'the existing migration owner must seal the archive bytes');
    assert.equal(createHash('sha256').update(archive).digest('hex'), digest);
    assert.match(gunzipSync(archive).toString('utf8'), /^diff --git /u);
});

test('authoritative development documentation rejects the FsusUI migration archive without its exact dependency ownership', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const vendor = manifest.pathClassifications.find((entry) => entry.id === 'dependency-migration-archive');
        vendor.patterns = vendor.patterns.filter((pattern) =>
            pattern !== 'config/dependencies/fsusui-public-npm-migration.patch.gz');
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /config\/dependencies\/fsusui-public-npm-migration\.patch\.gz has no style owner or non-source classification/u);
    });
});

test('authoritative development documentation rejects neighboring unowned archives without widening the exact dependency overlay scope', () =>
{
    withOverlay((overlay) =>
    {
        const neighboringPaths = [
            'config/dependencies/fsusui-public-npm-migration-copy.patch.gz',
            'config/dependencies/overlays/fsusui-public-npm-migration.patch.gz',
            'config/dependencies/unregistered-migration.tar.gz'
        ];
        const archive = readFileSync(path.join(root, 'config/dependencies/fsusui-public-npm-migration.patch.gz'));
        for (const relativePath of neighboringPaths)
        {
            const target = path.join(overlay, relativePath);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, archive);
        }
        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        const combined = output(result);
        for (const relativePath of neighboringPaths)
        {
            assert.ok(combined.includes(`${relativePath} has no style owner or non-source classification`));
        }
        assert.ok(!combined.includes(`${'config/dependencies/fsusui-public-npm-migration.patch.gz'} has no style owner or non-source classification`));
    });
});

test('authoritative development documentation checker rejects a stale AGENTS repository path', () =>
{
    withOverlay((overlay) =>
    {
        writeOverlay(
            overlay,
            'AGENTS.md',
            `${read('AGENTS.md')}\n| \`src/backend/Retired/NoLongerExists.cs\` | stale fixture |\n`
        );
        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /AGENTS\.md declares missing repository path src\/backend\/Retired\/NoLongerExists\.cs/);
    });
});

test('authoritative development documentation checker rejects a retired class name', () =>
{
    withOverlay((overlay) =>
    {
        writeOverlay(overlay, 'AGENTS.md', `${read('AGENTS.md')}\nRetired fixture: BannedUserFilter\n`);
        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /AGENTS\.md contains retired token BannedUserFilter/);
    });
});

test('authoritative development documentation checker aggregates missing command and documentation link', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        manifest.commands[0].path = 'tools/docs/no-such-authority-check.mjs';
        writeManifest(overlay, manifest);
        writeOverlay(
            overlay,
            'docs/CONTRIBUTING.md',
            `${read('docs/CONTRIBUTING.md')}\n[Missing authority document](docs/no-such-authority-document.md)\n`
        );

        const result = runChecker(overlay);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        assert.match(combined, /references missing command path tools\/docs\/no-such-authority-check\.mjs/);
        assert.match(combined, /docs\/CONTRIBUTING\.md references missing document link docs\/no-such-authority-document\.md/);
    });
});

test('authoritative development documentation checker validates external-contract positive and negative adapters', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const exception = manifest.externalContractExceptions.find((entry) => entry.id === 'json-api-field');
        exception.positive.internal = 'user_id';
        exception.negative.internal = 'userId';
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        assert.match(combined, /positive internal adapter is invalid/);
        assert.match(combined, /negative internal example unexpectedly satisfies internal naming/);
    });
});

test('authoritative development documentation checker rejects formatter defaults that override repository rules', () =>
{
    withOverlay((overlay) =>
    {
        writeOverlay(
            overlay,
            '.editorconfig',
            `root = true

[*]
indent_style = tab
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
`
        );
        const result = runChecker(overlay);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        assert.match(combined, /indent_style=tab conflicts with repository baseline space/);
        assert.match(combined, /indent_size=2 conflicts with repository baseline 4/);
    });
});

test('authoritative development documentation checker rejects a missing generated or vendor classification', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        manifest.pathClassifications = manifest.pathClassifications.filter(
            (entry) => entry.id !== 'generated' && entry.id !== 'vendor'
        );
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        const combined = output(result);
        assert.match(combined, /missing required path classification generated/);
        assert.match(combined, /missing required path classification vendor/);
    });
});

test('authoritative development documentation checker assigns XML configuration to repository-config', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const owner = manifest.styleOwners.find((entry) => entry.id === 'repository-config');
        assert.ok(owner.extensions.includes('.xml'));
        assert.ok(!manifest.nonSourceExtensions.includes('.xml'));

        const result = runChecker(overlay);
        assert.equal(result.status, 0, output(result));
    });
});

test('authoritative development documentation classifies only the exact packed dependency migration input', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const classification = manifest.pathClassifications.find(
            (entry) => entry.id === 'dependency-migration-archive'
        );
        assert.equal(classification.owner, 'DependencyOwner');
        assert.deepEqual(classification.patterns, ['config/dependencies/fsusui-public-npm-migration.patch.gz']);
        assert.ok(!manifest.nonSourceExtensions.includes('.gz'));
        assert.ok(!manifest.nonSourceSpecialFiles.includes('fsusui-public-npm-migration.patch.gz'));

        const result = runChecker(overlay);
        assert.equal(result.status, 0, output(result));
    });
});

test('authoritative development documentation rejects the packed migration input without its classification', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        manifest.pathClassifications = manifest.pathClassifications.filter(
            (entry) => entry.id !== 'dependency-migration-archive'
        );
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(
            output(result),
            /config\/dependencies\/fsusui-public-npm-migration\.patch\.gz has no style owner or non-source classification/
        );
    });
});

test('authoritative development documentation plain patches retain their independent non-source classification', () =>
{
    withOverlay((overlay) =>
    {
        writeOverlay(overlay, 'config/dependencies/fsusui-public-npm-migration.patch', 'independently classified patch');
        const result = runChecker(overlay);
        assert.equal(result.status, 0, output(result));
    });
});

for (const relativePath of [
    'config/dependencies/unowned-migration.patch.gz',
    'tools/dependencies/fsusui-public-npm-migration.patch.gz',
    'config/dependencies/fsusui-public-npm-migration.patch'
])
{
    test(`authoritative development documentation packed input classification does not exempt ${relativePath}`, () =>
    {
        withOverlay((overlay) =>
        {
            writeOverlay(overlay, relativePath, 'unclassified migration input');
            // .patch has an independent non-source classification; remove it only
            // in this overlay so the archive's exact path is the sole exemption.
            if (relativePath.endsWith('.patch'))
            {
                const manifest = readManifest();
                assert.ok(manifest.nonSourceExtensions.includes('.patch'));
                manifest.nonSourceExtensions = manifest.nonSourceExtensions.filter((extension) => extension !== '.patch');
                writeManifest(overlay, manifest);
            }

            if (relativePath === 'config/dependencies/fsusui-public-npm-migration.patch')
            {
                const manifest = readManifest();
                assert.ok(manifest.nonSourceExtensions.includes('.patch'));
                const registeredExtension = runChecker(overlay);
                assert.equal(registeredExtension.status, 0, output(registeredExtension));

                // Isolate the packed-input classification from the existing .patch non-source classification.
                manifest.nonSourceExtensions = manifest.nonSourceExtensions.filter(
                    (extension) => extension !== '.patch'
                );
                writeManifest(overlay, manifest);
            }

            const result = runChecker(overlay);
            assert.notEqual(result.status, 0);
            assert.ok(
                output(result).includes(`${relativePath} has no style owner or non-source classification`),
                output(result)
            );
        });
    });
}

test('authoritative development documentation checker rejects browserconfig XML without its style owner', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const owner = manifest.styleOwners.find((entry) => entry.id === 'repository-config');
        owner.extensions = owner.extensions.filter((extension) => extension !== '.xml');
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(
            output(result),
            /src\/frontend\/public\/favicon\/browserconfig\.xml has no style owner or non-source classification/
        );
    });
});

test('authoritative development documentation checker rejects treating XML configuration as non-source', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const owner = manifest.styleOwners.find((entry) => entry.id === 'repository-config');
        owner.extensions = owner.extensions.filter((extension) => extension !== '.xml');
        manifest.nonSourceExtensions.push('.xml');
        writeManifest(overlay, manifest);

        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /style-owned extension \.xml cannot be classified as non-source/);
    });
});

test('authoritative development documentation preserves the exact dependency overlay archive owner and original bytes', () =>
{
    const manifest = readManifest();
    const archivePath = dependencyOverlayArchive.path;
    const consumerLines = readFileSync(path.join(root, 'tools/dependencies/migrate-fsusui-public-npm.mjs'), 'utf8').split('\n');
    assert.ok(consumerLines.includes(`export const FSUSUI_PUBLIC_NPM_MIGRATION_PATCH = '${archivePath}';`));
    assert.ok(consumerLines.includes(`export const FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256 = '${dependencyOverlayArchive.sha256}';`));
    const owners = manifest.pathClassifications
        .filter((entry) => entry.patterns.includes(archivePath))
        .map((entry) => ({ id: entry.id, owner: entry.owner }));
    assert.deepEqual(owners, [{ id: 'dependency-migration-archive', owner: 'DependencyOwner' }]);
    assert.ok(!manifest.nonSourceExtensions.includes('.gz'));
    const archive = readFileSync(path.join(root, archivePath));
    assert.equal(createHash('sha256').update(archive).digest('hex'), dependencyOverlayArchive.sha256);
    assert.match(gunzipSync(archive).toString('utf8'), /^diff --git a\//m);

    withOverlay((overlay) =>
    {
        const result = runChecker(overlay);
        assert.equal(result.status, 0, output(result));
        assert.deepEqual(readFileSync(path.join(root, archivePath)), archive);
    });
});

test('authoritative development documentation rejects the dependency overlay archive when its exact owner registration is removed', () =>
{
    withOverlay((overlay) =>
    {
        const manifest = readManifest();
        const archiveOwner = manifest.pathClassifications.find((entry) => entry.id === 'dependency-migration-archive');
        archiveOwner.patterns = archiveOwner.patterns.filter((entry) => entry !== dependencyOverlayArchive.path);
        writeManifest(overlay, manifest);
        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        assert.ok(output(result).includes(`${dependencyOverlayArchive.path} has no style owner or non-source classification`));
    });
});

test('authoritative development documentation rejects neighboring unowned archives without widening the exact dependency overlay scope', () =>
{
    withOverlay((overlay) =>
    {
        const neighboringPaths = [
            'config/dependencies/fsusui-public-npm-migration-copy.patch.gz',
            'config/dependencies/overlays/fsusui-public-npm-migration.patch.gz',
            'config/dependencies/unregistered-migration.tar.gz'
        ];
        const archive = readFileSync(path.join(root, dependencyOverlayArchive.path));
        for (const relativePath of neighboringPaths)
        {
            const target = path.join(overlay, relativePath);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, archive);
        }
        const result = runChecker(overlay);
        assert.notEqual(result.status, 0);
        const combined = output(result);
        for (const relativePath of neighboringPaths)
        {
            assert.ok(combined.includes(`${relativePath} has no style owner or non-source classification`));
        }
        assert.ok(!combined.includes(`${dependencyOverlayArchive.path} has no style owner or non-source classification`));
    });
});
