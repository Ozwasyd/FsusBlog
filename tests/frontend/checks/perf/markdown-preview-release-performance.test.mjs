import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Contract fixtures use the real production receipt producer.
import { createProductionBuildReceipt } from '../../../../tools/ci/production-build-artifacts.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Fixtures use the same canonical worktree fingerprint producer as the runner.
import { resolveWorktreeFingerprint } from '../../../../tools/fact-extractors/identity.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Contract test reads the canonical test matrix.
import { parseMatrix } from '../../../../tools/test-matrix/parse-matrix.mjs';

import {
    comparePairedSamples,
    contentDigest,
    currentMachineIdentity,
    evidenceSchema,
    fileDigest,
    loadCorpus,
    loadSideManifest,
    pairedSchedule,
    retainedSampleCount,
    runPairedMeasurements,
    sealMeasurementEvidence,
    sideManifestSchema,
    thresholds,
    verifyNavigationResponseIdentity
} from './markdown-preview-release-performance.mjs';
import {
    sealSideManifest,
    sideDeclarationSchema
} from './seal-markdown-preview-release-side.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const runnerFile = path.join(here, 'markdown-preview-release-performance.mjs');
const laneFile = path.join(root, 'tools/test/lanes/markdown-preview-release-performance.sh');
const laneSource = fs.readFileSync(laneFile, 'utf8');
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const corpus = loadCorpus();
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fingerprint = value => `sha256:${value.repeat(64)}`;

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function domainDigest(receipt, name)
{
    const domain = receipt.domains.find(item => item.name === name);
    const records = receipt.artifacts
        .filter(item => item.path === domain.path || item.path.startsWith(`${domain.path}/`))
        .map(item => ({ path: item.path, size: item.size, sha256: item.sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path));
    return digest(JSON.stringify(records));
}

function artifactDigest(receipt, artifactPath)
{
    return receipt.artifacts.find(item => item.path === artifactPath).sha256;
}

function git(cwd, args)
{
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function createSideFixture(side, {
    profile = 'production-release-fresh',
    manifestSide = side,
    staticPort = side === 'base' ? 4171 : 4172,
    backendPort = side === 'base' ? 5171 : 5172
} = {})
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-markdown-side-${side}-`));
    const sourceRoot = path.join(temporaryRoot, 'source');
    const artifactRoot = path.join(temporaryRoot, 'artifacts');
    const fixtureRoot = path.join(temporaryRoot, 'fixture');
    fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'src/input.txt'), `${side}\n`);
    git(sourceRoot, ['init', '--quiet']);
    git(sourceRoot, ['add', 'src/input.txt']);
    git(sourceRoot, [
        '-c',
        'user.name=FsusBlog Contract',
        '-c',
        'user.email=contract@example.invalid',
        'commit',
        '--quiet',
        '-m',
        `${side} fixture`
    ]);
    fs.mkdirSync(path.join(artifactRoot, 'frontend-dist/server'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'backend-runtime'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'frontend-dist/index.html'), `<html>${side}</html>`);
    fs.writeFileSync(
        path.join(artifactRoot, 'frontend-dist/server/public-ssr.mjs'),
        'export const fixture = true;\n'
    );
    fs.writeFileSync(path.join(artifactRoot, 'backend-runtime/server.dll'), side);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const storageState = path.join(fixtureRoot, 'admin-storage-state.json');
    writeJson(storageState, { cookies: [], origins: [] });

    const sourceState = {
        commit: git(sourceRoot, ['rev-parse', 'HEAD']),
        worktreeFingerprint: `sha256:${resolveWorktreeFingerprint(sourceRoot)}`
    };
    const releaseId = `20260730000000-${sourceState.commit.slice(0, 12)}`;
    const sourceTree = git(sourceRoot, ['rev-parse', `${sourceState.commit}^{tree}`]);
    const toolchain = {
        node: process.version,
        npm: 'fixture-npm',
        dotnet: '10.0.100',
        vite: '7.0.0',
        vitest: '4.0.0',
        playwright: '1.55.0',
        emsdk: '4.0.0'
    };
    const receipt = createProductionBuildReceipt({
        root: sourceRoot,
        artifactRoot,
        sourceState,
        producer: {
            runId: `${side}-run`,
            runAttempt: 1,
            job: 'release-performance-fixture'
        },
        toolchain,
        inputPaths: ['src'],
        domains: [
            { name: 'frontend-dist', path: 'frontend-dist' },
            { name: 'backend-runtime', path: 'backend-runtime' }
        ],
        build: { profile }
    });
    const manifest = {
        schema: sideManifestSchema,
        side: manifestSide,
        source: {
            commit: sourceState.commit,
            tree: sourceTree,
            worktreeFingerprint: sourceState.worktreeFingerprint,
            repositoryRoot: sourceRoot,
            clean: true
        },
        productionBuild: {
            artifactRoot,
            receiptPath: 'receipt.json',
            receiptContentDigest: receipt.contentDigest
        },
        artifacts: {
            frontendDist: {
                path: 'frontend-dist',
                digest: domainDigest(receipt, 'frontend-dist')
            },
            ssrEntry: {
                path: 'frontend-dist/server/public-ssr.mjs',
                digest: artifactDigest(receipt, 'frontend-dist/server/public-ssr.mjs')
            },
            clientEntry: {
                path: 'frontend-dist/index.html',
                digest: artifactDigest(receipt, 'frontend-dist/index.html')
            }
        },
        runtime: {
            mode: 'Release',
            staticServerKind: 'immutable-release-static',
            backendKind: 'immutable-release-runtime',
            staticBaseUrl: `http://127.0.0.1:${staticPort}`,
            backendBaseUrl: `http://127.0.0.1:${backendPort}`,
            releaseId,
            buildIdentity: releaseId,
            routes: {
                article: '/article/release-performance',
                about: '/about',
                adminWrite: '/user/manage/article/write'
            },
            identityProbe: {
                url: `http://127.0.0.1:${backendPort}/api/binary/system/seo`,
                method: 'GET',
                status: 200,
                responseDigest: fingerprint(side === 'base' ? '3' : '4'),
                headers: { 'x-fsus-release-id': releaseId }
            }
        },
        fixture: {
            profile: 'acceptance-representative',
            identity: corpus.fixtureIdentity,
            namespace: 'markdown-preview-release-performance',
            topology: 'paired-release-runtime-v1',
            contentDigest: corpus.contentDigest,
            root: fixtureRoot,
            adminStorageState: {
                path: 'admin-storage-state.json',
                digest: fileDigest(storageState)
            }
        },
        machine: { ...currentMachineIdentity() },
        toolchain: {
            node: toolchain.node,
            playwright: toolchain.playwright,
            dotnet: toolchain.dotnet,
            browser: 'fixture-browser'
        },
        contentDigest: null
    };
    manifest.contentDigest = contentDigest(manifest);
    const manifestFile = path.join(temporaryRoot, `${side}.json`);
    writeJson(manifestFile, manifest);
    fs.chmodSync(manifestFile, 0o444);
    return {
        temporaryRoot,
        artifactRoot,
        sourceRoot,
        fixtureRoot,
        manifest,
        manifestFile,
        storageState,
        receipt
    };
}

