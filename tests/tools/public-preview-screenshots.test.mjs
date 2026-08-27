import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/* eslint-disable import-x/no-relative-parent-imports */
import { verifyPublicPreviewRuntimeIdentity } from '../../tools/docs/public-preview-runtime-identity.mjs';
import {
    categoryDigest,
    combineVisualInputDigest,
    computeVisualInputs,
    validateFailClosedCoverage
} from '../../tools/docs/public-preview-screenshots.mjs';
import {
    acquireWriterLock,
    atomicPublishDirectory,
    releaseWriterLock
} from '../../tools/docs/public-preview-writer-transaction.mjs';
/* eslint-enable import-x/no-relative-parent-imports */

import {
    assertDeterministicPublicPreviewVerificationEvidence,
    assertReleaseFinalRequiresLocalPublicPreviewEvidence
} from './public-preview-release-evidence-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = path.join(root, 'tools/docs/public-preview-screenshots.mjs');
const sourceDirectory = path.join(root, 'docs/assets/screenshots');

test(
    'verification evidence is deterministic and excludes local or runtime-noise identities',
    assertDeterministicPublicPreviewVerificationEvidence
);

test(
    'release-final requires matching local public-preview evidence without a CI identity',
    assertReleaseFinalRequiresLocalPublicPreviewEvidence
);

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

function directorySnapshot(directory)
{
    const snapshot = new Map();
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            const absolute = path.join(current, entry.name);
            const relative = path.relative(directory, absolute);
            snapshot.set(relative, entry.isDirectory() ? 'directory' : fs.readFileSync(absolute).toString('hex'));
            if (entry.isDirectory())
            {
                visit(absolute);
            }
        }
    };
    visit(directory);
    return snapshot;
}

function publicationFixture()
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-publish-'));
    const managed = path.join(parent, 'screenshots');
    const stagingParent = path.join(parent, 'work');
    const staging = path.join(stagingParent, 'staging');
    fs.mkdirSync(managed);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(managed, 'manifest.json'), 'old manifest\n');
    fs.writeFileSync(path.join(managed, 'old.png'), 'old image\n');
    fs.writeFileSync(path.join(staging, 'manifest.json'), 'new manifest\n');
    fs.writeFileSync(path.join(staging, 'new.png'), 'new image\n');
    return { parent, managed, staging };
}

function validatePublicationFixture(directory)
{
    assert.equal(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'), 'new manifest\n');
    assert.equal(fs.readFileSync(path.join(directory, 'new.png'), 'utf8'), 'new image\n');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['manifest.json', 'new.png']);
}

