import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const producer = { workflow: 'Quality Gate', runId: '42', runAttempt: 1, job: 'production-build-artifacts' };
const toolchain = {
    node: 'v24', npm: '11', dotnet: '10', vite: '7', vitest: '4', playwright: '1.58', emsdk: '4'
};

function write(rootDirectory, relative, content)
{
    const file = path.join(rootDirectory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

test('acceptance bootstrap materializes verified domains into its current run-bound roots and forces no-build', t =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ci-bootstrap-artifact-'));
    const namespace = `ci-artifact-${randomUUID().slice(0, 8)}`;
    const targetRoot = path.join(root, '.tmp', `ci-bootstrap-materialized-${randomUUID()}`);
    const envFile = path.join(root, '.tmp/env', `${namespace}.env`);
    const evidenceFile = path.join(root, '.tmp/release-evidence/jobs', `ci-build-materialization-${namespace}.json`);
    t.after(() =>
    {
        fs.rmSync(temporary, { recursive: true, force: true });
        fs.rmSync(`${temporary}.state`, { recursive: true, force: true });
        fs.rmSync(targetRoot, { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true });
        fs.rmSync(envFile, { force: true });
        fs.rmSync(evidenceFile, { force: true });
    });

    write(temporary, 'payload/backend-runtime/FsusBlog.Server.dll', 'server');
    write(temporary, 'payload/test-runtime/FsusBlog.Server.Tests.dll', 'tests');
    write(temporary, 'payload/frontend-dist/index.html', '<main>immutable</main>');
    write(temporary, 'payload/frontend-dist/server/server-public-ssr.bundle.mjs', 'worker');
    write(temporary, 'payload/frontend-dist/server/public-ssr.mjs', 'renderer');
    write(temporary, 'payload/wasm/aeds.wasm', 'wasm');
    write(temporary, 'payload/generated-contracts/fsusblog.openapi.json', '{}');
    write(temporary, 'input.json', '{}');
    const receipt = createProductionBuildReceipt({
        root: temporary,
        artifactRoot: temporary,
        sourceState,
        producer,
        toolchain,
        inputPaths: ['input.json'],
        domains: [
            { name: 'backend-runtime', path: 'payload/backend-runtime' },
            { name: 'test-runtime', path: 'payload/test-runtime', consumerMode: 'copy-before-write' },
            { name: 'frontend-dist', path: 'payload/frontend-dist' },
            { name: 'wasm', path: 'payload/wasm' },
            { name: 'generated-contracts', path: 'payload/generated-contracts' }
        ]
    });
    fs.rmSync(path.join(temporary, 'input.json'));
    // Inputs belong to producer identity, not the uploaded artifact payload.
    // Recreate the exact uploaded root by removing the producer-only input before verification.
    // The receipt does not list it as an artifact.

    const result = spawnSync('bash', ['tools/bootstrap-acceptance-env.sh', '--prepare-env-only'], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_RUN_ID: `consumer-${namespace}`,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: temporary,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: receipt.contentDigest,
            FSUSBLOG_RUNTIME_NO_BUILD: '1',
            GITHUB_RUN_ID: producer.runId,
            GITHUB_RUN_ATTEMPT: '9',
            FSUSBLOG_BACKEND_SERVER_DLL: path.join(targetRoot, 'backend/FsusBlog.Server.dll'),
            FSUSBLOG_BACKEND_TEST_BIN_DIR: path.join(targetRoot, 'tests'),
            FSUSBLOG_FRONTEND_DIST_ROOT: path.join(targetRoot, 'frontend/dist'),
            FSUSBLOG_FRONTEND_WASM_ROOT: path.join(targetRoot, 'frontend/wasm'),
            FSUSBLOG_GENERATED_OUTPUT_ROOT: path.join(targetRoot, 'generated'),
            FSUSBLOG_BACKEND_WEBROOT: path.join(targetRoot, 'backend-wwwroot')
        }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /materialized verified immutable CI production domains/u);
    assert.equal(fs.readFileSync(path.join(targetRoot, 'backend/FsusBlog.Server.dll'), 'utf8'), 'server');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'tests/FsusBlog.Server.Tests.dll'), 'utf8'), 'tests');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'frontend/dist/index.html'), 'utf8'), '<main>immutable</main>');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'backend-wwwroot/index.html'), 'utf8'), '<main>immutable</main>');
    assert.notEqual(
        fs.realpathSync(path.join(targetRoot, 'frontend/dist')),
        fs.realpathSync(path.join(targetRoot, 'backend-wwwroot'))
    );
    fs.writeFileSync(path.join(targetRoot, 'backend-wwwroot/runtime-generated.txt'), 'runtime');
    assert.equal(fs.existsSync(path.join(temporary, 'payload/frontend-dist/runtime-generated.txt')), false);
    assert.equal(fs.readFileSync(path.join(targetRoot, 'frontend/wasm/aeds.wasm'), 'utf8'), 'wasm');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'generated/ci-contracts/fsusblog.openapi.json'), 'utf8'), '{}');
    const runtimeEnvironment = fs.readFileSync(envFile, 'utf8');
    assert.match(runtimeEnvironment, /^FSUSBLOG_RUNTIME_NO_BUILD=1$/mu);
    assert.ok(runtimeEnvironment.split('\n').includes(
        `PublicAot__SsrClientRoot=${path.join(targetRoot, 'frontend/dist')}`
    ));
    assert.match(
        runtimeEnvironment,
        /^PublicAot__SsrWorkerScript=\.\/server\/server-public-ssr\.bundle\.mjs$/mu
    );
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.status, 'success');
    assert.equal(evidence.consumerLease.status, 'active');
    assert.ok(evidence.materialized.some(value => value.endsWith('backend/FsusBlog.Server.dll')));
    const frontendMaterializations = evidence.materialization.domains
        .filter((domain) => domain.name === 'frontend-dist')
        .map((domain) => domain.method);
    assert.equal(frontendMaterializations[0], 'reference');
    assert.ok(['reflink', 'copy-fallback'].includes(frontendMaterializations[1]));
});

