import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compositionDigest, createCompositionIdentity, loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { governanceContentDigest } from '@fsusblog/layout-governance/evidence-location-contract';
import { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } from '@fsusblog/layout-governance/evidence-publication';
import { extractCurrentRunEvidenceTransport, packCurrentRunEvidenceTransport } from '@fsusblog/layout-governance/evidence-transport';
import { visualArtifactDigest, visualReceiptDigest, visualRubricFields, visualVerifierIdentity } from '@fsusblog/layout-governance/visual-adjudication';
import { inspectVisualBrowserBinding, inspectVisualProducerAdmission, visualProducerAdmissionIdentity } from '@fsusblog/layout-governance/visual-producer-admission';

const canonicalRoot = fileURLToPath(new URL('../..', import.meta.url));
const hash = 'b'.repeat(64);
const registryBytes = readFileSync(join(canonicalRoot, 'config/testing/evidence-locator-registry.json'));
const entry = JSON.parse(registryBytes).entries.find(({ consumerId }) => consumerId === 'evidence-consumer.workflow.quality-gate');

function sealContext(context)
{
    context.contentDigest = governanceContentDigest(context);
}

function fixture(t, change = () =>
{})
{
    // Every resource and observation here is explicitly synthetic. The fixture
    // uses an existing registry entry without registering a visual producer.
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'synthetic-visual-admission-'));
    t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
    mkdirSync(join(repositoryRoot, 'artifacts/current-run'), { recursive: true });
    mkdirSync(join(repositoryRoot, 'config/testing'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'config/testing/evidence-locator-registry.json'), registryBytes);
    writeFileSync(join(repositoryRoot, 'package.json'), '{"private":true,"name":"synthetic-admission-fixture"}\n');
    const context = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'synthetic-admission-run',
        attemptId: 'synthetic-admission-attempt', sourceCommit: 'a'.repeat(40), worktreeFingerprint: `sha256:${hash}`,
        candidateIdentity: { id: 'synthetic-candidate', digest: `sha256:${hash}` },
        buildIdentity: { id: 'synthetic-build', digest: `sha256:${hash}` }, ownedRoots: ['artifacts/current-run']
    };
    sealContext(context);
    const inputs = loadCompositionInputs({ repositoryRoot: canonicalRoot });
    const baseline = {
        schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1', sourceKind: 'local-source',
        repository: 'Ozwasyd/FsusUI', absolutePath: '/synthetic/fsusui', gitHead: 'c'.repeat(40),
        packageVersion: 'synthetic-test-package', dirty: false, dirtyFingerprint: hash, skillDigest: hash,
        contractDigests: { stagePolicy: hash, classification: hash, adjudication: hash, uxAcceptance: hash }
    };
    baseline.baselineDigest = compositionDigest(baseline);
    const compositionIdentity = createCompositionIdentity(inputs, { sourceCommit: context.sourceCommit, fsusUIBaselineIdentity: baseline });
    const binding = { scene: { archetype: 'admin/settings', routePattern: '/manage/settings', routeFixtureDigest: hash,
        theme: 'light', viewport: { width: 1440, height: 900, zoom: 1 }, state: 'synthetic-loaded', media: 'default' },
    compositionIdentityDigest: compositionIdentity.identityDigest, worktreeFingerprint: hash,
    runId: context.schedulerRunId, attemptId: context.attemptId };
    const evidenceArtifacts = {};
    const evidence = ['screenshot', 'static', 'dom', 'geometry'].map((kind) =>
    {
        const id = `synthetic-${kind}`;
        const bytes = Buffer.from(`synthetic ${kind} artifact, never runtime evidence`);
        const opaqueProducerBytes = Buffer.from(`synthetic opaque ${kind} producer, no schema guessed`);
        evidenceArtifacts[id] = { bytes, opaqueProducerBytes };
        return { id, kind, binding: structuredClone(binding), contentDigest: visualArtifactDigest(bytes), opaqueProducerDigest: visualArtifactDigest(opaqueProducerBytes) };
    });
    const visualReceipt = {
        schema: 'fsusblog.layout-visual-adjudication.v1', ...visualVerifierIdentity(), evidenceClass: 'synthetic',
        status: 'verified', compositionIdentity, binding,
        adjudicator: { id: 'synthetic-adjudicator', independentReviewerId: 'synthetic-reviewer', runId: binding.runId, method: 'independent-rendered-field-review' },
        evidence, rubric: Object.fromEntries(visualRubricFields.map((field) => [field, {
            status: 'pass', evidenceIds: evidence.map(({ id }) => id), binding: structuredClone(binding), reason: null, blockingIssue: null
        }])), baselineMovement: null, warnings: []
    };
    change(visualReceipt, context, evidenceArtifacts);
    visualReceipt.contentDigest = visualReceiptDigest(visualReceipt);
    const outputPath = 'artifacts/current-run/synthetic-visual-reference.json';
    const payloadPath = 'artifacts/current-run/synthetic-visual-payload.json';
    const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId, context,
        outputPath, payloadPath, producerId: entry.producerId, repositoryRoot });
    writeFileSync(join(repositoryRoot, payloadPath), `${JSON.stringify(visualReceipt)}\n`);
    finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId, context, outputPath, payloadPath,
        producerId: entry.producerId, repositoryRoot, sessionId: session.sessionId,
        payloadSchema: visualReceipt.schema, terminalStatus: 'success' });
    return { options: { visualReceipt, context, repositoryRoot, evidenceArtifacts, purpose: 'synthetic-contract-test',
        visualOrigin: { consumerId: entry.consumerId, explicitInputs: [outputPath] } }, payloadPath, outputPath };
}

