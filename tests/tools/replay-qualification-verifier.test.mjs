import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const verifier = path.join(root, 'tools/test/verify-replay-qualification.mjs');

test('verify-only qualification entry requires one explicit receipt and launches no fallback', () =>
{
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: verify-replay-qualification/u);
});

test('verify-only qualification entry rejects extra alternate receipts', () =>
{
    const result = spawnSync(process.execPath, [verifier, '.tmp/first.json', '.tmp/latest.json'], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: verify-replay-qualification/u);
});