function cleanup(...fixtures)
{
    for (const fixture of fixtures)
    {
        fs.chmodSync(fixture.artifactRoot, 0o700);
        for (const file of fs.readdirSync(fixture.artifactRoot, { recursive: true }))
        {
            const absolute = path.join(fixture.artifactRoot, file);
            if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile())
            {
                fs.chmodSync(absolute, 0o600);
            }
        }
        fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true });
    }
}

function rewriteManifest(fixture, mutate)
{
    fs.chmodSync(fixture.manifestFile, 0o600);
    mutate(fixture.manifest);
    fixture.manifest.contentDigest = contentDigest(fixture.manifest);
    writeJson(fixture.manifestFile, fixture.manifest);
    fs.chmodSync(fixture.manifestFile, 0o444);
}

function writeSideDeclaration(fixture, mutate = () =>
{})
{
    const manifest = fixture.manifest;
    const declaration = {
        schema: sideDeclarationSchema,
        side: manifest.side,
        sourceRoot: fixture.sourceRoot,
        productionBuild: { ...manifest.productionBuild },
        runtime: {
            mode: manifest.runtime.mode,
            staticServerKind: manifest.runtime.staticServerKind,
            backendKind: manifest.runtime.backendKind,
            staticBaseUrl: manifest.runtime.staticBaseUrl,
            backendBaseUrl: manifest.runtime.backendBaseUrl,
            releaseId: manifest.runtime.releaseId,
            buildIdentity: manifest.runtime.buildIdentity,
            routes: { ...manifest.runtime.routes },
            identityProbe: {
                url: manifest.runtime.identityProbe.url,
                status: manifest.runtime.identityProbe.status,
                headerNames: Object.keys(manifest.runtime.identityProbe.headers)
            }
        },
        fixture: {
            profile: manifest.fixture.profile,
            identity: manifest.fixture.identity,
            namespace: manifest.fixture.namespace,
            topology: manifest.fixture.topology,
            contentDigest: manifest.fixture.contentDigest,
            root: fixture.fixtureRoot,
            adminStorageStatePath: manifest.fixture.adminStorageState.path
        }
    };
    mutate(declaration);
    const declarationFile = path.join(fixture.temporaryRoot, 'side-declaration.json');
    writeJson(declarationFile, declaration);
    return { declaration, declarationFile };
}

