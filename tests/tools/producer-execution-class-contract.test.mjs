import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('matrix producer classes have an explicit identity and qualification mapping', () =>
{
    const result = spawnSync(process.execPath, ['tools/test/check-producer-execution-class-contract.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /correctness=\d+/u);
});

test('static governance rejects a wrapper that bypasses the canonical runner with a direct spawn', () =>
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-producer-contract-'));
    fs.mkdirSync(path.join(fixture, 'config/testing'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'tools/test'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'config/testing/producer-execution-class-contract.json'), JSON.stringify({
        schema: 'fsusblog.test-producer-execution-class.v1',
        canonicalRunnerInvocations: { 'tools/test/wrapper.sh': ['fixture'] },
        classes: {
            correctness: { executionClass: 'correctness', requires: ['producerId', 'schedulerRunId', 'sourceIdentity'] },
            'browser-contract': { executionClass: 'correctness', requires: ['producerId', 'schedulerRunId', 'sourceIdentity'] },
            diagnostic: { executionClass: 'diagnostic', qualificationEligible: false }
        }
    }));
    fs.writeFileSync(path.join(fixture, 'tests/matrix.yml'), 'tiers:\n  - id: fixture\n    evidenceClass: correctness\n    executionDependsOn: []\n');
    fs.writeFileSync(path.join(fixture, 'tools/test/wrapper.sh'), 'node -e 0\n');
    const result = spawnSync(process.execPath, [path.join(root, 'tools/test/check-producer-execution-class-contract.mjs'), `--root=${fixture}`], {
        cwd: fixture,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing canonical runner invocation fixture/u);
});

test('static governance rejects an invocation outside the canonical inventory', () =>
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-producer-contract-'));
    fs.mkdirSync(path.join(fixture, 'config/testing'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'tools/test'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'config/testing/producer-execution-class-contract.json'), JSON.stringify({
        schema: 'fsusblog.test-producer-execution-class.v1',
        canonicalRunnerInvocations: { 'tools/test/wrapper.sh': ['fixture'] },
        classes: {
            correctness: { executionClass: 'correctness', requires: ['producerId', 'schedulerRunId', 'sourceIdentity'] },
            'browser-contract': { executionClass: 'correctness', requires: ['producerId', 'schedulerRunId', 'sourceIdentity'] },
            diagnostic: { executionClass: 'diagnostic', qualificationEligible: false }
        }
    }));
    fs.writeFileSync(path.join(fixture, 'tests/matrix.yml'), 'tiers:\n  - id: fixture\n    evidenceClass: correctness\n    executionDependsOn: []\n');
    fs.writeFileSync(
        path.join(fixture, 'tools/test/wrapper.sh'),
        'node tools/test/run-deterministic-command.mjs --key unexpected --execution-class correctness --producer-id unexpected -- node -e 0\n'
    );
    const result = spawnSync(process.execPath, [path.join(root, 'tools/test/check-producer-execution-class-contract.mjs'), `--root=${fixture}`], {
        cwd: fixture,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected canonical runner invocation unexpected/u);
});