function rejected(t, change, code)
{
    const { options } = fixture(t);
    change(options);
    assert.throws(() => inspectVisualProducerAdmission(options), code ? { code: `visual-admission-${code}` } : undefined);
}

test('synthetic publication resolves canonical origin and bytes but cannot skip actual browser origin', (t) =>
{
    const { options } = fixture(t);
    assert.throws(() => inspectVisualProducerAdmission(options), { code: 'visual-admission-browser-origin-required' });
});

test('custom repository and synthetic purpose cannot be admitted as production', (t) =>
{
    rejected(t, (options) =>
    {
        delete options.purpose;
    }, 'repository-scope');
});

test('unknown consumer and caller registry/callback cannot replace canonical registry', (t) =>
{
    rejected(t, (options) =>
    {
        options.visualOrigin.consumerId = 'synthetic-unregistered-producer';
    }, 'consumer-unregistered');
    rejected(t, (options) =>
    {
        options.visualOrigin.registry = {};
    }, 'origin-options');
    rejected(t, (options) =>
    {
        options.visualOrigin.verify = () => true;
    }, 'origin-options');
});

test('missing, ambiguous and wrong locator-mode origin inputs fail closed', (t) =>
{
    rejected(t, (options) =>
    {
        options.visualOrigin.explicitInputs = [];
    }, 'origin-cardinality');
    rejected(t, (options) =>
    {
        options.visualOrigin.explicitInputs.push(options.visualOrigin.explicitInputs[0]);
    }, 'origin-cardinality');
    rejected(t, (options) =>
    {
        options.visualOrigin.reference = { path: options.visualOrigin.explicitInputs[0], objectDigest: `sha256:${hash}` };
    }, 'origin-cardinality');
});

for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
{
    test(`canonical origin refuses independently resealed cross-run ${field}`, (t) =>
    {
        rejected(t, (options) =>
        {
            options.context[field] = field.endsWith('Identity') ? { id: 'synthetic-other', digest: `sha256:${'d'.repeat(64)}` }
                : field === 'sourceCommit' ? 'd'.repeat(40) : field === 'worktreeFingerprint' ? `sha256:${'d'.repeat(64)}` : 'synthetic-other';
            sealContext(options.context);
        });
    });
}

for (const field of ['runId', 'attemptId', 'worktreeFingerprint'])
{
    test(`canonical payload refuses visual ${field} unrelated to its publication origin`, (t) =>
    {
        const { options } = fixture(t, (receipt) =>
        {
            receipt.binding[field] = field === 'worktreeFingerprint' ? 'd'.repeat(64) : 'synthetic-other';
        });
        assert.throws(() => inspectVisualProducerAdmission(options), { code: 'visual-admission-binding-mismatch' });
    });
}

test('matching visual caller object cannot mask tampered canonical payload bytes', (t) =>
{
    const { options, payloadPath } = fixture(t);
    writeFileSync(join(options.repositoryRoot, payloadPath), '{"fixtureClass":"synthetic-tamper"}');
    assert.throws(() => inspectVisualProducerAdmission(options), /payload reference digest mismatch/u);
});

