import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('native adapters preserve reserved socket identity through real runtimes and terminal cleanup', { timeout: 180_000 }, () =>
{
    const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-native-listener-test-'));
    const fixture = fileURLToPath(new URL('./fixtures/managed-listener/probe.py', import.meta.url));
    const result = spawnSync(process.env.FSUSBLOG_PYTHON || 'python3', [fixture], {
        encoding: 'utf8', timeout: 170_000, env: { ...process.env, FSUSBLOG_NATIVE_LISTENER_EVIDENCE: evidence }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nEvidence: ${evidence}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, 'report.json'), 'utf8'));
    assert.equal(receipt.passed, true);
    assert.equal(receipt.cases.length, 54);
    console.log(`Native listener runtime evidence: ${evidence}`);
});
