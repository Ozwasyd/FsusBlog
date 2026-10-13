import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { summarizeActualPlan } = await import(new URL('../../tools/data-scale/query-matrix.mjs', import.meta.url));
const { loadQueryPayloadDecoders } = await import(new URL('../../tools/data-scale/query-payload-decoders.mjs', import.meta.url));
const { bindQueryPlanCapture } = await import(new URL('../../tools/data-scale/query-plan-capture.mjs', import.meta.url));
const { computeSourceClosureDigest } = await import(new URL('../../tools/test-observations/source-identity.mjs', import.meta.url));
const { defaultTimeoutPolicyDigest, materializeTemporalEnvironment, monotonicNow, qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/test-execution-service-catalog.json'), 'utf8'));

function docker(args)
{
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
}

test('authenticated observer captures actual SqlSugar/Npgsql commands and read-only parameterized plans', async (context) =>
{
    const runId = `query-capture-${randomBytes(8).toString('hex')}`;
    const name = `fsusblog-query-capture-control-${runId}`;
    const labels = { 'fsusblog.owner': 'data-scale-query-capture-test', 'fsusblog.runId': runId };
    const image = catalog.services.postgres.imageReference;
    const imageId = JSON.parse(docker(['image', 'inspect', image]))[0].Id;
    const externalIds = docker(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort();
    const outputRoot = path.join(root, '.tmp/query-matrix-capture-controls', runId);
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const collector = path.join(root, 'tools/data-scale/query-plan-collector/bin/Release/net10.0/QueryPlanCollector.dll');
    assert.ok(fs.existsSync(collector), 'build QueryPlanCollector Release with the current source commit before this test');
    let containerId;
    let passed = false;
    function inspectOwned()
    {
        const observed = JSON.parse(docker(['inspect', name]))[0];
        assert.equal(observed.Id, containerId);
        assert.equal(observed.Image, imageId);
        for (const [key, value] of Object.entries(labels))
        {
            assert.equal(observed.Config.Labels[key], value);
        }
        return observed;
    }
    try
    {
        containerId = docker([
            'run', '--detach', '--pull', 'never', '--name', name, '--publish', '127.0.0.1::5432',
            ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
            '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=fsusblog',
            '-e', 'POSTGRES_PASSWORD=isolated_capture_control', '-e', 'POSTGRES_DB=query_capture_controls', image
        ]);
        const deadline = monotonicNow() + 30_000;
        let ready = false;
        while (monotonicNow() < deadline)
        {
            const result = spawnSync('docker', ['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'fsusblog', '-d', 'query_capture_controls'], { timeout: 2000 });
            if (result.status === 0)
            {
                ready = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.ok(ready, 'dedicated PostgreSQL did not become ready');
        const owned = inspectOwned();
        const port = owned.NetworkSettings.Ports['5432/tcp'][0];
        assert.equal(port.HostIp, '127.0.0.1');
        const connectionPath = path.join(outputRoot, 'connection.private');
        fs.writeFileSync(connectionPath, `Host=127.0.0.1;Port=${port.HostPort};Database=query_capture_controls;Username=fsusblog;Password=isolated_capture_control;Pooling=false`, { mode: 0o600 });
        const result = spawnSync('dotnet', [collector, '--self-test', connectionPath, outputRoot, sourceCommit], {
            cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, ...materializeTemporalEnvironment(qualificationTemporalContext({
                sourceCommit, sourceFingerprint: computeSourceClosureDigest({ root, paths: [
                    'src/backend/Infrastructure/Testing/QueryPlanCommandCapture.cs',
                    'tools/data-scale/query-plan-collector/Program.cs',
                    'tools/data-scale/query-plan-collector/CollectorControls.cs'
                ] }), producerId: 'query-capture-controls', schedulerRunId: runId,
                businessEpochUtc: '2026-01-01T00:00:00Z', locale: 'en-US', uiLocale: 'en-US', timeoutPolicyDigest: defaultTimeoutPolicyDigest()
            })) }
        });
        fs.writeFileSync(path.join(outputRoot, 'collector-controls.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600 });
        assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
        const controlResult = JSON.parse(result.stdout.trim());
        assert.equal(controlResult.status, 'passed');
        assert.equal(controlResult.qualification, 'not-performed');
        const plans = JSON.parse(fs.readFileSync(path.join(outputRoot, 'plans.json'), 'utf8'));
        assert.equal(plans.binding.sourceCommit, sourceCommit);
        assert.equal(plans.queries.length, 2);
        for (const query of plans.queries)
        {
            const metrics = summarizeActualPlan(query.explain);
            assert.ok(metrics.indexNames.includes('query_capture_control_pkey'));
            assert.equal(metrics.rowsRead, 10);
        }
        const httpSample = {
            binding: plans.binding, requestId: plans.observation.requestId,
            requestPath: plans.observation.path, path: plans.observation.path,
            status: 200, body: Buffer.from('collector-control')
        };
        assert.equal(bindQueryPlanCapture({ capture: plans, httpSample, httpSampleIndex: 0, binding: plans.binding }).length, 2);
        assert.throws(() => bindQueryPlanCapture({ capture: plans, httpSample: { ...httpSample, body: Buffer.from('wrong-body') }, httpSampleIndex: 0, binding: plans.binding }), /not bound/u);
        assert.throws(() => bindQueryPlanCapture({ capture: { ...plans, queries: plans.queries.slice(1) }, httpSample, httpSampleIndex: 0, binding: plans.binding }), /incomplete/u);
        const decoders = await loadQueryPayloadDecoders();
        const payload = (file) => new Uint8Array(fs.readFileSync(path.join(outputRoot, file)));
        const page = decoders['article-list-first-page'](payload('article-page.payload'));
        assert.equal(page.items[0].id, 42);
        assert.equal(page.items[0].title, 'collector article');
        assert.equal(page.hasMore, false);
        assert.equal(decoders['article-detail-first'](payload('article-detail.payload')).items[0].content, 'collector body');
        assert.equal(decoders['search-title-canary'](payload('article-search.payload')).items[0].id, 42);
        assert.equal(decoders['comment-root-first'](payload('comment-roots.payload')).items[0].rootId, '301');
        assert.equal(decoders['comment-nested-root-expansion'](payload('comment-children.payload')).items[0].parentId, '301');
        for (const decode of Object.values(decoders))
        {
            assert.throws(() => decode(new Uint8Array([1, 2, 3])), 'product decoder accepted a truncated payload');
        }
        if (process.platform !== 'win32')
        {
            assert.equal(fs.statSync(path.join(outputRoot, 'plans.json')).mode & 0o777, 0o600);
        }
        passed = true;
    }
    finally
    {
        if (containerId)
        {
            inspectOwned();
            docker(['rm', '--force', containerId]);
        }
        assert.deepEqual(docker(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort(), externalIds);
        fs.rmSync(path.join(outputRoot, 'connection.private'), { force: true });
        fs.writeFileSync(path.join(outputRoot, 'receipt.json'), `${JSON.stringify({
            schema: 'fsusblog.query-capture-controls.v1', sourceCommit, imageReference: image, imageId,
            status: passed ? 'passed' : 'failed', qualification: 'not-performed',
            cleanup: { ownedContainerAbsent: true, externalContainerIdsUnchanged: true }
        }, null, 4)}\n`, { mode: 0o600 });
        context.diagnostic(`collector controls: ${path.relative(root, outputRoot)}/receipt.json`);
    }
});