test('caller visual receipt differs from actual canonical payload despite a valid replacement seal', (t) =>
{
    rejected(t, (options) =>
    {
        options.visualReceipt.adjudicator.id = 'synthetic-different';
        options.visualReceipt.contentDigest = visualReceiptDigest(options.visualReceipt);
    }, 'binding-mismatch');
});

test('stale visual adapter digest is refused independently of the visual seal', (t) =>
{
    rejected(t, (options) =>
    {
        options.visualReceipt.producerAdmissionDigest = 'd'.repeat(64);
        options.visualReceipt.contentDigest = visualReceiptDigest(options.visualReceipt);
    }, 'version-drift');
});

test('every explicit artifact and opaque producer byte sequence is required unchanged', (t) =>
{
    for (const kind of ['screenshot', 'static', 'dom', 'geometry'])
    {
        rejected(t, (options) =>
        {
            options.evidenceArtifacts[`synthetic-${kind}`].bytes = Buffer.from('synthetic tamper');
        }, 'evidence-tampered');
        rejected(t, (options) =>
        {
            options.evidenceArtifacts[`synthetic-${kind}`].opaqueProducerBytes = Buffer.from('synthetic tamper');
        }, 'evidence-tampered');
    }
    rejected(t, (options) =>
    {
        delete options.evidenceArtifacts['synthetic-geometry'];
    }, 'evidence-cardinality');
    rejected(t, (options) =>
    {
        options.evidenceArtifacts.extra = options.evidenceArtifacts['synthetic-dom'];
    }, 'evidence-cardinality');
});

test('cross-scene evidence remains rejected even when canonical payload and digest seals match', (t) =>
{
    const { options } = fixture(t, (receipt) =>
    {
        receipt.evidence[0].binding.scene.theme = 'dark';
    });
    assert.throws(() => inspectVisualProducerAdmission(options), { code: 'visual-admission-binding-mismatch' });
});

test('transport inputs require an explicit sealed manifest identity without fallback', (t) =>
{
    rejected(t, (options) =>
    {
        options.visualOrigin.transportManifestPath = 'synthetic/missing.json';
    }, 'transport-digest-required');
    rejected(t, (options) =>
    {
        options.visualOrigin.expectedManifestDigest = `sha256:${hash}`;
    }, 'origin-options');
    rejected(t, (options) =>
    {
        options.visualOrigin.explicitInputs = ['.tmp/downloaded-artifacts/synthetic.json'];
    });
});

test('browser helper refuses invalid plans and never treats diagnostic identity as current correctness', () =>
{
    assert.throws(() => inspectVisualBrowserBinding({}, {}), /correctness browser plan classification/u);
});

test('consumer identity binds canonical dependency and authority bytes; self-tests are not qualification', () =>
{
    const identity = visualProducerAdmissionIdentity();
    assert.equal(identity.moduleDigest, visualArtifactDigest(readFileSync(join(canonicalRoot, 'tests/frontend/support/layout/visualProducerAdmission.mjs'))));
    for (const [path, digest] of Object.entries(identity.dependencyDigests))
    {
        assert.equal(digest, visualArtifactDigest(readFileSync(join(canonicalRoot, path))));
    }
    const { producerAdmissionDigest, ...unsigned } = identity;
    assert.equal(producerAdmissionDigest, compositionDigest(unsigned));
});

function syntheticBrowser()
{
    // Public #1313 identity shapes only; no live browser or producer is claimed.
    const executablePath = '/synthetic/chromium-1217/chrome';
    const plan = {
        schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness',
        evidenceClass: 'browser-contract', qualificationEligible: true, managedExecutable: true,
        browserName: 'chromium', browserVersion: 'synthetic-version', revision: '1217', executablePath,
        executableSha256: `sha256:${hash}`, playwright: { package: '@playwright/test', version: 'synthetic',
            packageDigest: `sha256:${hash}`, browserCatalogDigest: `sha256:${hash}` },
        launchOptions: { headless: true, executablePath, args: ['--disable-gpu', '--use-angle=swiftshader'] },
        rendering: { fontSetDigest: `sha256:${hash}`, localeDataDigest: `sha256:${hash}`, locale: 'zh-CN',
            deviceScaleFactor: 1, colorScheme: 'light', renderingMode: 'headless', gpuMode: 'software' }
    };
    plan.contentDigest = governanceContentDigest(plan);
    const actual = { ...structuredClone(plan), schema: 'fsusblog.playwright-browser-actual.v1',
        planDigest: plan.contentDigest, renderingObservation: { locale: 'zh-CN', deviceScaleFactor: 1,
            colorScheme: 'light', renderer: 'synthetic software renderer' } };
    actual.contentDigest = governanceContentDigest(actual);
    return { plan, actual };
}

