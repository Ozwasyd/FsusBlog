import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('broken-image viewport corpus stays network-free while preserving decode failure', async () =>
{
    const corpus = JSON.parse(await readFile(
        path.join(repoRoot, 'tests/frontend/fixtures/ux-content-boundary-corpus.json'),
        'utf8'
    ));
    const brokenImage = corpus.cases.find((item) => item.id === 'broken-image');
    assert.equal(brokenImage?.kind, 'image');
    assert.match(brokenImage?.sample ?? '', /^data:image\/png;base64,/u);
});

test('summary follows the current-run pointer and ignores stale-run artifacts', async (t) =>
{
    const root = await mkdtemp(path.join(tmpdir(), 'fsusblog-ux-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixtureRoot = path.join(root, 'tests/frontend/fixtures');
    await mkdir(fixtureRoot, { recursive: true });
    for (const fixture of ['ux-viewport-matrix.json', 'ux-content-boundary-corpus.json'])
    {
        await copyFile(
            path.join(repoRoot, 'tests/frontend/fixtures', fixture),
            path.join(fixtureRoot, fixture)
        );
    }

    const runId = 'current-runtime-run';
    const runRoot = path.join(root, '.tmp/ux/runs', runId, 'smoke');
    const screenshotRoot = path.join(runRoot, 'screenshots/mobile/light');
    await mkdir(screenshotRoot, { recursive: true });
    await writeFile(path.join(screenshotRoot, 'current.png'), 'current');
    await mkdir(path.join(root, '.tmp/ux/runs/stale-run/smoke/screenshots'), { recursive: true });
    await writeFile(path.join(root, '.tmp/ux/runs/stale-run/smoke/screenshots/stale.png'), 'stale');

    const progressFile = path.join(runRoot, 'progress.json');
    await writeFile(progressFile, `${JSON.stringify({
        version: 'fsusblog-ux-viewport-progress-v1',
        runId,
        runToken: 'current-token',
        mode: 'smoke',
        planFingerprint: 'runtime-fingerprint',
        matrixVersion: 'fsusblog-ux-viewport-matrix-v1',
        status: 'passed',
        startedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:01:00.000Z',
        finishedAt: '2026-07-10T00:01:00.000Z',
        planned: { routes: 1, routeThemeGroups: 1, navigations: 1, cases: 1 },
        selection: {
            routeIds: ['public-home'],
            themes: ['light'],
            viewportIds: ['mobile'],
            media: ['default']
        },
        actual: {
            completedRouteThemeGroups: 1,
            navigations: 1,
            cases: 1,
            failedRouteThemeGroups: 0
        },
        completedGroupIds: ['public-home:light'],
        groupResults: [{
            groupId: 'public-home:light',
            routeId: 'public-home',
            theme: 'light',
            status: 'passed',
            viewportIds: ['mobile'],
            media: ['default'],
            navigations: 1,
            cases: 1,
            artifacts: []
        }],
        artifacts: {
            root: `.tmp/ux/runs/${runId}/smoke`,
            outputDir: `.tmp/ux/runs/${runId}/smoke/playwright`
        }
    }, null, 2)}\n`);
    await mkdir(path.join(root, '.tmp/ux'), { recursive: true });
    await writeFile(path.join(root, '.tmp/ux/current-smoke-run.json'), `${JSON.stringify({
        version: 'fsusblog-ux-viewport-run-pointer-v1',
        runId,
        runToken: 'current-token',
        mode: 'smoke',
        planFingerprint: 'runtime-fingerprint',
        progressFile: `.tmp/ux/runs/${runId}/smoke/progress.json`
    }, null, 2)}\n`);

    const { writeUxViewportSummary } = await import(
        `../frontend/checks/ux/write-ux-viewport-summary.mjs?runtime=${Date.now()}`
    );
    const result = await writeUxViewportSummary({ root, mode: 'smoke' });
    const summary = JSON.parse(await readFile(result.artifact, 'utf8'));

    assert.equal(summary.status, 'ok');
    assert.equal(summary.runId, runId);
    assert.equal(summary.completedRouteThemeGroupCount, 1);
    assert.deepEqual(summary.screenshots, [
        `.tmp/ux/runs/${runId}/smoke/screenshots/mobile/light/current.png`
    ]);
    assert.equal(JSON.stringify(summary).includes('stale.png'), false);

    const staleRunId = 'stale-run';
    const staleProgressFile = path.join(root, '.tmp/ux/runs', staleRunId, 'smoke/progress.json');
    const currentProgress = JSON.parse(await readFile(progressFile, 'utf8'));
    await writeFile(staleProgressFile, `${JSON.stringify({
        ...currentProgress,
        runId: staleRunId,
        artifacts: {
            ...currentProgress.artifacts,
            root: `.tmp/ux/runs/${staleRunId}/smoke`
        }
    }, null, 2)}\n`);
    await writeFile(path.join(root, '.tmp/ux/current-smoke-run.json'), `${JSON.stringify({
        version: 'fsusblog-ux-viewport-run-pointer-v1',
        runId: staleRunId,
        runToken: 'stale-token',
        mode: 'smoke',
        planFingerprint: 'runtime-fingerprint',
        progressFile: `.tmp/ux/runs/${staleRunId}/smoke/progress.json`
    }, null, 2)}\n`);

    const exact = await writeUxViewportSummary({ root, mode: 'smoke', runId });
    assert.equal(exact.summary.runId, runId);
    assert.equal(JSON.stringify(exact.summary).includes('stale.png'), false);
});

test('visual summary requires one current-run screenshot per planned cold navigation', async (t) =>
{
    const root = await mkdtemp(path.join(tmpdir(), 'fsusblog-ux-visual-summary-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixtureRoot = path.join(root, 'tests/frontend/fixtures');
    await mkdir(fixtureRoot, { recursive: true });
    for (const fixture of ['ux-viewport-matrix.json', 'ux-content-boundary-corpus.json'])
    {
        await copyFile(
            path.join(repoRoot, 'tests/frontend/fixtures', fixture),
            path.join(fixtureRoot, fixture)
        );
    }

    const runId = 'current-visual-run';
    const runRoot = path.join(root, '.tmp/ux/runs', runId, 'visual');
    const screenshotRoot = path.join(runRoot, 'screenshots/desktop/light');
    await mkdir(screenshotRoot, { recursive: true });
    await writeFile(path.join(screenshotRoot, 'first.png'), 'first');

    const progressFile = path.join(runRoot, 'progress.json');
    await writeFile(progressFile, `${JSON.stringify({
        version: 'fsusblog-ux-viewport-progress-v1',
        runId,
        runToken: 'visual-token',
        mode: 'visual',
        planFingerprint: 'visual-fingerprint',
        matrixVersion: 'fsusblog-ux-viewport-matrix-v1',
        status: 'passed',
        startedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:01:00.000Z',
        finishedAt: '2026-07-10T00:01:00.000Z',
        planned: { routes: 1, routeThemeGroups: 1, navigations: 2, cases: 2 },
        selection: {
            routeIds: ['public-home'],
            themes: ['light'],
            viewportIds: ['desktop'],
            media: ['default', 'large-text']
        },
        actual: {
            completedRouteThemeGroups: 1,
            navigations: 2,
            cases: 2,
            failedRouteThemeGroups: 0
        },
        completedGroupIds: ['public-home:light'],
        groupResults: [{
            groupId: 'public-home:light',
            routeId: 'public-home',
            theme: 'light',
            status: 'passed',
            viewportIds: ['desktop'],
            media: ['default', 'large-text'],
            navigations: 2,
            cases: 2,
            artifacts: []
        }],
        artifacts: {
            root: `.tmp/ux/runs/${runId}/visual`,
            outputDir: `.tmp/ux/runs/${runId}/visual/playwright`
        }
    }, null, 2)}\n`);
    await mkdir(path.join(root, '.tmp/ux'), { recursive: true });
    await writeFile(path.join(root, '.tmp/ux/current-visual-run.json'), `${JSON.stringify({
        version: 'fsusblog-ux-viewport-run-pointer-v1',
        runId,
        runToken: 'visual-token',
        mode: 'visual',
        planFingerprint: 'visual-fingerprint',
        progressFile: `.tmp/ux/runs/${runId}/visual/progress.json`
    }, null, 2)}\n`);

    const { writeUxViewportSummary } = await import(
        `../frontend/checks/ux/write-ux-viewport-summary.mjs?visual=${Date.now()}`
    );
    const incomplete = await writeUxViewportSummary({ root, mode: 'visual' });
    assert.equal(incomplete.summary.status, 'incomplete');
    assert.equal(incomplete.summary.screenshotCount, 1);
    assert.equal(incomplete.summary.plannedScreenshotCount, 2);

    await writeFile(path.join(screenshotRoot, 'second.png'), 'second');
    const complete = await writeUxViewportSummary({ root, mode: 'visual' });
    assert.equal(complete.summary.status, 'ok');
    assert.equal(complete.summary.screenshotCount, 2);
    assert.equal(complete.summary.plannedScreenshotCount, 2);
});
