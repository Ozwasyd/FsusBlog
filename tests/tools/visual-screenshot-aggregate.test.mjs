import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const aggregateScript = path.join(repositoryRoot, 'tools/visual/aggregate-screenshot-evidence.mjs');

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-visual-aggregate-'));
    const script = path.join(root, 'tools/visual/aggregate-screenshot-evidence.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(aggregateScript, script);
    return root;
}

function diagnosticPaths(root, group)
{
    const categoryRoot = path.join(root, '.tmp/browser-diagnostics/run/categories/visual');
    return {
        aggregateRoot: path.join(categoryRoot, 'aggregate'),
        outputDir: path.join(categoryRoot, group, 'playwright', `visual-${group}`)
    };
}

function writeGroupSummary(root, group, overrides = {})
{
    const { outputDir } = diagnosticPaths(root, group);
    fs.mkdirSync(outputDir, { recursive: true });
    writeJson(path.join(root, `.tmp/visual/${group}/summary.json`), {
        schema: 'fsusblog.visual.screenshot-group.v1',
        group,
        status: 'success',
        durationMs: group === 'public' ? 11 : 13,
        outputDir,
        shardArg: null,
        generatedAt: new Date().toISOString(),
        ...overrides
    });
}

function runAggregate(root, env = {})
{
    return spawnSync(process.execPath, ['tools/visual/aggregate-screenshot-evidence.mjs'], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8'
    });
}

test('diagnostic mode aggregates current probe summaries without retired CI jobs', () =>
{
    const root = createFixture();
    try
    {
        writeGroupSummary(root, 'public');
        writeGroupSummary(root, 'console');
        const { aggregateRoot } = diagnosticPaths(root, 'public');
        fs.mkdirSync(aggregateRoot, { recursive: true });

        const result = runAggregate(root, {
            FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
            FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: aggregateRoot
        });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\[visual-aggregate\] ok \(2 groups\)/u);
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/visual/summary.json'), 'utf8'));
        assert.equal(summary.status, 'success');
        assert.equal(summary.aggregationMode, 'diagnostic-probes');
        assert.equal(summary.evidenceClass, 'diagnostic');
        assert.equal(summary.affectsCorrectness, false);
        assert.equal(summary.executionBoundary, 'real-browser-screenshot-diagnostics');
        assert.deepEqual(summary.groupDurationsMs, { public: 11, console: 13 });
        for (const group of summary.groups)
        {
            assert.deepEqual(group.expectedJobSummaries, []);
            assert.deepEqual(group.jobSummaryFiles, []);
            assert.match(group.outputPath, new RegExp(`categories/visual/${group.id}/playwright/visual-${group.id}$`, 'u'));
        }
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('diagnostic mode fails closed for skipped, stale or missing probe evidence', async (t) =>
{
    await t.test('skipped group', () =>
    {
        const root = createFixture();
        try
        {
            writeGroupSummary(root, 'public', { status: 'skipped' });
            writeGroupSummary(root, 'console');
            const { aggregateRoot } = diagnosticPaths(root, 'public');
            const result = runAggregate(root, {
                FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
                FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: aggregateRoot
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /public: .*status=skipped/u);
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('stale output directory', () =>
    {
        const root = createFixture();
        try
        {
            writeGroupSummary(root, 'public', { outputDir: path.join(root, '.tmp/stale/public') });
            writeGroupSummary(root, 'console');
            const { aggregateRoot } = diagnosticPaths(root, 'public');
            const result = runAggregate(root, {
                FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
                FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: aggregateRoot
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /public: .*outputDir does not match current diagnostic probe/u);
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('missing summary', () =>
    {
        const root = createFixture();
        try
        {
            writeGroupSummary(root, 'public');
            const { aggregateRoot } = diagnosticPaths(root, 'public');
            const result = runAggregate(root, {
                FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
                FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: aggregateRoot
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /console: missing screenshot group summary/u);
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('non-diagnostic mode preserves CI shard summary aggregation', () =>
{
    const root = createFixture();
    try
    {
        for (const group of ['public', 'console'])
        {
            writeJson(path.join(root, `.tmp/visual/${group}/summary.json`), {
                status: group === 'public' ? 'success' : 'skipped',
                durationMs: 1
            });
        }
        const matrixScript = path.join(root, 'tools/run-test-matrix.mjs');
        fs.mkdirSync(path.dirname(matrixScript), { recursive: true });
        fs.writeFileSync(matrixScript, [
            "const job = process.argv[3]",
            "process.stdout.write(JSON.stringify({ matrix: { include: [{ artifact_name: `${job}-1-of-1` }] } }))"
        ].join('\n'));
        for (const job of ['visual-public-playwright', 'visual-console-playwright'])
        {
            writeJson(path.join(root, `.tmp/release-evidence/jobs/${job}-1-of-1.json`), { status: 'success' });
        }

        const result = runAggregate(root, {
            FSUSBLOG_BROWSER_DIAGNOSTICS: '0',
            FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: '',
            FSUSBLOG_UX_OUTPUT_ROOT: path.join(root, '.tmp/visual'),
            FSUSBLOG_RELEASE_EVIDENCE_DIR: path.join(root, '.tmp/release-evidence')
        });
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/visual/summary.json'), 'utf8'));
        assert.equal(summary.aggregationMode, 'ci-job-shards');
        assert.equal(summary.qualificationEligible, true);
        assert.deepEqual(
            summary.groups.map((group) => group.expectedJobSummaries),
            [['visual-public-playwright-1-of-1'], ['visual-console-playwright-1-of-1']]
        );
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('non-diagnostic mode fails closed without explicit locator roots', () =>
{
    const root = createFixture();
    try
    {
        for (const group of ['public', 'console'])
        {
            writeJson(path.join(root, `.tmp/visual/${group}/summary.json`), {
                status: 'success',
                durationMs: 1
            });
        }
        const result = runAggregate(root, {
            FSUSBLOG_BROWSER_DIAGNOSTICS: '0',
            FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: ''
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /FSUSBLOG_UX_OUTPUT_ROOT/u);
        assert.match(result.stderr, /FSUSBLOG_RELEASE_EVIDENCE_DIR/u);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