test('actual browser raw seal is independently required before planned/actual comparison', () =>
{
    const { plan, actual } = syntheticBrowser();
    actual.contentDigest = `sha256:${'d'.repeat(64)}`;
    assert.throws(() => inspectVisualBrowserBinding(plan, actual), { code: 'visual-admission-browser-seal' });
});

test('independently resealed browser binary/font/rendering drift cannot equal current plan', () =>
{
    for (const field of ['executableSha256', 'playwright', 'rendering'])
    {
        const { plan, actual } = syntheticBrowser();
        if (field === 'executableSha256')
        {
            actual[field] = `sha256:${'d'.repeat(64)}`;
        }
        if (field === 'playwright')
        {
            actual[field].browserCatalogDigest = `sha256:${'d'.repeat(64)}`;
        }
        if (field === 'rendering')
        {
            actual[field].fontSetDigest = `sha256:${'d'.repeat(64)}`;
        }
        actual.contentDigest = governanceContentDigest(actual);
        assert.throws(() => inspectVisualBrowserBinding(plan, actual), /planned\/actual mismatch/u);
    }
});

test('current observed rendering is required rather than a self-consistent browser identity alone', () =>
{
    const { plan, actual } = syntheticBrowser();
    actual.renderingObservation.locale = 'en-US';
    actual.contentDigest = governanceContentDigest(actual);
    assert.throws(() => inspectVisualBrowserBinding(plan, actual), /rendering observation mismatch/u);
});

test('fully resealed synthetic plan/actual still cannot replace actual managed policy/package/binary', () =>
{
    const { plan, actual } = syntheticBrowser();
    assert.throws(() => inspectVisualBrowserBinding(plan, actual));
});

test('actual canonical transport round-trip admits only origin/payload bytes, never a browser or producer', (t) =>
{
    const { options, outputPath, payloadPath } = fixture(t);
    const reference = JSON.parse(readFileSync(join(options.repositoryRoot, outputPath), 'utf8'));
    const packed = packCurrentRunEvidenceTransport({ context: options.context, repositoryRoot: options.repositoryRoot,
        archivePath: 'artifacts/current-run/synthetic-archive.json', manifestPath: 'artifacts/current-run/synthetic-manifest.json',
        transportRunId: 'synthetic-transport', downloadRunId: 'synthetic-download', objects: [{ authorityId: entry.authorityId,
            producerId: entry.producerId, receiptSchema: entry.receiptSchema, originalRef: { path: outputPath, contentDigest: reference.contentDigest, producerReceiptDigest: reference.producerReceiptDigest },
            files: [{ path: outputPath, role: 'reference-receipt' }, { path: payloadPath, role: 'payload' }] }] });
    rmSync(join(options.repositoryRoot, outputPath));
    rmSync(join(options.repositoryRoot, payloadPath));
    extractCurrentRunEvidenceTransport({ repositoryRoot: options.repositoryRoot,
        manifestPath: 'artifacts/current-run/synthetic-manifest.json', expectedManifestDigest: packed.manifest.contentDigest });
    options.visualOrigin.transportManifestPath = 'artifacts/current-run/synthetic-manifest.json';
    options.visualOrigin.expectedManifestDigest = packed.manifest.contentDigest;
    assert.throws(() => inspectVisualProducerAdmission(options), { code: 'visual-admission-browser-origin-required' });
    writeFileSync(join(options.repositoryRoot, payloadPath), '{"fixtureClass":"synthetic-transport-tamper"}');
    assert.throws(() => inspectVisualProducerAdmission(options), /payload reference digest mismatch/u);
});


