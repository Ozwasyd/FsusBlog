import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('seal-in-place benchmark records three honest before/after rounds and fallback identity', t =>
{
    const output = path.join(os.tmpdir(), `fsusblog-seal-cow-evidence-${process.pid}.json`);
    t.after(() => fs.rmSync(output, { force: true }));
    const result = spawnSync(process.execPath, [
        'tools/ci/benchmark-production-build-materialization.mjs',
        '--rounds', '3',
        '--bytes', String(128 * 1024),
        '--out', output
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.rounds, 3);
    assert.equal(evidence.samples.length, 3);
    for (const sample of evidence.samples)
    {
        assert.ok(sample.after.copiedBytes < sample.before.copiedBytes);
        assert.ok(sample.after.digestTraversalCount < sample.before.digestTraversalCount);
        assert.equal(sample.after.testResultDigest, sample.before.testResultDigest);
        assert.ok(['reflink', 'copy-fallback'].includes(sample.after.writableMethod));
        if (sample.after.writableMethod === 'copy-fallback')
        {
            assert.match(sample.after.fallbackReason, /ENOSYS|ENOTSUP|EXDEV|EOPNOTSUPP/u);
        }
    }
});
