import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('default npm freshness entrypoint invokes the sole producer without simulation flags', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    assert.equal(manifest.scripts['deps:freshness'], 'node ../../tools/governance/check-dependency-freshness.mjs --root ../..');
});

test('explicit fixture execution remains available through the same npm entrypoint', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-freshness-entrypoint-'));
    try
    {
        const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/governance/dependency-freshness.json'), 'utf8'));
        fixtures.cases = fixtures.cases.slice(0, 3);
        const fixturePath = path.join(directory, 'fixtures.json');
        const resultPath = path.join(directory, 'result.json');
        fs.writeFileSync(fixturePath, JSON.stringify(fixtures));
        const result = spawnSync('npm', ['--prefix', 'src/frontend', 'run', 'deps:freshness', '--', '--fixtures', fixturePath, '--output', resultPath], {
            cwd: root, encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, FSUSBLOG_DEPS_FRESHNESS_FIXTURES: '' }
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        assert.equal(output.status, 'pass');
        assert.equal(output.evidenceClass, 'local-controlled-simulation');
        assert.equal(output.cases.length, 3);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
