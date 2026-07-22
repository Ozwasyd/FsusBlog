import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const relativeScript = 'tools/test/lanes/release-evidence.sh';
const script = path.join(root, relativeScript);

test('release evidence lane remains valid shell after its rolling parallel DAG change', () =>
{
    const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