function runtimeIdentityFixture()
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-runtime-'));
    const namespace = 'public-preview-docs-test';
    const runtimeDirectory = path.join(fixtureRoot, '.tmp/acceptance', namespace);
    const expectedSourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const processes = new Map();
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    for (const [role, pidFile, pid] of [
        ['backend', 'backend.pid', 4101],
        ['debug-frontend', 'dev-server.pid', 4102],
        ['release-preview', 'preview.pid', 4103]
    ])
    {
        fs.writeFileSync(path.join(runtimeDirectory, pidFile), `${pid}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(runtimeDirectory, pidFile.replace(/\.pid$/u, '.identity.json')), `${JSON.stringify({
            schema: 'fsusblog.local-runtime-process-identity.v1',
            pid,
            processGroupId: pid,
            startTimeTicks: String(pid * 10),
            runId: namespace,
            namespace,
            role,
            preparationId: namespace,
            sourceState: expectedSourceState
        })}\n`, { mode: 0o600 });
        processes.set(pid, {
            pid,
            processGroupId: pid,
            sessionId: pid,
            startTimeTicks: String(pid * 10),
            environment: {
                FSUSBLOG_TEST_SOURCE_COMMIT: expectedSourceState.commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: expectedSourceState.worktreeFingerprint,
                FSUSBLOG_TEST_NAMESPACE: namespace,
                FSUSBLOG_RUNTIME_ROLE: role
            }
        });
    }
    return { fixtureRoot, namespace, expectedSourceState, processes };
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
        fs.writeFileSync(path.join(directory, 'capture.tmp'), 'partial publication');
        result = check(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unexpected managed screenshot entry: capture\.tmp/u);

        fs.rmSync(path.join(directory, 'capture.tmp'));
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

test('atomic publisher replaces the complete gallery and prunes only global-registry leftovers', () =>
{
    const current = publicationFixture();
    try
    {
        atomicPublishDirectory({
            stagingDirectory: current.staging,
            managedDirectory: current.managed,
            validate: validatePublicationFixture,
            transactionId: 'success'
        });
        validatePublicationFixture(current.managed);
        assert.ok(!fs.existsSync(current.staging));
        assert.deepEqual(
            fs.readdirSync(current.parent).filter((entry) => entry.startsWith('.screenshots-backup-')),
            []
        );
    }
    finally
    {
        fs.rmSync(current.parent, { recursive: true, force: true });
    }
});

test('atomic publisher preserves the old gallery byte-for-byte when validation or replacement fails', () =>
{
    for (const failure of ['validation', 'replacement', 'backup-removal'])
    {
        const current = publicationFixture();
        const original = directorySnapshot(current.managed);
        let renameCount = 0;
        const fileSystem = Object.create(fs);
        fileSystem.renameSync = (...args) =>
        {
            renameCount++;
            if (failure === 'replacement' && renameCount === 2)
            {
                const error = new Error('simulated replacement failure');
                error.code = 'EIO';
                throw error;
            }
            return fs.renameSync(...args);
        };
        fileSystem.rmSync = (...args) =>
        {
            if (failure === 'backup-removal' && String(args[0]).includes('.screenshots-backup-'))
            {
                const error = new Error('simulated backup cleanup failure');
                error.code = 'EIO';
                throw error;
            }
            return fs.rmSync(...args);
        };
        try
        {
            assert.throws(() => atomicPublishDirectory({
                stagingDirectory: current.staging,
                managedDirectory: current.managed,
                validate: failure === 'validation'
                    ? () =>
                    {
                        throw new Error('simulated validation failure');
                    }
                    : validatePublicationFixture,
                fileSystem,
                transactionId: failure
            }), /simulated/u);
            assert.deepEqual(directorySnapshot(current.managed), original, `${failure} must preserve the old gallery`);
            assert.deepEqual(
                fs.readdirSync(current.parent).filter((entry) => entry.startsWith('.screenshots-backup-')),
                [],
                `${failure} must not leave a backup directory`
            );
        }
        finally
        {
            fs.rmSync(current.parent, { recursive: true, force: true });
        }
    }
});

test('docs writer lock rejects a concurrent owner and only the owner can release it', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-lock-'));
    const lock = path.join(directory, 'public-preview-docs.lock');
    const first = { namespace: 'writer-first', pid: 4101 };
    const second = { namespace: 'writer-second', pid: 4102 };
    try
    {
        acquireWriterLock(lock, first);
        assert.throws(() => acquireWriterLock(lock, second), /another docs writer owns.*writer-first pid=4101/u);
        assert.throws(() => releaseWriterLock(lock, second), /refusing to release.*writer-first pid=4101/u);
        releaseWriterLock(lock, first);
        assert.ok(!fs.existsSync(lock));
        acquireWriterLock(lock, second);
        releaseWriterLock(lock, second);
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

test('visual input projections ignore non-visual scripts but bind dependencies and capture sources', () =>
{
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-visual-input-first-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-visual-input-second-'));
    const projection = [{
        path: 'package.json',
        jsonKeys: ['dependencies', 'devDependencies', 'overrides']
    }];
    const packageDocument = {
        scripts: { unrelated: 'node unrelated.mjs' },
        dependencies: { vue: '3.5.32' },
        devDependencies: { vite: '8.0.16' },
        overrides: { vue: '3.5.32' }
    };
    try
    {
        for (const directory of [firstRoot, secondRoot])
        {
            fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(packageDocument)}\n`);
            fs.writeFileSync(path.join(directory, 'capture.ts'), 'export const viewport = 1365\n');
        }
        const baseline = categoryDigest(projection, firstRoot).digest;
        assert.equal(categoryDigest(projection, secondRoot).digest, baseline);

        fs.writeFileSync(path.join(firstRoot, 'package.json'), `${JSON.stringify({
            ...packageDocument,
            scripts: { unrelated: 'node changed-but-still-unrelated.mjs' }
        })}\n`);
        assert.equal(categoryDigest(projection, firstRoot).digest, baseline);

        fs.writeFileSync(path.join(firstRoot, 'package.json'), `${JSON.stringify({
            ...packageDocument,
            dependencies: { vue: '3.5.33' }
        })}\n`);
        assert.notEqual(categoryDigest(projection, firstRoot).digest, baseline);

        const captureBaseline = categoryDigest(['capture.ts'], secondRoot).digest;
        fs.writeFileSync(path.join(secondRoot, 'capture.ts'), 'export const viewport = 390\n');
        assert.notEqual(categoryDigest(['capture.ts'], secondRoot).digest, captureBaseline);
        assert.throws(
            () => categoryDigest([{ path: 'package.json', jsonKeys: ['scripts', 'dependencies'] }], secondRoot),
            /sorted unique jsonKeys/u
        );
    }
    finally
    {
        fs.rmSync(firstRoot, { recursive: true, force: true });
        fs.rmSync(secondRoot, { recursive: true, force: true });
    }
});

