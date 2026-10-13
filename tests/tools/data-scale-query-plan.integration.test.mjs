import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { summarizeActualPlan } = await import(new URL('../../tools/data-scale/query-matrix.mjs', import.meta.url));
const { monotonicNow } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/test-execution-service-catalog.json'), 'utf8'));

function run(args, input)
{
    const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
}

test('real PostgreSQL plans retain actual rows/buffers and expose OFFSET and missing-index controls', async (context) =>
{
    const runId = `query-plan-${randomBytes(8).toString('hex')}`;
    const name = `fsusblog-data-scale-plan-test-${runId}`;
    const image = catalog.services.postgres.imageReference;
    const labels = { 'fsusblog.owner': 'data-scale-query-plan-test', 'fsusblog.runId': runId };
    const priorContainerIds = run(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort();
    const outputRoot = path.join(root, '.tmp/query-matrix-plan-controls', runId);
    fs.mkdirSync(outputRoot, { recursive: true });
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const imageIdentity = JSON.parse(run(['image', 'inspect', image]))[0].Id;
    let containerId;
    let receipt;
    function inspectOwned()
    {
        const observed = JSON.parse(run(['inspect', name]))[0];
        assert.equal(observed.Id, containerId);
        for (const [key, value] of Object.entries(labels))
        {
            assert.equal(observed.Config.Labels[key], value);
        }
        assert.equal(observed.Image, imageIdentity);
        return observed;
    }
    function sql(statement)
    {
        inspectOwned();
        return run(['exec', '-i', containerId, 'psql', '--no-psqlrc', '--tuples-only', '--no-align', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'query_plan_controls'], statement);
    }
    function plan(statement)
    {
        const raw = sql(`BEGIN READ ONLY;\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement};\nROLLBACK;`);
        const begin = raw.indexOf('[\n');
        const end = raw.lastIndexOf(']');
        assert.ok(begin >= 0 && end > begin, 'actual plan JSON missing');
        const explain = JSON.parse(raw.slice(begin, end + 1));
        return { sql: statement, explain, metrics: summarizeActualPlan(explain) };
    }
    try
    {
        containerId = run([
            'run', '--detach', '--pull', 'never', '--network', 'none', '--name', name,
            ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
            '--tmpfs', '/var/lib/postgresql/data',
            '-e', 'POSTGRES_USER=fsusblog', '-e', 'POSTGRES_PASSWORD=isolated_plan_control',
            '-e', 'POSTGRES_DB=query_plan_controls', image
        ]);
        const deadline = monotonicNow() + 30_000;
        let ready = false;
        while (monotonicNow() < deadline)
        {
            const result = spawnSync('docker', ['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'fsusblog', '-d', 'query_plan_controls'], { timeout: 2000 });
            if (result.status === 0)
            {
                ready = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.ok(ready, 'dedicated PostgreSQL did not become ready');
        const version = sql('SELECT current_setting(\'server_version_num\');');
        assert.equal(version, catalog.services.postgres.serverVersionNumber);
        // Deliberately a plan-control table: no product seed, API or qualification claim.
        sql(`CREATE TABLE query_plan_control(id integer PRIMARY KEY, bucket integer NOT NULL);
INSERT INTO query_plan_control SELECT n, n % 100 FROM generate_series(1, 10000) n;
ANALYZE query_plan_control;`);
        const keyset = plan('SELECT id FROM query_plan_control WHERE id < 100 ORDER BY id DESC LIMIT 10');
        const offset = plan('SELECT id FROM query_plan_control ORDER BY id DESC OFFSET 9000 LIMIT 10');
        const missingIndex = plan('SELECT id FROM query_plan_control WHERE bucket = 7');
        assert.ok(keyset.metrics.indexNames.includes('query_plan_control_pkey'));
        assert.ok(keyset.metrics.rowsRead <= 10);
        assert.ok(offset.metrics.rowsRead >= 9010, 'OFFSET work was not measured');
        assert.ok(missingIndex.metrics.scanTypes.includes('Seq Scan'));
        assert.equal(missingIndex.metrics.rowsRead, 10000);
        receipt = {
            schema: 'fsusblog.data-scale-query-plan-controls.v1',
            evidenceKind: 'isolated-collector-controls',
            sourceCommit,
            runId,
            containerId,
            imageReference: image,
            imageId: imageIdentity,
            serverVersionNumber: version,
            controls: { keyset, offset, missingIndex },
            qualification: 'not-performed'
        };
    }
    finally
    {
        if (containerId)
        {
            inspectOwned();
            run(['rm', '--force', containerId]);
            assert.equal(run(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).includes(containerId), false);
        }
        const after = run(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort();
        assert.deepEqual(after, priorContainerIds, 'external container identities changed');
        if (receipt)
        {
            receipt.cleanup = { ownedContainerAbsent: true, externalContainerIdsUnchanged: true };
            fs.writeFileSync(path.join(outputRoot, 'controls.json'), `${JSON.stringify(receipt, null, 4)}\n`);
            context.diagnostic(`actual plan controls: ${path.relative(root, outputRoot)}/controls.json`);
        }
    }
});