test('CI bootstrap source keeps backend-only consumers free of frontend startup and forbids rebuild fallback', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    assert.match(source, /CiProductionHasDomain frontend-dist[\s\S]*runtimeApplications\+=\(release-preview EnsureReleasePreview debug-frontend EnsureDebugFrontend\)/u);
    assert.match(source, /FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT[\s\S]*vite preview/u);
    assert.match(source, /runtimeArgs="-c \$runtimeConfiguration --no-build --no-restore"/u);
    assert.match(source, /local -x PublicAot__SsrClientRoot="\$PUBLIC_AOT_SSR_CLIENT_ROOT"/u);
    assert.match(
        source,
        /--run-id "\$\{FSUSBLOG_TEST_RUN_ID:-\}"[\s\S]*--source-commit "\$\{FSUSBLOG_TEST_SOURCE_COMMIT:\?fixture orchestrator source commit is required\}"[\s\S]*--source-fingerprint "\$\{FSUSBLOG_TEST_SOURCE_FINGERPRINT:\?fixture orchestrator source fingerprint is required\}"/u
    );
    assert.match(
        source,
        /ConfigureLocalPublicContentFixture\(\)[\s\S]*FIXTURE_REQUIRES_PUBLIC[\s\S]*export FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="\$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"[\s\S]*export fsus__allowLocalPublicContentFixture=true[\s\S]*export fsus__localPublicContentFixtureSecret="\$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"/u
    );
    assert.doesNotMatch(source, /runArgs\+=\([^)]*localPublicContentFixtureSecret/su);
    assert.match(source, /currentFingerprint" == "\$nextFingerprint"[\s\S]*debug backend already healthy/u);
    assert.doesNotMatch(source, /CI production[^\n]*fallback[^\n]*build/iu);
});
