import assert from 'node:assert/strict';
// eslint-disable-next-line import-x/order
import fs from 'node:fs';

import path from 'node:path';
import test from 'node:test';

const {createProductionBuildReceipt, verifyProductionBuildReceipt} = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {aggregatePublicShellLocale} = await import(new URL('../../tools/test-matrix/aggregate-public-shell-locale.mjs', import.meta.url));
const {gateDigest, loadPublicShellLocaleGate, publicShellLocaleSubResultSchema} = await import(new URL('../../tools/test-matrix/public-shell-locale-gate.mjs', import.meta.url));
const {publicShellLocaleIdentity, validatePublicShellLocaleSubResults} = await import(new URL('../../tools/test-matrix/public-shell-locale-evidence.mjs', import.meta.url));
const {verifyPublicShellLocaleQualification} = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
const {createPublicShellLocaleMatrix} = await import(new URL('../../tests/browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const root = path.resolve(new URL('../../', import.meta.url).pathname);
const matrix = await createPublicShellLocaleMatrix(root);

const toolchain = {
    node: process.version,
    npm: 'local-fixture',
    dotnet: 'local-fixture',
    vite: 'local-fixture',
    vitest: 'local-fixture',
    playwright: 'local-fixture',
    emsdk: 'local-fixture'
};

function fixture(t)
{
    const workspace = fs.mkdtempSync(path.join(root, '.tmp/public-shell-locale-aggregate-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const artifactRoot = path.join(workspace, 'build');
    const domains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    for (const domain of domains)
    {
        fs.mkdirSync(path.join(artifactRoot, domain), { recursive: true });
        fs.writeFileSync(path.join(artifactRoot, domain, 'manifest.txt'), `${domain}\n`);
    }
    const buildReceipt = createProductionBuildReceipt({
        root,
        artifactRoot,
        sourceState: {
            commit: matrix.identity.sourceCommit,
            worktreeFingerprint: matrix.identity.worktreeFingerprint
        },
        producer: {
            workflow: 'local PublicShell locale aggregate fixture',
            runId: `public-shell-locale-${process.pid}`,
            runAttempt: 1,
            job: 'public-shell-locale-aggregate'
        },
        toolchain,
        inputPaths: ['tests/browser-contract/public-shell-locale-matrix.mjs'],
        domains: domains.map((name) => ({ name, path: name })),
        build: {
            profile: 'local-public-shell-locale-contract',
            command: 'node --test tests/tools/public-shell-locale-aggregate.test.mjs'
        }
    });
    const inputFile = path.join(workspace, 'sub-results.json');
    const outputFile = path.join(workspace, 'qualification.json');
    return { workspace, artifactRoot, buildReceipt, inputFile, outputFile };
}

function resultFor(scene, identity)
{
    const body = {
        schema: publicShellLocaleSubResultSchema,
        status: 'passed',
        evidenceKind: 'browser-contract',
        qualificationEligible: true,
        browserSpawnCount: 0,
        subMatrixSpawnCount: 0,
        scene: structuredClone(scene),
        observed: {
            locale: scene.locale,
            uiLocale: scene.transition?.expectedUiLocale ?? scene.locale,
            source: scene.source,
            route: scene.route,
            stage: scene.stage,
            copyKeys: structuredClone(scene.expectedKeys),
            requiredDomains: [...scene.requiredDomains],
            fontFaceIds: [...scene.requiredFont.faceIds],
            selectorLocales: matrix.locales.map((locale) => locale.code),
            network: {
                checked: true,
                domainSet: [...scene.requiredDomains],
                fontSet: [...scene.requiredFont.faceIds],
                localeSet: [...scene.networkPolicy.localeSet],
                includeCacheAndPreload: scene.networkPolicy.includeCacheAndPreload,
                businessDataReRequests: scene.networkPolicy.businessDataReRequests,
                requestCounts: {
                    document: 1,
                    localeArtifacts: scene.requiredDomains.length,
                    fonts: scene.requiredFont.faceIds.length,
                    total: 1 + scene.requiredDomains.length + scene.requiredFont.faceIds.length
                }
            },
            commitGenerations: {
                sameRun: true,
                document: 1,
                locale: 1,
                font: 1,
                preference: 1
            },
            geometry: {
                inspected: true,
                ref: scene.geometryRef,
                viewport: structuredClone(scene.viewport),
                layoutStable: true
            },
            preference: {
                checked: true,
                persistenceChecked: true,
                state: 'current-run-fixture'
            },
            failureRecovery: {
                checked: true,
                recoveryObserved: true,
                state: scene.transition?.failureMode ?? 'normal'
            },
            consoleErrors: [],
            warnings: [],
            notObserved: [],
            issues: []
        },
        identity,
        refs: [{
            path: `local-fixture/${scene.id}.json`,
            digest: gateDigest({ sceneId: scene.id, evidenceId: scene.evidenceId })
        }]
    };
    return { ...body, contentDigest: gateDigest(body) };
}

function createResults(buildDigest)
{
    const identity = publicShellLocaleIdentity(matrix, buildDigest, {
        runtimeId: 'local-public-shell-runtime',
        fixtureId: 'local-public-shell-fixture',
        browserId: 'no-browser-local-contract-fixture'
    });
    return matrix.scenes.map((scene) => resultFor(scene, identity));
}

function writeInput(file, results, extra = {})
{
    fs.writeFileSync(file, `${JSON.stringify({
        schema: 'fsusblog.public-shell-locale-sub-results.v1',
        ...extra,
        results
    }, null, 2)}\n`);
}

function writeReceipt(file, receipt)
{
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

test('aggregate and independent verifier produce a complete ten-locale terminal receipt without browser spawn', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest);
    writeInput(value.inputFile, results, { producer: 'local-sub-result-fixture' });
    const receipt = await aggregatePublicShellLocale({
        root,
        inputFile: value.inputFile,
        outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(receipt.schema, 'fsusblog.public-shell-locale-qualification.v1');
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.qualificationEligible, true);
    assert.equal(receipt.producer.browserSpawnCount, 0);
    assert.equal(receipt.verifier.browserSpawnCount, 0);
    assert.equal(receipt.matrix.sceneCount, 8208);
    assert.equal(receipt.coverage.locales.length, 10);
    assert.equal(receipt.scenes.length, 8208);
    const verified = await verifyPublicShellLocaleQualification({
        root,
        receiptFile: value.outputFile,
        inputFile: value.inputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(verified.ok, true, verified.errors.join('; '));
    assert.deepEqual(verified.errors, []);
});

test('aggregate required-set and identity mutations fail closed', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest);
    const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile: path.join(value.artifactRoot, 'receipt.json') });
    const positive = validatePublicShellLocaleSubResults({ matrix, results, buildDigest: value.buildReceipt.contentDigest });
    assert.equal(positive.orderedResults.length, matrix.scenes.length);
    const rejectMutation = (label, mutate) =>
    {
        const candidate = structuredClone(results);
        mutate(candidate);
        assert.throws(
            () => validatePublicShellLocaleSubResults({ matrix, results: candidate, buildDigest: value.buildReceipt.contentDigest }),
            /does not match|missing|duplicate|extra|diagnostic|crosses|not observed|not checked|spawning|mismatch|unregistered/u,
            label
        );
    };
    rejectMutation('missing scene', (candidate) => candidate.pop());
    rejectMutation('extra scene', (candidate) =>
    {
        const extra = structuredClone(candidate[0]);
        extra.scene.id = '2083/extra-scene';
        candidate.push(extra);
    });
    rejectMutation('duplicate scene', (candidate) => candidate.push(structuredClone(candidate[0])));
    rejectMutation('cross-build identity', (candidate) =>
    {
        candidate[0].identity.buildDigest = 'sha256:' + '0'.repeat(64);
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('diagnostic sub-result', (candidate) =>
    {
        candidate[0].qualificationEligible = false;
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('network not checked', (candidate) =>
    {
        candidate[0].observed.network.checked = false;
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('target locale missing', (candidate) =>
    {
        candidate[0].observed.copyKeys = [];
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('browser spawn mutation', (candidate) =>
    {
        candidate[0].browserSpawnCount = 1;
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    rejectMutation('screenshot-only authority', (candidate) =>
    {
        candidate[0].observed.screenshot = { digest: '0'.repeat(64) };
        delete candidate[0].contentDigest;
        candidate[0].contentDigest = gateDigest(candidate[0]);
    });
    assert.equal(gate.matrix.scenes.length, 8208);
});

test('terminal receipt, input, refs and digest tampering fail independent verification', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest);
    writeInput(value.inputFile, results);
    await aggregatePublicShellLocale({
        root,
        inputFile: value.inputFile,
        outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    const originalReceipt = JSON.parse(fs.readFileSync(value.outputFile, 'utf8'));
    const expectVerifierFailure = async (label, mutate) =>
    {
        const candidate = structuredClone(originalReceipt);
        mutate(candidate);
        writeReceipt(value.outputFile, candidate);
        const result = await verifyPublicShellLocaleQualification({
            root,
            receiptFile: value.outputFile,
            inputFile: value.inputFile,
            buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
        });
        assert.equal(result.ok, false, label);
        assert.ok(result.errors.length > 0, label);
    };
    await expectVerifierFailure('receipt digest tamper', (candidate) =>
    {
        candidate.contentDigest = '0'.repeat(64);
    });
    await expectVerifierFailure('referenced scene missing with correct aggregate count', (candidate) =>
    {
        candidate.scenes.pop();
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('aggregate browser spawn tamper', (candidate) =>
    {
        candidate.producer.browserSpawnCount = 1;
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('identity tamper', (candidate) =>
    {
        candidate.identity.fixtureId = 'cross-run-fixture';
        candidate.contentDigest = gateDigest(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentDigest')));
    });
    await expectVerifierFailure('input tamper', () =>
    {
        const changed = JSON.parse(fs.readFileSync(value.inputFile, 'utf8'));
        changed.results[0].observed.copyKeys = [];
        fs.writeFileSync(value.inputFile, `${JSON.stringify(changed, null, 2)}\n`);
    });
});

test('sub-result order does not affect canonical aggregate output', async (t) =>
{
    const value = fixture(t);
    const results = createResults(value.buildReceipt.contentDigest);
    writeInput(value.inputFile, results);
    const first = await aggregatePublicShellLocale({
        root,
        inputFile: value.inputFile,
        outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    writeInput(value.inputFile, [...results].reverse());
    const second = await aggregatePublicShellLocale({
        root,
        inputFile: value.inputFile,
        outputFile: value.outputFile,
        buildReceiptFile: path.join(value.artifactRoot, 'receipt.json')
    });
    assert.equal(first.contentDigest, second.contentDigest);
    assert.deepEqual(first.scenes, second.scenes);
});

test('production build identity rejects a stale receipt before aggregation', async () =>
{
    const staleReceipt = path.join(root, '.tmp/i18n-production-build-window-20260905-01/receipt.json');
    if (!fs.existsSync(staleReceipt))
    {
        return;
    }
    assert.throws(
        () => verifyProductionBuildReceipt({
            artifactRoot: path.dirname(staleReceipt),
            receiptFile: path.basename(staleReceipt),
            expectedSourceState: matrix.identity
        }),
        /commit SHA mismatch|worktree fingerprint mismatch/u
    );
});