test('fail-closed roots reject a new unclassified shared visual directory', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-visual-coverage-'));
    const registry = {
        visualInputs: { visualSystem: ['src/known'] },
        failClosedRoots: [{ path: 'src', excludedEntries: [] }]
    };
    try
    {
        fs.mkdirSync(path.join(directory, 'src/known'), { recursive: true });
        fs.mkdirSync(path.join(directory, 'src/new-shared'), { recursive: true });
        assert.throws(
            () => validateFailClosedCoverage(registry, directory),
            /unclassified shared visual input: src\/new-shared/u
        );
        registry.visualInputs.sharedFrontend = ['src/new-shared'];
        assert.doesNotThrow(() => validateFailClosedCoverage(registry, directory));
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('registry covers visible authorities and binds the resolved FsusUI identity', () =>
{
    const inputs = computeVisualInputs();
    const files = new Set(Object.values(inputs.categories).flatMap((category) => category.files));
    for (const expected of [
        'src/frontend/package-lock.json',
        'src/frontend/vite.config.ts',
        'src/frontend/src/assets/main.css',
        'src/frontend/src/bootstrap/fontPreparationPort.ts',
        'src/frontend/src/components/public/PublicComplianceFooter.vue',
        'src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue',
        'src/frontend/src/ui-tokens/themeTokens.ts',
        'tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts',
        'tools/test-fixtures/producers/public-content-producer.mjs'
    ])
    {
        assert.ok(files.has(expected), `visual input registry must cover ${expected}`);
    }
    const changedFsusUi = { ...inputs.fsusUi, commit: 'f'.repeat(40) };
    assert.notEqual(combineVisualInputDigest(inputs.categories, changedFsusUi), inputs.visualInputDigest);
});

test('formal capture verifies every browser and fixture runtime against the current source identity', () =>
{
    const runtime = runtimeIdentityFixture();
    try
    {
        const result = verifyPublicPreviewRuntimeIdentity({
            root: runtime.fixtureRoot,
            namespace: runtime.namespace,
            expectedSourceState: runtime.expectedSourceState,
            observeProcess: (pid) => runtime.processes.get(pid)
        });
        assert.deepEqual(Object.keys(result).sort(), ['backend', 'debug-frontend', 'release-preview']);
    }
    finally
    {
        fs.rmSync(runtime.fixtureRoot, { recursive: true, force: true });
    }
});

test('formal capture fails closed on sidecar or live process source drift', () =>
{
    const runtime = runtimeIdentityFixture();
    try
    {
        const frontendIdentity = path.join(
            runtime.fixtureRoot,
            '.tmp/acceptance',
            runtime.namespace,
            'dev-server.identity.json'
        );
        const identity = JSON.parse(fs.readFileSync(frontendIdentity, 'utf8'));
        identity.sourceState.commit = 'c'.repeat(40);
        fs.writeFileSync(frontendIdentity, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
        assert.throws(() => verifyPublicPreviewRuntimeIdentity({
            root: runtime.fixtureRoot,
            namespace: runtime.namespace,
            expectedSourceState: runtime.expectedSourceState,
            observeProcess: (pid) => runtime.processes.get(pid)
        }), /debug-frontend runtime source identity mismatch: expected=.*actual=/u);

        identity.sourceState.commit = runtime.expectedSourceState.commit;
        fs.writeFileSync(frontendIdentity, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
        runtime.processes.get(4101).environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT = 'd'.repeat(64);
        assert.throws(() => verifyPublicPreviewRuntimeIdentity({
            root: runtime.fixtureRoot,
            namespace: runtime.namespace,
            expectedSourceState: runtime.expectedSourceState,
            observeProcess: (pid) => runtime.processes.get(pid)
        }), /backend runtime source identity mismatch/u);
    }
    finally
    {
        fs.rmSync(runtime.fixtureRoot, { recursive: true, force: true });
    }
});

test('capture contracts keep shards temporary and release verification explicit', () =>
{
    const specification = fs.readFileSync(
        path.join(root, 'tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts'),
        'utf8'
    );
    const manualConfiguration = fs.readFileSync(
        path.join(root, 'tests/frontend/support/playwright/manualScreenshotConfiguration.ts'),
        'utf8'
    );
    const runner = fs.readFileSync(path.join(root, 'tools/docs/run-public-preview-capture.sh'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const registry = JSON.parse(fs.readFileSync(
        path.join(root, 'config/docs/public-preview-screenshots.json'),
        'utf8'
    ));
    const acceptanceShared = fs.readFileSync(
        path.join(root, 'tests/frontend/support/playwright/acceptance-shared.ts'),
        'utf8'
    );
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const browserRunner = fs.readFileSync(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
    const browserGallery = fs.readFileSync(path.join(root, 'tests/browser-contract/public-preview-gallery.mjs'), 'utf8');
    const releaseFinal = fs.readFileSync(path.join(root, 'tools/release/check-release-final.mjs'), 'utf8');
    const releaseFinalDomainEvidence = fs.readFileSync(
        path.join(root, 'tools/release/release-final-domain-evidence.mjs'),
        'utf8'
    );
    const releaseEvidence = fs.readFileSync(path.join(root, 'tools/release/public-preview-release-evidence.mjs'), 'utf8');
    const captureBody = specification.slice(
        specification.indexOf('async function captureRouteScreenshot'),
        specification.indexOf('async function waitForManualRouteContentReady')
    );
    assert.match(specification, /manual screenshot shards cannot write docs assets/u);
    assert.match(specification, /public-preview docs capture requires the complete unfiltered registry/u);
    assert.equal(
        (captureBody.match(/normalizeDynamicEvidenceForScreenshot\(page\)/gu) ?? []).length,
        2,
        'final screenshot frame must be normalized again after the warm-up capture'
    );
    assert.match(
        captureBody,
        /await page\.screenshot\(screenshotOptions\)[\s\S]*?await normalizeDynamicEvidenceForScreenshot\(page\)[\s\S]*?const screenshot = await page\.screenshot\(screenshotOptions\)/u
    );
    assert.doesNotMatch(
        specification,
        /process\.cwd\(\).*config\/docs\/public-preview-screenshots/u
    );
    assert.match(
        specification,
        /for \(const route of routes\) \{[\s\S]*?openThemedAuditedPage[\s\S]*?finally \{[\s\S]*?session\.close\(\)/u
    );
    assert.match(
        acceptanceShared,
        /prewarmDevRuntime[\s\S]*?navigateThroughRetryablePublicAot[\s\S]*?deadlineAtMs[\s\S]*?waitForAppReady/u
    );
    assert.doesNotMatch(
        acceptanceShared,
        /\.style\.colorScheme/u,
        'capture setup must preserve production style-src-attr CSP'
    );
    assert.match(manualConfiguration, /FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME must match/u);
    assert.match(manualConfiguration, /public-preview docs staging path mismatch/u);
    assert.match(manualConfiguration, /public-preview docs writer lock identity mismatch/u);
    assert.match(runner, /public-preview-docs\.lock/u);
    assert.match(runner, /public-preview-writer-transaction\.mjs/u);
    assert.match(runner, /acquire-lock/u);
    assert.match(runner, /release-lock/u);
    assert.ok(
        runner.indexOf('trap Cleanup EXIT INT TERM') > runner.indexOf('acquire-lock "$LOCK_DIR"'),
        'cleanup trap must only be armed after this writer owns the lock'
    );
    assert.match(runner, /ROOT_DIR=.*\ncd "\$ROOT_DIR"/u);
    assert.doesNotMatch(runner, /source "\$ENV_FILE"/u);
    assert.match(runner, /export "\$key=\$value"/u);
    assert.match(runner, /snapshotGitWorktree/u);
    assert.match(runner, /FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=1/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_PREVIEW_WRITER_NAMESPACE="\$NAMESPACE"/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_PREVIEW_WRITER_PID="\$\$"/u);
    assert.match(runner, /FSUSBLOG_REPOSITORY_ROOT="\$ROOT_DIR"/u);
    assert.match(browserRunner, /createCorrectnessBrowserPlan/u);
    assert.match(browserRunner, /observeCorrectnessBrowser/u);
    assert.match(runner, /FSUSBLOG_BASE_URL="\$FSUSBLOG_RELEASE_PREVIEW_URL"/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_BASE_URL="\$FSUSBLOG_RELEASE_PREVIEW_URL"/u);
    assert.match(runner, /PLAYWRIGHT_BASE_URL="\$FSUSBLOG_RELEASE_PREVIEW_URL"/u);
    assert.doesNotMatch(runner, /=("\$FSUSBLOG_DEBUG_FRONTEND_URL")/u);
    assert.doesNotMatch(
        bootstrap,
        /-n "\$\{FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-\}" \|\|\s*"\$\{FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE:-0\}" == "1"/u
    );
    assert.match(runner, /loadTestMatrix/u);
    assert.match(runner, /sealMatrixFixtureProfile/u);
    assert.match(runner, /applySealedFixtureProfileEnvironment/u);
    assert.match(runner, /tiers\.find\(\(tier\) => tier\.id === 'bootstrap'\)/u);
    assert.doesNotMatch(runner, /FSUSBLOG_SEALED_FIXTURE_PROFILE_ID=acceptance-representative/u);
    assert.match(bootstrap, /PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS=1800000/u);
    assert.match(bootstrap, /PUBLIC_PREVIEW_DOCS_CAPTURE:-0\}" == "1"[\s\S]*?PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS/u);
    assert.match(runner, /FSUSBLOG_PHYSICAL_BUNDLE_ID=standalone/u);
    assert.match(runner, /FSUSBLOG_STEP_ID=bootstrap/u);
    assert.match(
        runner,
        /FSUSBLOG_STEP_ID=release-public-hydration\s+\\\s*"\$ROOT_DIR\/tools\/test\/lanes\/release-public-hydration\.sh"/u
    );
    const environmentIndex = runner.indexOf('done <"$ENV_FILE"');
    const hydrationIndex = runner.indexOf('FSUSBLOG_STEP_ID=release-public-hydration');
    const identityIndex = runner.indexOf('public-preview-runtime-identity.mjs');
    assert.ok(
        environmentIndex >= 0
        && environmentIndex < hydrationIndex
        && hydrationIndex < identityIndex,
        'docs writer must run the canonical release hydration producer after bootstrap and before preview readers'
    );
    assert.match(runner, /node_modules\/\.bin\/\$executable/u);
    assert.match(runner, /public-preview-runtime-identity\.mjs/u);
    assert.match(runner, /FSUSBLOG_MANUAL_SCREENSHOT_DIR="\$WORK_DIR\/manual"/u);
    assert.match(runner, /status == 0 && cleanupStatus != 0/u);
    assert.match(runner, /public-preview-screenshots\.mjs" publish/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=0/u);
    assert.match(runner, /\[\[ "\$MODE" == "manual" \]\]/u);
    assert.match(runner, /FSUSBLOG_PLAYWRIGHT_SERIAL_REASON=shared-screenshot-baseline-writer/u);
    assert.doesNotMatch(runner, /run capture:manual-layout-screenshots/u);
    const captureIndex = runner.indexOf('manual/manual-layout-screenshots.spec.ts');
    const generateIndex = runner.indexOf('public-preview-screenshots.mjs" generate');
    const checkIndex = runner.indexOf('public-preview-screenshots.mjs" check');
    const publishIndex = runner.indexOf('public-preview-screenshots.mjs" publish');
    assert.ok(
        captureIndex >= 0 && captureIndex < generateIndex && generateIndex < checkIndex && checkIndex < publishIndex,
        'docs writer must capture and validate the complete staging directory before atomic publication'
    );
    assert.match(runner, /cleanupLocalRuntime/u);
    assert.deepEqual(registry.capturePolicy, {
        animations: 'disabled',
        completeRegistry: true,
        language: 'C.UTF-8',
        layoutAudit: true,
        reducedMotion: 'reduce',
        runtimeAudit: true,
        timezone: 'UTC'
    });
    assert.ok(registry.visualInputs.capture.includes('tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts'));
    assert.ok(registry.visualInputs.capture.includes('tests/frontend/support/playwright'));
    assert.ok(!registry.visualInputs.capture.includes('tools/docs/public-preview-screenshots.mjs'));
    assert.ok(!registry.visualInputs.capture.includes('tools/docs/run-public-preview-capture.sh'));
    const prewarm = acceptanceShared.slice(
        acceptanceShared.indexOf('export async function prewarmDevRuntime'),
        acceptanceShared.indexOf('export async function captureStorageState')
    );
    assert.doesNotMatch(prewarm, /page\.reload/u);
    assert.match(prewarm, /await session\.close\(\)[\s\S]*?session = await openAuditedPage\(browser\)[\s\S]*?await warm\(\)/u);
    assert.match(matrix, /id: browser-contract[\s\S]*?public-preview-screenshots\.json/u);
    assert.match(matrix, /id: release-final[\s\S]*?browser-contract/u);
    assert.match(browserRunner, /receipt\.publicPreview = \{[\s\S]*?captureContextCount:[\s\S]*?evidenceFileDigest: sha256File/u);
    assert.doesNotMatch(browserGallery, /receipt\.topology\.contextCount/u);
    assert.match(releaseFinal, /createReleaseFinalDomainEvidence/u);
    assert.match(releaseFinalDomainEvidence, /requirePublicPreviewReleaseEvidence/u);
    assert.match(releaseEvidence, /public-preview screenshot evidence is required; release-final fails closed without local evidence/u);
    assert.match(releaseEvidence, /validatePublicPreviewEvidenceBinding/u);
    assert.match(releaseFinal, /public-preview commit=\$\{publicPreviewEvidence\.sourceCommit\} releaseId=\$\{publicPreviewEvidence\.releaseId\} images=/u);
});
