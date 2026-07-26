import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { readLoadProfilePolicy } = await import(
    pathToFileURL(path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs')).href
);

test('load profile policy parser accepts repository CRLF or LF input', () => {
    const policy = readLoadProfilePolicy('expected-peak');
    assert.deepEqual(policy.declared, {
        concurrency: 50,
        rounds: 12,
        durationMs: 60000
    });
    assert.equal(policy.thresholds.minRps, 1);
});