function probeResponse(fixture, {
    status = fixture.manifest.runtime.identityProbe.status,
    headers = fixture.manifest.runtime.identityProbe.headers
} = {})
{
    return new Response(`${fixture.manifest.side}-identity`, {
        status,
        headers
    });
}

function syntheticRuntime(side)
{
    const isBase = side === 'base';
    const commitCharacter = isBase ? 'a' : 'b';
    return {
        staticBaseUrl: `http://127.0.0.1:${isBase ? 4171 : 4172}`,
        releaseId: `20260730000000-${commitCharacter.repeat(12)}`,
        routes: {
            article: '/article/release-performance',
            about: '/about',
            adminWrite: '/user/manage/article/write'
        }
    };
}

function navigationIdentities(runtime)
{
    const common = routeName => ({
        url: new URL(runtime.routes[routeName], runtime.staticBaseUrl).href,
        status: 200,
        releaseId: runtime.releaseId
    });
    return {
        article: {
            ...common('article'),
            frontendBuildIdentity: runtime.releaseId
        },
        about: {
            ...common('about'),
            frontendBuildIdentity: runtime.releaseId
        },
        adminWrite: common('adminWrite')
    };
}

function measuredSamples({
    base = { aot: 100, client: 200, preview: 300, bytes: 1000 },
    candidate = { aot: 102, client: 204, preview: 309, bytes: 1000 },
    runtimes = {
        base: syntheticRuntime('base'),
        candidate: syntheticRuntime('candidate')
    }
} = {})
{
    return pairedSchedule().map(entry =>
    {
        const values = entry.side === 'base' ? base : candidate;
        return {
            ...entry,
            startedAt: '2026-07-30T00:00:00.000Z',
            finishedAt: '2026-07-30T00:00:01.000Z',
            aotMs: values.aot,
            clientMs: values.client,
            previewMs: values.preview,
            previewResponseBytes: values.bytes,
            previewResponseIdentity: `preview:sha256:${entry.side === 'base' ? 'a' : 'b'.repeat(64)}`,
            domPreviewSourceIdentity: `preview:sha256:${entry.side === 'base' ? 'a' : 'b'.repeat(64)}`,
            domPreviewCompleteIdentity: `preview:sha256:${entry.side === 'base' ? 'a' : 'b'.repeat(64)}`,
            renderMarkdownIdentity: `markdown:${entry.side}`,
            activationMarkdownIdentity: `markdown:${entry.side}`,
            features: { table: true, code: true, latex: true, mermaid: true },
            navigationIdentities: navigationIdentities(runtimes[entry.side]),
            placeholderCount: 0,
            browserErrors: []
        };
    }).map(sample =>
    {
        const character = sample.side === 'base' ? 'a' : 'b';
        const identity = `preview:sha256:${character.repeat(64)}`;
        return {
            ...sample,
            previewResponseIdentity: identity,
            domPreviewSourceIdentity: identity,
            domPreviewCompleteIdentity: identity
        };
    });
}

function fakeSide(side)
{
    const isBase = side === 'base';
    const machine = currentMachineIdentity();
    return {
        side,
        manifestFile: `/${side}.json`,
        manifestFileDigest: fingerprint(isBase ? '6' : '7'),
        artifactRoot: `/${side}-artifacts`,
        sourceRoot: `/${side}-source`,
        receiptFile: `/${side}-artifacts/receipt.json`,
        receipt: {
            contentDigest: fingerprint(isBase ? '8' : '9'),
            build: { profile: 'production-release-fresh' }
        },
        receiptVerification: { status: 'success' },
        staticBaseUrl: `http://127.0.0.1:${isBase ? 4171 : 4172}`,
        backendBaseUrl: `http://127.0.0.1:${isBase ? 5171 : 5172}`,
        storageState: `/${side}-fixture/admin.json`,
        manifest: {
            source: { commit: (isBase ? 'a' : 'b').repeat(40) },
            artifacts: {},
            runtime: {
                ...syntheticRuntime(side),
                buildIdentity: syntheticRuntime(side).releaseId
            },
            fixture: {
                identity: corpus.fixtureIdentity,
                namespace: 'shared',
                topology: 'paired',
                contentDigest: corpus.contentDigest,
                profile: 'acceptance-representative',
                adminStorageState: {}
            },
            machine,
            toolchain: {
                node: process.version,
                playwright: 'fixture',
                dotnet: 'fixture',
                browser: 'fixture'
            }
        }
    };
}

