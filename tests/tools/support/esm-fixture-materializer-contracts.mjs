import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    materializeEsmFixture,
    preflightMaterializedEsmFixture
} from './esm-fixture-materializer.mjs';

function createTempDir(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

export async function assertTransitiveMaterialization()
{
    const source = createTempDir('esm-fixture-source');
    const fixture = createTempDir('esm-fixture-target');
    fs.mkdirSync(path.join(source, 'tools/nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "export { value } from './level-one.mjs';\n");
    fs.writeFileSync(path.join(source, 'tools/level-one.mjs'), "import { value } from './nested/level-two.mjs';\nexport { value };\n");
    fs.writeFileSync(path.join(source, 'tools/nested/level-two.mjs'), "export const value = 'complete';\n");

    const result = materializeEsmFixture({
        repositoryRoot: source,
        fixtureRoot: fixture,
        entries: ['tools/entry.mjs'],
        allowedRoots: ['tools']
    });
    assert.deepEqual(result.files, [
        'tools/entry.mjs',
        'tools/level-one.mjs',
        'tools/nested/level-two.mjs'
    ]);
    const loaded = await import(`${pathToFileURL(result.entryFiles[0]).href}?test=${Date.now()}-${Math.random()}`);
    assert.equal(loaded.value, 'complete');
}

export function assertMissingDependencyDiagnostic()
{
    const fixture = createTempDir('esm-fixture-missing');
    fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
    const importer = path.join(fixture, 'tools/entry.mjs');
    const missing = path.join(fixture, 'tools/missing.mjs');
    fs.writeFileSync(importer, "import './missing.mjs';\n");
    assert.throws(
        () => preflightMaterializedEsmFixture({ fixtureRoot: fixture, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] }),
        (error) => {
            assert.match(error.message, new RegExp(`importer=${importer.replaceAll('\\', '\\\\')}`, 'u'));
            assert.match(error.message, /specifier=\.\/missing\.mjs/u);
            assert.match(error.message, new RegExp(`resolved=${missing.replaceAll('\\', '\\\\')}`, 'u'));
            return true;
        }
    );
}

export function assertAllowedRootBoundary()
{
    const source = createTempDir('esm-fixture-escape-source');
    const fixture = createTempDir('esm-fixture-escape-target');
    fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(source, 'outside.mjs'), 'export const escaped = true;\n');
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "export { escaped } from '../outside.mjs';\n");
    assert.throws(
        () => materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] }),
        /resolved target escapes allowed roots.*specifier=\.\.\/outside\.mjs/u
    );
}

export function materializeTestMatrixRunner(repositoryRoot, fixtureRoot)
{
    const workflowDirectory = path.join(fixtureRoot, '.github/workflows');
    fs.mkdirSync(workflowDirectory, { recursive: true });
    const fixture = materializeEsmFixture({
        repositoryRoot,
        fixtureRoot,
        entries: [
            'tools/run-test-matrix.mjs',
            'tools/test-matrix/production-build-gc.mjs'
        ],
        allowedRoots: ['tools']
    });
    fs.copyFileSync(
        path.join(repositoryRoot, '.github/workflows/quality-gate.yml'),
        path.join(workflowDirectory, 'quality-gate.yml')
    );
    return fixture.entryFiles[0];
}
