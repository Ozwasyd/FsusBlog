import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const verifier = 'tools/verify-zk-privacy-matrix.mjs';
const matrixPath = 'security/matrices/privacy-zk-comment.yml';
const tamperPath = 'security/zk/contracts/comment-v5-tamper-cases.manifest.json';

function runVerifier(args = [])
{
    return spawnSync(process.execPath, [verifier, ...args], {
        encoding: 'utf8'
    });
}

test('zk privacy matrix verifier accepts the repository manifests', () =>
{
    const result = runVerifier();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[zk-privacy-matrix] ok/);
});

test('zk privacy matrix verifier fails when required negative invariant lacks a manifest mapping', () =>
{
    const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-matrix-'));
    try
    {
        const matrix = path.join(dir, 'matrix.yml');
        const tamper = path.join(dir, 'tamper.json');
        const manifest = JSON.parse(readFileSync(tamperPath, 'utf8'));
        manifest.tamper_cases = manifest.tamper_cases.filter((entry) => entry.id !== 'tamper-root');

        writeFileSync(matrix, readFileSync(matrixPath, 'utf8'));
        writeFileSync(tamper, `${JSON.stringify(manifest, null, 2)}\n`);

        const result = runVerifier(['--matrix', matrix, '--tamper', tamper]);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /tamper-root/);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('zk privacy matrix verifier fails when a negative invariant references a missing tamper case', () =>
{
    const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-matrix-'));
    try
    {
        const matrix = path.join(dir, 'matrix.yml');
        const tamper = path.join(dir, 'tamper.json');
        const manifest = JSON.parse(readFileSync(tamperPath, 'utf8'));
        const tamperCase = manifest.tamper_cases.find((entry) => entry.id === 'tamper-scope');
        tamperCase.expected = 'accept';

        writeFileSync(matrix, readFileSync(matrixPath, 'utf8'));
        writeFileSync(tamper, `${JSON.stringify(manifest, null, 2)}\n`);

        const result = runVerifier(['--matrix', matrix, '--tamper', tamper]);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /tamper-scope/);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});