test('canonical corpus owns all required Markdown and hostile features', () =>
{
    assert.equal(corpus.schema, 'fsusblog.markdown-preview-release-performance-corpus.v1');
    assert.match(corpus.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(corpus.preview.content, /```mermaid/u);
    assert.match(corpus.preview.content, /\$\$E = mc\^2\$\$/u);
    assert.match(corpus.preview.content, /<script>/u);
});

test('fixed lane owns explicit side inputs, stale-output cleanup, admission, and final sealing', () =>
{
    assert.equal(
        frontendPackage.scripts['check:markdown-preview-release-performance'],
        'bash ../../tools/test/lanes/markdown-preview-release-performance.sh'
    );
    assert.equal(
        frontendPackage.scripts['seal:markdown-preview-release-side'],
        'node ../../tests/frontend/checks/perf/seal-markdown-preview-release-side.mjs'
    );
    for (const token of [
        'FSUSBLOG_MARKDOWN_PREVIEW_BASE_MANIFEST',
        'FSUSBLOG_MARKDOWN_PREVIEW_CANDIDATE_MANIFEST',
        '--window-id markdown-preview-release-performance',
        '--product-evidence "$RAW_MEASUREMENT"',
        '--seal-evidence',
        '--noise-receipt "$NOISE_RECEIPT"'
    ])
    {
        assert.ok(laneSource.includes(token), `performance lane is missing ${token}`);
    }
    const cleanup = 'rm -f -- "$RAW_MEASUREMENT" "$NOISE_RECEIPT" "$FINAL_EVIDENCE"';
    assert.ok(laneSource.includes(cleanup));
    assert.ok(laneSource.indexOf(cleanup) < laneSource.indexOf('performance-admission.mjs'));
    assert.doesNotMatch(laneSource, /rm\s+-rf|git\s+(?:checkout|switch)|npm\s+run\s+build|latest/iu);

    const tier = matrix.tiers.find(entry => entry.id === 'markdown-preview-release-performance');
    assert.ok(tier);
    assert.equal(tier.command, 'tools/test/lanes/markdown-preview-release-performance.sh');
    assert.equal(tier.parallelizable, false);
    assert.equal(tier.maxParallel, 1);
    assert.equal(tier.shardable, false);
    assert.equal(tier.requiresPlaywright, 'chromium');
    assert.equal(tier.evidenceClass, 'diagnostic');
    assert.equal(tier.cadence, 'release-manual');
    assert.equal(tier.requiredFor, 'none');
    assert.equal(tier.ciJob, 'browser-diagnostics');
    assert.equal(tier.manualOnly, true);
    assert.equal(tier.retentionClass, 'conditional');
    assert.deepEqual(
        tier.exclusiveResources,
        ['benchmark-window', 'performance-counters', 'playwright-session']
    );
});

test('production side verifier accepts distinct immutable Release artifacts', () =>
{
    const baseFixture = createSideFixture('base');
    const candidateFixture = createSideFixture('candidate');
    try
    {
        assert.equal(loadSideManifest(baseFixture.manifestFile, 'base').side, 'base');
        assert.equal(
            loadSideManifest(candidateFixture.manifestFile, 'candidate').side,
            'candidate'
        );
    }
    finally
    {
        cleanup(baseFixture, candidateFixture);
    }
});

test('canonical side producer derives source, artifact, probe, storage, machine, and browser authority', async () =>
{
    const fixture = createSideFixture('base');
    const { declarationFile } = writeSideDeclaration(fixture);
    const outputFile = path.join(fixture.temporaryRoot, 'sealed-base-side.json');
    try
    {
        const sealed = await sealSideManifest({
            declarationFile,
            outputFile,
            fetchImpl: async () => probeResponse(fixture),
            resolveBrowserVersion: async () => fixture.manifest.toolchain.browser
        });
        assert.equal(sealed.manifest.source.commit, fixture.manifest.source.commit);
        assert.equal(sealed.manifest.source.tree, fixture.manifest.source.tree);
        assert.equal(
            sealed.manifest.source.worktreeFingerprint,
            fixture.receipt.sourceState.worktreeFingerprint
        );
        assert.equal(sealed.manifest.artifacts.frontendDist.path, 'frontend-dist');
        assert.equal(sealed.manifest.runtime.buildIdentity, sealed.manifest.runtime.releaseId);
        assert.equal(
            sealed.manifest.runtime.identityProbe.headers['x-fsus-release-id'],
            sealed.manifest.runtime.releaseId
        );
        assert.equal(Object.hasOwn(sealed.manifest.runtime, 'imageDigest'), false);
        assert.deepEqual(
            Object.keys(sealed.manifest.fixture.adminStorageState).sort(),
            ['digest', 'path']
        );
        assert.equal(sealed.manifest.machine.identityDigest, currentMachineIdentity().identityDigest);
        assert.equal(sealed.manifest.toolchain.browser, 'fixture-browser');
        assert.equal(fs.lstatSync(outputFile).mode & 0o222, 0);
        assert.equal(loadSideManifest(outputFile, 'base').manifestFile, outputFile);
    }
    finally
    {
        cleanup(fixture);
    }
});

test('canonical side producer rejects manual identities, dirty source, unsafe probe, and overwrite', async t =>
{
    for (const [name, mutate, runOptions, pattern] of [
        [
            'manual source identity field',
            declaration =>
            {
                declaration.commit = 'a'.repeat(40);
            },
            {},
            /exact schema mismatch/u
        ],
        [
            'manual image digest without authority',
            declaration =>
            {
                declaration.runtime.imageDigest = fingerprint('d');
            },
            {},
            /exact schema mismatch/u
        ],
        [
            'release commit mismatch',
            declaration =>
            {
                declaration.runtime.releaseId = `20260730000000-${'f'.repeat(12)}`;
            },
            {},
            /commit prefix/u
        ],
        [
            'build identity mismatch',
            declaration =>
            {
                declaration.runtime.buildIdentity = 'wrong-release';
            },
            {},
            /buildIdentity must equal/u
        ],
        [
            'missing release probe header',
            declaration =>
            {
                declaration.runtime.identityProbe.headerNames = ['x-fsus-build-identity'];
            },
            {},
            /must include x-fsus-release-id/u
        ],
        [
            'unsafe probe header',
            declaration =>
            {
                declaration.runtime.identityProbe.headerNames = ['cookie'];
            },
            {},
            /non-identity header/u
        ],
        [
            'live probe from wrong Release',
            () =>
            {},
            {
                responseHeaders: {
                    'x-fsus-release-id': `20260730000000-${'f'.repeat(12)}`
                }
            },
            /does not match runtime.releaseId/u
        ],
        [
            'probe status drift',
            () =>
            {},
            { responseStatus: 503 },
            /status mismatch/u
        ],
        [
            'dirty source',
            () =>
            {},
            { dirtySource: true },
            /source checkout must be clean/u
        ],
        [
            'existing output',
            () =>
            {},
            { existingOutput: true },
            /output already exists/u
        ]
    ])
    {
        await t.test(name, async () =>
        {
            const fixture = createSideFixture('base');
            const { declarationFile } = writeSideDeclaration(fixture, mutate);
            const outputFile = path.join(fixture.temporaryRoot, 'sealed-base-side.json');
            if (runOptions.dirtySource)
            {
                fs.writeFileSync(path.join(fixture.sourceRoot, 'untracked.txt'), 'dirty\n');
            }
            if (runOptions.existingOutput)
            {
                fs.writeFileSync(outputFile, 'occupied\n');
            }
            try
            {
                await assert.rejects(sealSideManifest({
                    declarationFile,
                    outputFile,
                    fetchImpl: async () => probeResponse(fixture, {
                        status: runOptions.responseStatus,
                        headers: runOptions.responseHeaders
                    }),
                    resolveBrowserVersion: async () => fixture.manifest.toolchain.browser
                }), pattern);
            }
            finally
            {
                cleanup(fixture);
            }
        });
    }
});

test('navigation identity verifier rejects a wrong Release response and wrong static public boot', async () =>
{
    const runtime = syntheticRuntime('base');
    const expectedUrl = new URL(runtime.routes.article, runtime.staticBaseUrl).href;
    const response = ({ headerReleaseId, frontendBuildIdentity }) => ({
        url: () => expectedUrl,
        status: () => 200,
        headers: () => ({ 'x-fsus-release-id': headerReleaseId }),
        text: async () =>
            '<!doctype html><script id="fsus-public-boot-config" type="application/json">'
            + JSON.stringify({
                schema: 'fsusblog.public-boot-config.v1',
                frontendBuildIdentity
            })
            + '</script>'
    });
    const accepted = await verifyNavigationResponseIdentity({
        response: response({
            headerReleaseId: runtime.releaseId,
            frontendBuildIdentity: runtime.releaseId
        }),
        expectedUrl,
        expectedReleaseId: runtime.releaseId,
        requirePublicBootIdentity: true,
        label: 'fixture article'
    });
    assert.equal(accepted.releaseId, runtime.releaseId);
    assert.equal(accepted.frontendBuildIdentity, runtime.releaseId);

    await assert.rejects(verifyNavigationResponseIdentity({
        response: response({
            headerReleaseId: `20260730000000-${'f'.repeat(12)}`,
            frontendBuildIdentity: runtime.releaseId
        }),
        expectedUrl,
        expectedReleaseId: runtime.releaseId,
        requirePublicBootIdentity: true,
        label: 'wrong Release article'
    }), /x-fsus-release-id does not match/u);

    await assert.rejects(verifyNavigationResponseIdentity({
        response: response({
            headerReleaseId: runtime.releaseId,
            frontendBuildIdentity: `20260730000000-${'f'.repeat(12)}`
        }),
        expectedUrl,
        expectedReleaseId: runtime.releaseId,
        requirePublicBootIdentity: true,
        label: 'wrong static article'
    }), /frontendBuildIdentity does not match/u);
});

test('side verifier rejects immutable authority, schema, URL, secret, and artifact drift', async t =>
{
    await t.test('side-swap', () =>
    {
        const fixture = createSideFixture('base', { manifestSide: 'candidate' });
        try
        {
            assert.throws(() => loadSideManifest(fixture.manifestFile, 'base'), /side-swap/u);
        }
        finally
        {
            cleanup(fixture);
        }
    });
    await t.test('non-Release', () =>
    {
        const fixture = createSideFixture('base', { profile: 'development' });
        try
        {
            assert.throws(() => loadSideManifest(fixture.manifestFile, 'base'), /not Release/u);
        }
        finally
        {
            cleanup(fixture);
        }
    });
    await t.test('symlinked manifest', () =>
    {
        const fixture = createSideFixture('base');
        const link = path.join(fixture.temporaryRoot, 'link.json');
        fs.symlinkSync(fixture.manifestFile, link);
        try
        {
            assert.throws(() => loadSideManifest(link, 'base'), /symlink/u);
        }
        finally
        {
            cleanup(fixture);
        }
    });
    await t.test('writable manifest', () =>
    {
        const fixture = createSideFixture('base');
        fs.chmodSync(fixture.manifestFile, 0o600);
        try
        {
            assert.throws(() => loadSideManifest(fixture.manifestFile, 'base'), /sealed read-only/u);
        }
        finally
        {
            cleanup(fixture);
        }
    });
    await t.test('artifact digest drift', () =>
    {
        const fixture = createSideFixture('base');
        const artifact = path.join(fixture.artifactRoot, 'frontend-dist/index.html');
        fs.chmodSync(artifact, 0o600);
        fs.appendFileSync(artifact, 'tampered');
        try
        {
            assert.throws(() => loadSideManifest(fixture.manifestFile, 'base'), /artifact.*mismatch/u);
        }
        finally
        {
            cleanup(fixture);
        }
    });
    for (const [name, mutate, pattern] of [
        [
            'commit authority',
            manifest =>
            {
                manifest.source.commit = 'f'.repeat(40);
            },
            /commit|HEAD resolution/u
        ],
        [
            'tree authority',
            manifest =>
            {
                manifest.source.tree = 'f'.repeat(40);
            },
            /tree resolution|tree authority/u
        ],
        [
            'worktree fingerprint authority',
            manifest =>
            {
                manifest.source.worktreeFingerprint = fingerprint('f');
            },
            /canonical checkout fingerprint/u
        ],
        [
            'live machine authority',
            manifest =>
            {
                manifest.machine.hostname = 'drifted.invalid';
                manifest.machine.identityDigest = contentDigest(manifest.machine, 'identityDigest');
            },
            /live hostname drift/u
        ],
        [
            'base URL query',
            manifest =>
            {
                manifest.runtime.staticBaseUrl += '?credential=redacted';
            },
            /query or fragment/u
        ],
        [
            'release commit mismatch',
            manifest =>
            {
                manifest.runtime.releaseId = `20260730000000-${'f'.repeat(12)}`;
            },
            /commit prefix/u
        ],
        [
            'build identity mismatch',
            manifest =>
            {
                manifest.runtime.buildIdentity = 'wrong-release';
            },
            /buildIdentity must equal/u
        ],
        [
            'missing release identity header',
            manifest =>
            {
                manifest.runtime.identityProbe.headers = { 'x-fsus-build-identity': 'build' };
            },
            /must include x-fsus-release-id/u
        ],
        [
            'cross-origin route',
            manifest =>
            {
                manifest.runtime.routes.article = 'https://elsewhere.invalid/article';
            },
            /root-relative route/u
        ],
        [
            'sensitive identity header',
            manifest =>
            {
                manifest.runtime.identityProbe.headers.cookie = 'must-not-appear';
            },
            /not an allowed identity header/u
        ],
        [
            'unknown sensitive field',
            manifest =>
            {
                manifest.runtime.authorization = 'must-not-appear';
            },
            /exact schema mismatch/u
        ],
        [
            'inline storage state',
            manifest =>
            {
                manifest.fixture.adminStorageState.cookies = [];
            },
            /exact schema mismatch/u
        ]
    ])
    {
        await t.test(name, () =>
        {
            const fixture = createSideFixture('base');
            rewriteManifest(fixture, mutate);
            try
            {
                assert.throws(() => loadSideManifest(fixture.manifestFile, 'base'), pattern);
            }
            finally
            {
                cleanup(fixture);
            }
        });
    }
});

test('paired schedule contains one warmup and exactly five alternating retained samples per side', () =>
{
    const schedule = pairedSchedule();
    assert.equal(schedule.length, 12);
    for (const side of ['base', 'candidate'])
    {
        assert.equal(schedule.filter(item => item.side === side && item.phase === 'warmup').length, 1);
        assert.equal(schedule.filter(item => item.side === side && item.phase === 'retained').length, retainedSampleCount);
    }
    assert.deepEqual(
        schedule.slice(2).map(item => item.side),
        ['candidate', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate', 'candidate', 'base']
    );
});

test('comparator uses unrounded medians and enforces 2/2/3 percent plus byte no-growth', () =>
{
    const comparison = comparePairedSamples(measuredSamples());
    assert.equal(comparison.status, 'passed');
    assert.equal(comparison.ratios.aot, thresholds.aotRatio);
    assert.equal(comparison.ratios.client, thresholds.clientRatio);
    assert.equal(comparison.ratios.preview, thresholds.previewRatio);
    assert.equal(comparison.gates.previewResponseBytes.passed, true);
});

test('comparator rejects threshold, per-sample bytes, max bytes, zero, duplicate, and drop', async t =>
{
    await t.test('threshold', () =>
    {
        const result = comparePairedSamples(measuredSamples({
            candidate: { aot: 102.00001, client: 204, preview: 309, bytes: 1000 }
        }));
        assert.equal(result.status, 'failed');
        assert.equal(result.gates.aot.passed, false);
    });
    await t.test('bytes', () =>
    {
        const samples = measuredSamples();
        const target = samples.find(item =>
            item.side === 'candidate' && item.phase === 'retained' && item.sampleIndex === 3);
        target.previewResponseBytes += 1;
        const result = comparePairedSamples(samples);
        assert.equal(result.gates.previewResponseBytes.passed, false);
    });
    await t.test('zero', () =>
    {
        const samples = measuredSamples();
        samples.find(item => item.phase === 'retained').aotMs = 0;
        assert.throws(() => comparePairedSamples(samples), /zero\/NaN/u);
    });
    await t.test('drop', () =>
    {
        assert.throws(() => comparePairedSamples(measuredSamples().slice(0, -1)), /sample count/u);
    });
    await t.test('duplicate/order', () =>
    {
        const samples = measuredSamples();
        samples[3] = { ...samples[2], sequence: 3 };
        assert.throws(() => comparePairedSamples(samples), /order drift/u);
    });
});

test('paired runner rejects adapter side-swap without a fixture CLI mode', async () =>
{
    const base = fakeSide('base');
    const candidate = fakeSide('candidate');
    await assert.rejects(
        runPairedMeasurements({
            base,
            candidate,
            corpus,
            adapterFactory: async side => ({
                measure: async expected =>
                {
                    const sample = {
                        ...measuredSamples({
                            runtimes: {
                                base: base.manifest.runtime,
                                candidate: candidate.manifest.runtime
                            }
                        }).find(item =>
                            item.side === expected.side
                            && item.phase === expected.phase
                            && item.sampleIndex === expected.sampleIndex)
                    };
                    delete sample.sequence;
                    return {
                        ...sample,
                        side: side.side === 'base' ? 'candidate' : 'base'
                    };
                }
            })
        }),
        /side-swap/u
    );
    const cli = spawnSync(process.execPath, [runnerFile, '--fixture'], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /invalid|requires exactly/u);
});

test('evidence sealer independently recomputes the fixed paired gate and rejects evidence tampering', async t =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-markdown-evidence-'));
    const measurementFile = path.join(temporaryRoot, 'measurement.json');
    const noiseFile = path.join(temporaryRoot, 'noise.json');
    const outputFile = path.join(temporaryRoot, 'summary.json');
    const baseFixture = createSideFixture('base');
    const candidateFixture = createSideFixture('candidate');
    try
    {
        const base = loadSideManifest(baseFixture.manifestFile, 'base');
        const candidate = loadSideManifest(candidateFixture.manifestFile, 'candidate');
        const measurement = await runPairedMeasurements({
            base,
            candidate,
            corpus,
            toolchain: {
                node: process.version,
                playwright: base.manifest.toolchain.playwright,
                dotnet: base.manifest.toolchain.dotnet
            },
            adapterFactory: async side => ({
                identity: {
                    browserVersion: side.manifest.toolchain.browser,
                    runtimeProbe: {
                        url: side.manifest.runtime.identityProbe.url,
                        status: side.manifest.runtime.identityProbe.status,
                        responseBytes: 128,
                        responseDigest: side.manifest.runtime.identityProbe.responseDigest,
                        headers: side.manifest.runtime.identityProbe.headers
                    }
                },
                measure: async expected =>
                {
                    const sample = {
                        ...measuredSamples({
                            runtimes: {
                                base: base.manifest.runtime,
                                candidate: candidate.manifest.runtime
                            }
                        }).find(item =>
                            item.side === expected.side
                            && item.phase === expected.phase
                            && item.sampleIndex === expected.sampleIndex)
                    };
                    delete sample.sequence;
                    return sample;
                }
            })
        });
        const writeMeasurement = value =>
        {
            value.contentDigest = contentDigest(value);
            writeJson(measurementFile, value);
        };
        const writeNoiseReceipt = () => writeJson(noiseFile, {
            schema: 'fsusblog.measurement-noise-envelope.v1',
            windowId: 'markdown-preview-release-performance',
            qualificationEligible: true,
            classification: 'qualified',
            productOutcome: {
                productEvidence: {
                    digest: fileDigest(measurementFile)
                }
            }
        });
        writeMeasurement(measurement);
        writeNoiseReceipt();
        const evidence = sealMeasurementEvidence({
            measurementFile,
            noiseReceiptFile: noiseFile,
            outputFile
        });
        assert.equal(evidence.schema, evidenceSchema);
        assert.equal(evidence.samples.filter(item => item.phase === 'retained').length, 10);
        assert.equal(evidence.measurementNoise.qualificationEligible, true);
        assert.deepEqual(
            Object.keys(evidence.sides.base.fixture.adminStorageState).sort(),
            ['digest', 'path']
        );
        assert.doesNotMatch(JSON.stringify(evidence), /authorization|cookie|[?]secret/iu);

        for (const [name, mutate, pattern] of [
            [
                'forged status',
                value =>
                {
                    value.status = 'failed';
                },
                /status does not match/u
            ],
            [
                'forged comparison',
                value =>
                {
                    value.comparison.ratios.aot = 0.5;
                },
                /comparison does not match/u
            ],
            [
                'threshold drift',
                value =>
                {
                    value.thresholds.aotRatio = 1.5;
                },
                /thresholds drift/u
            ],
            [
                'schedule order drift',
                value =>
                {
                    [value.schedule[2], value.schedule[3]] = [value.schedule[3], value.schedule[2]];
                },
                /schedule drift/u
            ],
            [
                'dropped sample',
                value =>
                {
                    value.samples.pop();
                },
                /samples|sample count|object/u
            ],
            [
                'sample order drift',
                value =>
                {
                    [value.samples[2], value.samples[3]] = [value.samples[3], value.samples[2]];
                },
                /side-swap|phase mismatch|sample index mismatch/u
            ],
            [
                'runtime URL query',
                value =>
                {
                    value.runtimeIdentities.base.runtimeProbe.url += '?secret=must-not-appear';
                },
                /does not match|query or fragment/u
            ],
            [
                'wrong sampled navigation Release',
                value =>
                {
                    const wrongReleaseId = `20260730000000-${'f'.repeat(12)}`;
                    value.samples[0].navigationIdentities.article.releaseId = wrongReleaseId;
                    value.samples[0].navigationIdentities.article.frontendBuildIdentity =
                        wrongReleaseId;
                },
                /releaseId does not match the side release/u
            ],
            [
                'wrong sampled public boot identity',
                value =>
                {
                    value.samples[0].navigationIdentities.about.frontendBuildIdentity =
                        `20260730000000-${'f'.repeat(12)}`;
                },
                /frontendBuildIdentity does not match/u
            ],
            [
                'unknown sensitive side field',
                value =>
                {
                    value.sides.base.authorization = 'must-not-appear';
                },
                /exact schema mismatch|sensitive evidence/u
            ],
            [
                'inline storage state',
                value =>
                {
                    value.sides.base.fixture.adminStorageState.inline = { cookies: [] };
                },
                /exact schema mismatch/u
            ],
            [
                'browser error URL query',
                value =>
                {
                    value.samples[0].browserErrors = [
                        'requestfailed:GET:https://example.invalid/path?secret=must-not-appear:failed'
                    ];
                },
                /browser error detected/u
            ]
        ])
        {
            await t.test(name, () =>
            {
                const tampered = structuredClone(measurement);
                mutate(tampered);
                writeMeasurement(tampered);
                assert.throws(() => sealMeasurementEvidence({
                    measurementFile,
                    noiseReceiptFile: noiseFile,
                    outputFile
                }), pattern);
            });
        }
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        cleanup(baseFixture, candidateFixture);
    }
});
