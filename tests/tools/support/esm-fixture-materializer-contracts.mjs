import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    materializeEsmFixture,
    preflightMaterializedEsmFixture
} from './esm-fixture-materializer.mjs';
import { provisionLockedSchemaValidator } from './locked-schema-validator-fixture.mjs';

function createTempDir(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

export function assertTransitiveMaterialization()
{
    const source = createTempDir('esm-fixture-source');
    const fixture = createTempDir('esm-fixture-target');
    try
    {
        fs.mkdirSync(path.join(source, 'tools/nested'), { recursive: true });
        fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "import { value } from './level-one.mjs';\nconsole.log(value);\n");
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
        assert.equal(execFileSync(process.execPath, [result.entryFiles[0]], { encoding: 'utf8' }), 'complete\n');
    }
    finally
    {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

export function assertMissingDependencyDiagnostic()
{
    const fixture = createTempDir('esm-fixture-missing');
    try
    {
        fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
        const importer = path.join(fixture, 'tools/entry.mjs');
        const missing = path.join(fixture, 'tools/missing.mjs');
        fs.writeFileSync(importer, "import './missing.mjs';\n");
        assert.throws(
            () => preflightMaterializedEsmFixture({ fixtureRoot: fixture, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] }),
            (error) =>
            {
                assert.match(error.message, new RegExp(`importer=${importer.replaceAll('\\', '\\\\')}`, 'u'));
                assert.match(error.message, /specifier=\.\/missing\.mjs/u);
                assert.match(error.message, new RegExp(`resolved=${missing.replaceAll('\\', '\\\\')}`, 'u'));
                return true;
            }
        );
    }
    finally
    {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

export function assertAllowedRootBoundary()
{
    const source = createTempDir('esm-fixture-escape-source');
    const fixture = createTempDir('esm-fixture-escape-target');
    try
    {
        fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(source, 'outside.mjs'), 'export const escaped = true;\n');
        fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "export { escaped } from '../outside.mjs';\n");
        assert.throws(
            () => materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] }),
            /resolved target escapes allowed roots.*specifier=\.\.\/outside\.mjs/u
        );
    }
    finally
    {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

export function assertRuntimeAssetBoundary()
{
    const source = createTempDir('esm-runtime-asset-source');
    const fixture = createTempDir('esm-runtime-asset-target');
    const entry = 'tools/entry.mjs';
    const asset = 'tools/test/lanes/release-final.sh';
    try
    {
        fs.mkdirSync(path.join(source, 'tools/test/lanes'), { recursive: true });
        fs.writeFileSync(path.join(source, entry), 'export const ready = true;\n');
        const options = { repositoryRoot: source, fixtureRoot: fixture, entries: [entry],
            assets: [asset], allowedRoots: ['tools'] };
        assert.throws(() => materializeEsmFixture(options), /runtime asset is missing/u);
        const target = path.join(source, asset);
        fs.writeFileSync(target, '#!/usr/bin/env bash\nexit 0\n');
        const result = materializeEsmFixture(options);
        assert.ok(result.files.includes(asset));
        assert.deepEqual(fs.readFileSync(path.join(fixture, asset)), fs.readFileSync(target));
        const external = path.join(source, 'outside.txt');
        fs.writeFileSync(external, 'sentinel');
        fs.rmSync(path.join(fixture, asset));
        fs.symlinkSync(external, path.join(fixture, asset));
        assert.throws(() => materializeEsmFixture(options), /destination must be a literal regular file/u);
        assert.equal(fs.readFileSync(external, 'utf8'), 'sentinel');
        fs.rmSync(path.join(fixture, asset));
        const externalDirectory = path.join(source, 'outside-directory');
        fs.mkdirSync(externalDirectory);
        const fixtureLaneDirectory = path.join(fixture, 'tools/test/lanes');
        fs.rmdirSync(fixtureLaneDirectory);
        fs.symlinkSync(externalDirectory, fixtureLaneDirectory);
        assert.throws(() => materializeEsmFixture(options), /destination parent must be a literal directory/u);
        assert.deepEqual(fs.readdirSync(externalDirectory), []);
        fs.rmSync(fixtureLaneDirectory);
        fs.rmSync(target);
        fs.symlinkSync('../entry.mjs', target);
        assert.throws(() => materializeEsmFixture(options), /runtime asset must be a literal regular file/u);
    }
    finally
    {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

export function materializeTestMatrixRunner(repositoryRoot, fixtureRoot)
{
    if (path.resolve(repositoryRoot) === path.resolve(fixtureRoot))
    {
        throw new Error('scheduler fixture must be isolated from its source repository');
    }
    const workflowDirectory = path.join(fixtureRoot, '.github/workflows');
    const testingConfigDirectory = path.join(fixtureRoot, 'config/testing');
    const testDirectory = path.join(fixtureRoot, 'tests');
    fs.mkdirSync(workflowDirectory, { recursive: true });
    fs.mkdirSync(testingConfigDirectory, { recursive: true });
    fs.mkdirSync(testDirectory, { recursive: true });
    const fixture = materializeEsmFixture({
        repositoryRoot,
        fixtureRoot,
        entries: [
            'tools/run-test-matrix.mjs',
            'tools/test-matrix/schema-validator/validate.mjs',
            'tools/test-matrix/production-build-gc.mjs',
            'tools/test/measurement-noise-envelope.mjs',
            'tools/test/attempt-runner.mjs',
            'tools/test/bundles/run-bundle.mjs',
            'tools/test/temporal-context.mjs',
            'tools/test/physical-execution-unix-bootstrap.mjs',
            'tools/test/physical-execution-linux-systemd-bootstrap.mjs'
        ],
        // Entry-owned files read at runtime instead of imported as ESM.
        assets: [
            'tools/test-matrix/schema-validator/package.json',
            'tools/test-matrix/schema-validator/package-lock.json',
            'tools/test/native/execution-envelope-landlock.c',
            'tools/test-fixtures/producers/temporal-child-handshake.bash',
            'tools/test-fixtures/producers/temporal-child-handshake.cjs',
            'tools/test-fixtures/producers/temporal-child-handshake-emitter.cjs',
            'tools/test-fixtures/producers/temporal-child-observer.mjs',
            'tools/test/physical-execution-nested-socket.py',
            'src/shared/Contracts/Localization/locale-catalog.json',
            'tools/test/physical-execution-linux-preexec.py',
            'tools/test/physical-execution-windows-job.ps1',
            'tools/test-matrix/windows-job-members.ps1',
            'tools/test-matrix/windows-job-supervisor.ps1',
            'tools/test/lanes/release-final.sh',
            'tests/fixtures/test-matrix/release-final-evidence-inputs.json'
        ],
        allowedRoots: ['tools', 'src/frontend/scripts/fsusui-root.mjs',
            'src/shared/Contracts/Localization/locale-catalog.json',
            'tests/fixtures/test-matrix/release-final-evidence-inputs.json']
    });
    fs.copyFileSync(
        path.join(repositoryRoot, '.github/workflows/quality-gate.yml'),
        path.join(workflowDirectory, 'quality-gate.yml')
    );
    for (const file of [
        'correctness-attempt-producers.json',
        'correctness-budget-policy.json',
        'measurement-noise-policy.json',
        'physical-execution-process-policy.json',
        'release-reliability-scenario-catalog.json',
        'replay-qualification-producers.json',
        'temporal-callsite-dispositions.json',
        'temporal-policy.json',
        'test-execution-envelope-applicability.json'
    ])
    {
        fs.copyFileSync(
            path.join(repositoryRoot, 'config/testing', file),
            path.join(testingConfigDirectory, file)
        );
    }
    fs.copyFileSync(
        path.join(repositoryRoot, 'tests/matrix.yml'),
        path.join(testDirectory, 'matrix.yml')
    );
    provisionLockedSchemaValidator(fixtureRoot);
    // Full-checkout fixtures ignore node_modules by default. Their later admission seal
    // must bind these newly provisioned runtime bytes along with the original source.
    if (fs.existsSync(path.join(fixtureRoot, '.git')))
    {
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '--force', '--',
            'tools/test-matrix/schema-validator/node_modules'], { cwd: fixtureRoot });
    }
    return fixture.entryFiles[0];
}
