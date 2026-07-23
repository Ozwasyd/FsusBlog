import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports
import { verifyPublicPreviewRuntimeIdentity } from '../../tools/docs/public-preview-runtime-identity.mjs';

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
        ['debug-frontend', 'dev-server.pid', 4102]
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

test('formal capture verifies both runtime processes against the current source identity', () =>
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
        assert.deepEqual(Object.keys(result).sort(), ['backend', 'debug-frontend']);
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
    const runner = fs.readFileSync(path.join(root, 'tools/docs/run-public-preview-capture.sh'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const acceptanceShared = fs.readFileSync(
        path.join(root, 'tests/frontend/support/playwright/acceptance-shared.ts'),
        'utf8'
    );
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    assert.match(specification, /manual screenshot shards cannot write docs assets/u);
    assert.match(specification, /public-preview docs capture requires the complete unfiltered registry/u);
    assert.match(runner, /public-preview-docs\.lock/u);
    assert.ok(
        runner.indexOf('trap Cleanup EXIT INT TERM') > runner.indexOf('if ! mkdir "$LOCK_DIR"'),
        'cleanup trap must only be armed after this writer owns the lock'
    );
    assert.match(runner, /ROOT_DIR=.*\ncd "\$ROOT_DIR"/u);
    assert.doesNotMatch(runner, /source "\$ENV_FILE"/u);
    assert.match(runner, /export "\$key=\$value"/u);
    assert.match(runner, /snapshotGitWorktree/u);
    assert.match(runner, /FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1/u);
    assert.match(runner, /FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=1/u);
    assert.match(bootstrap, /PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS=1800000/u);
    assert.match(bootstrap, /PUBLIC_PREVIEW_DOCS_CAPTURE:-0\}" == "1"[\s\S]*?PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS/u);
    assert.match(runner, /FSUSBLOG_PHYSICAL_BUNDLE_ID=standalone/u);
    assert.match(runner, /FSUSBLOG_STEP_ID=bootstrap/u);
    assert.match(runner, /node_modules\/\.bin\/\$executable/u);
    assert.match(runner, /public-preview-runtime-identity\.mjs/u);
    assert.match(runner, /FSUSBLOG_MANUAL_SCREENSHOT_DIR="\$WORK_DIR\/manual"/u);
    assert.match(runner, /status == 0 && cleanupStatus != 0/u);
    assert.match(runner, /public-preview-screenshots\.mjs" publish/u);
    assert.match(runner, /cleanupLocalRuntime/u);
    const prewarm = acceptanceShared.slice(
        acceptanceShared.indexOf('export async function prewarmDevRuntime'),
        acceptanceShared.indexOf('export async function captureStorageState')
    );
    assert.doesNotMatch(prewarm, /page\.reload/u);
    assert.match(prewarm, /await session\.close\(\)[\s\S]*?session = await openAuditedPage\(browser\)[\s\S]*?await warm\(\)/u);
    assert.match(matrix, /id: browser-contract[\s\S]*?public-preview-screenshots\.json/u);
    assert.match(matrix, /id: release-final[\s\S]*?browser-contract/u);
});