test('browser origin cannot borrow a separately sealed scheduler run from the visual origin', (t) =>
{
    const { options } = fixture(t);
    const registered = JSON.parse(registryBytes).entries.find(({ consumerId }) => consumerId === 'evidence-consumer.workflow.browser-diagnostics');
    const context = structuredClone(options.context);
    context.schedulerRunId = 'synthetic-other-browser-run';
    sealContext(context);
    const outputPath = 'artifacts/current-run/synthetic-cross-run-browser-reference.json';
    const payloadPath = 'artifacts/current-run/synthetic-cross-run-browser-payload.json';
    const session = beginCurrentRunEvidencePublication({ authorityId: registered.authorityId,
        producerId: registered.producerId, repositoryRoot: options.repositoryRoot, context, outputPath, payloadPath });
    writeFileSync(join(options.repositoryRoot, payloadPath), JSON.stringify(syntheticBrowser().actual));
    finalizeCurrentRunEvidencePublication({ authorityId: registered.authorityId, producerId: registered.producerId,
        repositoryRoot: options.repositoryRoot, context, outputPath, payloadPath,
        payloadSchema: 'fsusblog.playwright-browser-actual.v1', sessionId: session.sessionId, terminalStatus: 'success' });
    options.browserOrigin = { consumerId: registered.consumerId, reference: { path: outputPath,
        objectDigest: `sha256:${visualArtifactDigest(readFileSync(join(options.repositoryRoot, outputPath)))}` } };
    options.browserPlan = syntheticBrowser().plan;
    assert.throws(() => inspectVisualProducerAdmission(options), /evidence schedulerRunId mismatch/u);
});

test('loaded synthetic consumer rejects byte drift and fresh package export owner redirection', async (t) =>
{
    // Relocated snapshot model only: real imports continue to target canonical
    // modules. Temporary authority copies are never a production registry/API.
    const root = mkdtempSync(join(tmpdir(), 'synthetic-admission-snapshot-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const identity = visualProducerAdmissionIdentity();
    for (const path of Object.keys(identity.dependencyDigests))
    {
        const destination = join(root, path);
        mkdirSync(join(destination, '..'), { recursive: true });
        writeFileSync(destination, readFileSync(join(canonicalRoot, path)));
    }
    // Real static bare imports resolve through this disposable package graph;
    // only Ajv's existing locked installation is shared read-only.
    const packageLinks = join(root, 'tests/frontend/node_modules/@fsusblog');
    mkdirSync(packageLinks, { recursive: true });
    symlinkSync(root, join(packageLinks, 'layout-governance'), 'dir');
    symlinkSync(join(canonicalRoot, 'tools/test-matrix/schema-validator/node_modules'),
        join(root, 'tools/test-matrix/schema-validator/node_modules'), 'dir');
    const source = readFileSync(join(canonicalRoot, 'tests/frontend/support/layout/visualProducerAdmission.mjs'), 'utf8');
    const moduleFile = join(root, 'tests/frontend/support/layout/visualProducerAdmission.mjs');
    mkdirSync(join(moduleFile, '..'), { recursive: true });
    writeFileSync(moduleFile, source);
    const loaded = await import(pathToFileURL(moduleFile).href);
    loaded.visualProducerAdmissionIdentity();
    for (const path of ['tests/frontend/support/layout/visualProducerAdmission.mjs',
        'config/schemas/layout-visual-adjudication.schema.json', 'config/testing/playwright-browser-identity-policy.json', 'package.json'])
    {
        const target = join(root, path);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
        assert.throws(() => loaded.visualProducerAdmissionIdentity(), { code: 'visual-admission-version-drift' });
        writeFileSync(target, original);
    }
    const packageFile = join(root, 'package.json');
    const packageDocument = JSON.parse(readFileSync(packageFile, 'utf8'));
    packageDocument.exports['./evidence-locator'] = './tools/test/synthetic-redirected-locator.mjs';
    writeFileSync(join(root, 'tools/test/synthetic-redirected-locator.mjs'),
        readFileSync(join(root, 'tools/test/current-run-evidence-locator.mjs')));
    writeFileSync(packageFile, JSON.stringify(packageDocument));
    const script = `import {visualProducerAdmissionIdentity} from ${JSON.stringify(pathToFileURL(moduleFile).href)};
        try {visualProducerAdmissionIdentity();process.exitCode=1;}
        catch(error){console.log(error.code);process.exitCode=error.code==='visual-admission-module-owner-mismatch'?0:1;}`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /visual-admission-module-owner-mismatch/u);

});
