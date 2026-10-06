import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/security/check-authoring-extension-terminal-matrix.mjs');
const catalogPath = path.join(root, 'config/testing/authoring-extension-terminal-matrix.json');

function run(args = [], cwd = root)
{
    return spawnSync(process.execPath, [checker, ...args], {
        cwd,
        encoding: 'utf8'
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function sha256(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('authoring terminal matrix audits closed registries and declares every current blocker', () =>
{
    const result = run();

    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /audit registries=14 suites=10 blockers=9/);
    assert.match(result.stdout, /blocked-fsusui-document-consent-authority/);
    assert.match(result.stdout, /blocked-current-pressure-starvation-run/);
});

test('authoring terminal matrix rejects registry drift and receipt creation without evidence', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-authoring-matrix-'));
    try
    {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        catalog.registries.find((entry) => entry.id === 'rpc-methods').expected.pop();
        const drifted = path.join(directory, 'catalog.json');
        writeFileSync(drifted, `${JSON.stringify(catalog, null, 2)}\n`);

        const driftResult = run(['--catalog', drifted]);
        assert.notEqual(driftResult.status, 0);
        assert.match(output(driftResult), /rpc-methods members drifted/);

        const missingEvidence = run(['--write-receipt', path.join(directory, 'receipt.json')]);
        assert.notEqual(missingEvidence.status, 0);
        assert.match(output(missingEvidence), /requires --evidence/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('authoring terminal receipt refuses complete synthetic evidence and still detects tamper', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-authoring-receipt-'));
    try
    {
        for (const entry of ['src', 'tests', 'tools'])
        {
            symlinkSync(path.join(root, entry), path.join(directory, entry), 'dir');
        }
        mkdirSync(path.join(directory, 'config/testing'), { recursive: true });
        writeFileSync(
            path.join(directory, 'config/testing/authoring-extension-terminal-matrix.json'),
            readFileSync(catalogPath));

        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const artifacts = [];
        mkdirSync(path.join(directory, 'evidence'), { recursive: true });
        for (const [index, requirement] of catalog.terminalEvidence.entries())
        {
            const relativePath = `evidence/${index}.json`;
            const bytes = Buffer.from(JSON.stringify({ currentRun: true, id: requirement.id }));
            writeFileSync(path.join(directory, relativePath), bytes);
            artifacts.push({
                id: requirement.id,
                path: relativePath,
                sha256: sha256(bytes),
                status: 'passed'
            });
        }
        const evidencePath = path.join(directory, 'evidence.json');
        writeFileSync(evidencePath, `${JSON.stringify({
            schema: 'fsusblog.authoring-extension-terminal-evidence.v1',
            artifacts
        }, null, 2)}\n`);
        const receiptPath = path.join(directory, 'receipt.json');

        const result = run([
            '--root', directory,
            '--evidence', evidencePath,
            '--write-receipt', receiptPath
        ], directory);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /registered current-run producer validators are required/);
        assert.match(output(result), /terminal acceptance blocked/);
        assert.equal(existsSync(receiptPath), false);

        artifacts[0].sha256 = '0'.repeat(64);
        writeFileSync(evidencePath, `${JSON.stringify({
            schema: 'fsusblog.authoring-extension-terminal-evidence.v1',
            artifacts
        }, null, 2)}\n`);
        const tampered = run(['--root', directory, '--evidence', evidencePath], directory);
        assert.notEqual(tampered.status, 0);
        assert.match(output(tampered), /digest mismatched/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('authoring terminal matrix refuses a removed registry, suite, domain or empty chain', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-authoring-matrix-coverage-'));
    try
    {
        const original = JSON.parse(readFileSync(catalogPath, 'utf8'));
        // A complete independent override remains a valid audit input.
        const override = path.join(directory, 'catalog.json');
        writeFileSync(override, `${JSON.stringify(Object.fromEntries(Object.entries(original).reverse()))}\n`);
        const control = run(['--catalog', override]);
        assert.equal(control.status, 0, output(control));
        for (const field of ['registries', 'requiredSuites', 'terminalEvidence', 'all'])
        {
            const changed = structuredClone(original);
            if (field === 'all')
            {
                changed.registries = [];
                changed.requiredSuites = [];
                changed.terminalEvidence = [];
            }
            else
            {
                changed[field].pop();
            }
            writeFileSync(override, `${JSON.stringify(changed)}\n`);
            const evidence = path.join(directory, 'evidence.json');
            writeFileSync(evidence, `${JSON.stringify({
                schema: 'fsusblog.authoring-extension-terminal-evidence.v1', artifacts: []
            })}\n`);
            const receipt = path.join(directory, 'receipt.json');
            const result = run(['--catalog', override, '--evidence', evidence, '--write-receipt', receipt]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /canonical catalog contract drifted/);
            assert.equal(existsSync(receipt), false);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
