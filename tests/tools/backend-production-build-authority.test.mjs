import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    validateBackendProductionBuildAuthority
} = await import(pathToFileURL(path.join(root, 'tools/test/check-backend-production-build-authority.mjs')).href);

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const inputs = () => ({
    inventory: JSON.parse(read('tests/governance/backend-production-build-consumers.json')),
    bundleSource: read('tools/test/bundles/run-bundle.mjs'),
    shardSource: read('tools/test/run-backend-production-shards.mjs'),
    rightsSource: read('tools/test/project-rights-v3-evidence.mjs'),
    integritySource: read('tools/test/project-evidence.mjs'),
    privacySource: read('tools/test/lanes/project-privacy-zk-production.mjs'),
    crossStackSource: read('tools/test/lanes/cross-stack-contract.sh')
});

test('Production fresh has one canonical Release backend build set and no governance postlude', () =>
{
    assert.deepEqual(validateBackendProductionBuildAuthority(inputs()), {
        schema: 'fsusblog.backend-production-build-authority.v1',
        status: 'success',
        buildRequestCount: 3,
        debugBuildRequestCount: 0,
        postludeTesthostCount: 0,
        consumers: inputs().inventory.consumers
    });
});

test('validator rejects a Debug compatibility build in the Production backend bundle', () =>
{
    const fixture = inputs();
    fixture.bundleSource = fixture.bundleSource.replace(
        'async function runBackendTests() {',
        'async function runBackendTests() {\nFSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild'
    );
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /Debug or filtered backend compatibility build/u
    );
});

test('validator rejects a single-test governance postlude regression', () =>
{
    const fixture = inputs();
    fixture.shardSource += '\nconst postludeResult = runDotnet("governance-postlude.trx")\n';
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /governance postlude/u
    );
});

test('validator rejects loss of the canonical test-DLL receipt digest', () =>
{
    const fixture = inputs();
    fixture.bundleSource = fixture.bundleSource.replace(
        'contentDigest: fileContentDigest(backendTestDll)',
        'contentDigest: null'
    );
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /test-DLL receipt binding/u
    );
});
