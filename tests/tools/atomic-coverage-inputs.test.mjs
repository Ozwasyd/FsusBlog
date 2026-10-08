import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {sealContentDigest} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {prepareCoverageProducer, readCoverageMaterial} = await import(new URL('../../tools/coverage/atomic-coverage-inputs.mjs', import.meta.url));
import { coverageFixture } from './support/atomic-coverage-fixtures.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function prepare(fixture, producerId, inputs)
{
    return prepareCoverageProducer({ ...fixture, producerId, inputs });
}

for (const failedDomain of ['backend', 'frontend'])
{
    test(`${failedDomain} collection failure blocks merge but preserves the other independent input`, (t) =>
    {
        const fixture = coverageFixture(t);
        const other = failedDomain === 'backend' ? 'frontend' : 'backend';
        const failed = fixture.makeMaterial(`coverage-${failedDomain}`, 'failed-no-retry');
        assert.ok(prepare(fixture, `coverage-${other}`, {}).command);
        const success = fixture.makeMaterial(`coverage-${other}`);
        assert.equal(readCoverageMaterial({ ...fixture, producerId: `coverage-${other}`, material: success }).status, 'clean-success');
        assert.throws(() => prepare(fixture, 'coverage-merge', { [`coverage-${failedDomain}`]: failed, [`coverage-${other}`]: success }), /hard input failed/u);
    });
}

test('missing merge blocks only scope/merged; both domain threshold commands remain usable', (t) =>
{
    const fixture = coverageFixture(t);
    const backend = fixture.makeMaterial('coverage-backend');
    const frontend = fixture.makeMaterial('coverage-frontend');
    assert.throws(() => prepare(fixture, 'coverage-scope-snapshot', {}), /exact hard input roster/u);
    assert.throws(() => prepare(fixture, 'coverage-threshold-merged', {}), /exact hard input roster/u);
    assert.ok(prepare(fixture, 'coverage-threshold-backend', { 'coverage-backend': backend }).command);
    assert.ok(prepare(fixture, 'coverage-threshold-frontend', { 'coverage-frontend': frontend }).command);
});

test('prepared merge executes unchanged weighted merger against two verified current summaries', (t) =>
{
    const fixture = coverageFixture(t);
    const backend = fixture.makeMaterial('coverage-backend');
    const frontend = fixture.makeMaterial('coverage-frontend');
    const request = prepare(fixture, 'coverage-merge', { 'coverage-backend': backend, 'coverage-frontend': frontend });
    const args = [...request.command.slice(1)];
    args[args.length - 1] = path.join(repositoryRoot, 'tools/coverage/merge-coverage.sh');
    const result = spawnSync(request.command[0], args, { cwd: fixture.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(fs.readFileSync(path.join(fixture.root, '.tmp/coverage/merged/Summary.json')));
    assert.deepEqual(merged.totals.lines, { covered: 2, total: 2 });
    assert.equal(merged.sources.backend, true);
    assert.equal(merged.sources.frontend, true);
    assert.equal(request.inputRefs.length, 2);
});

for (const mutation of ['summary-tamper', 'snapshot-tamper', 'receipt-tamper', 'raw-tamper', 'replay-tamper', 'duplicate', 'wrong-domain', 'old-path', 'symlink'])
{
    test(`explicit coverage inputs reject ${mutation}`, (t) =>
    {
        const fixture = coverageFixture(t);
        const material = fixture.makeMaterial('coverage-backend');
        const summary = material.artifacts.find((item) => item.role === 'summary');
        if (mutation === 'summary-tamper')
        {
            fs.appendFileSync(path.join(fixture.root, summary.path), ' ');
        }
        if (mutation === 'snapshot-tamper')
        {
            fs.appendFileSync(path.join(fixture.root, path.dirname(material.attemptRef.path), summary.attemptPath), ' ');
        }
        if (mutation === 'receipt-tamper')
        {
            fs.appendFileSync(path.join(fixture.root, material.attemptRef.path), ' ');
        }
        if (mutation === 'raw-tamper')
        {
            fs.appendFileSync(path.join(fixture.root, material.artifacts.find((item) => item.role === 'raw').path), ' ');
        }
        if (mutation === 'replay-tamper')
        {
            fs.appendFileSync(path.join(fixture.root, path.dirname(material.attemptRef.path), 'replay-plan.json'), ' ');
        }
        if (mutation === 'duplicate')
        {
            material.artifacts.push({ ...summary });
        }
        if (mutation === 'wrong-domain')
        {
            summary.path = '.tmp/coverage/frontend/Summary.json';
        }
        if (mutation === 'old-path')
        {
            summary.path = '.tmp/coverage/old/backend-merged/Summary.json';
        }
        if (mutation === 'symlink')
        {
            const target = path.join(fixture.root, summary.path);
            fs.renameSync(target, `${target}.old`);
            fs.symlinkSync(`${target}.old`, target);
        }
        assert.throws(() => readCoverageMaterial({ ...fixture, producerId: 'coverage-backend', material }));
    });
}

for (const mutation of ['cross-run', 'missing-metric', 'partial-merge'])
{
    test(`even newly sealed attempt material rejects ${mutation}`, (t) =>
    {
        const fixture = coverageFixture(t);
        const producerId = mutation === 'partial-merge' ? 'coverage-merge' : 'coverage-backend';
        const material = fixture.makeMaterial(producerId, 'clean-success', (summary) =>
        {
            if (mutation === 'cross-run')
            {
                summary.producer = { ...summary.producer, runId: 'old-run' };
            }
            if (mutation === 'missing-metric')
            {
                delete summary.summary.linecoverage;
            }
            if (mutation === 'partial-merge')
            {
                summary.sources.frontend = false;
            }
            return summary;
        });
        assert.throws(() => readCoverageMaterial({ ...fixture, producerId, material }), /cross-run|missing\/invalid|partial/u);
    });
}

test('a second attempt, false authority or diagnostic success cannot authorize a command', (t) =>
{
    const fixture = coverageFixture(t);
    const material = fixture.makeMaterial('coverage-backend');
    assert.throws(() => readCoverageMaterial({ ...fixture, producerId: 'coverage-backend', material, verifyAuthority: () => null }), /not verified/u);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.root, material.attemptRef.path)));
    delete receipt.contentDigest;
    material.attemptRef = fixture.write(material.attemptRef.path, sealContentDigest({ ...receipt, attemptNumber: 2 }));
    assert.throws(() => readCoverageMaterial({ ...fixture, producerId: 'coverage-backend', material }), /attempt count|repeated/u);
});
