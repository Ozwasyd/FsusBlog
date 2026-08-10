import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { projectCsrfRuntimeEvidence } from '../frontend/checks/security/csrf-browser-matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/security/check-security-matrices.mjs');
const catalogPath = path.join(root, 'security/matrices/catalog.json');
const expectedMatrixPaths = [
    'security/matrices/standards/asvs-v5.0.0.yml',
    'security/matrices/standards/wstg-v4.2.yml',
    'security/matrices/authentication/webauthn.yml',
    'security/matrices/risk-control.yml',
    'security/matrices/perception-v2.yml',
    'security/matrices/privacy-zk-comment.yml'
];

function runChecker(args = [])
{
    return spawnSync(process.execPath, [checker, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
}

function combinedOutput(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

test('security matrix governance catalog owns every canonical security matrix', () =>
{
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    assert.equal(catalog.schema, 'fsusblog.security-matrix-catalog.v1');
    assert.deepEqual(catalog.matrices.map((matrix) => matrix.path), expectedMatrixPaths);

    for (const matrix of catalog.matrices)
    {
        for (const field of ['family', 'schema', 'version', 'owner', 'checker'])
        {
            assert.equal(typeof matrix[field], 'string', `${matrix.id} must declare ${field}`);
            assert.notEqual(matrix[field].trim(), '', `${matrix.id} must declare ${field}`);
        }
        assert.equal(matrix.checker, catalog.checker);
        assert.equal(existsSync(path.join(root, matrix.path)), true, matrix.path);
    }

    for (const retiredPath of [
        'security/asvs-v5.0.0-matrix.yml',
        'security/wstg-v4.2-matrix.yml',
        'security/webauthn-matrix.yml',
        'security/risk-control-test-matrix.yml',
        'security/perception-v2-test-matrix.yml',
        'security/privacy-zk-comment-matrix.yml'
    ])
    {
        assert.equal(existsSync(path.join(root, retiredPath)), false, retiredPath);
    }

    const result = runChecker();
    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /\[security-matrix] ok/);
});

test('security matrix governance checker aggregates independent catalog failures', () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-matrix-catalog-'));
    try
    {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        catalog.matrices[0].schema = '';
        catalog.matrices[1].checker = '';
        catalog.matrices[2].validation.idPattern = '[';
        catalog.matrices[3].path = 'security/matrices/missing-risk-control.yml';
        const invalidCatalog = path.join(directory, 'catalog.json');
        writeFileSync(invalidCatalog, `${JSON.stringify(catalog, null, 2)}\n`);

        const result = runChecker(['--catalog', invalidCatalog]);
        const output = combinedOutput(result);
        assert.notEqual(result.status, 0);
        assert.match(output, /matrices\[0\] is missing schema/);
        assert.match(output, /matrices\[1\] is missing checker/);
        assert.match(output, /idPattern is invalid/);
        assert.match(output, /missing security\/matrices\/missing-risk-control\.yml/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('security matrix governance checker aggregates matrix metadata drift', () =>
{
    const fixture = mkdtempSync(path.join(tmpdir(), 'fsusblog-matrix-root-'));
    try
    {
        cpSync(path.join(root, 'security'), path.join(fixture, 'security'), { recursive: true });
        for (const entry of readdirSync(root, { withFileTypes: true }))
        {
            if (entry.name === '.git' || entry.name === 'security')
            {
                continue;
            }
            symlinkSync(
                path.join(root, entry.name),
                path.join(fixture, entry.name),
        entry.isDirectory() ? 'dir' : 'file'
            );
        }

        const asvs = path.join(fixture, expectedMatrixPaths[0]);
        const wstg = path.join(fixture, expectedMatrixPaths[1]);
        writeFileSync(asvs, readFileSync(asvs, 'utf8').replace('family: standards.asvs', 'family: standards.tampered'));
        writeFileSync(wstg, readFileSync(wstg, 'utf8').replace('schema: fsusblog.security-matrix.wstg.v1', 'schema: invalid'));

        const result = runChecker(['--root', fixture]);
        const output = combinedOutput(result);
        assert.notEqual(result.status, 0);
        assert.match(output, /asvs-v5\.0\.0\.yml family=standards\.tampered/);
        assert.match(output, /wstg-v4\.2\.yml schema=invalid/);
    }
    finally
    {
        rmSync(fixture, { recursive: true, force: true });
    }
});

const csrfRuntimeClass = 'FsusBlog.Server.Tests.Unit.SecurityHardening.CsrfOriginGuardRuntimeTests';
const csrfMethodCounts = new Map([
    ['CredentialedUnsafeRequest_RejectsMissingTrustedOrigin', 4],
    ['CredentialedUnsafeRequest_RejectsCrossSiteOrigin', 1],
    ['CredentialedUnsafeRequest_DoesNotAllowCsrfHeaderToBypassOrigin', 1],
    ['CredentialedUnsafeRequest_RejectsUntrustedOriginEvenWhenRefererTrusted', 1],
    ['CredentialedUnsafeRequest_AllowsTrustedOrigin', 1],
    ['CredentialedUnsafeRequest_AllowsTrustedRefererWhenOriginMissing', 1],
    ['SafeCookieRequest_BypassesOriginGuard', 1],
    ['UnsafeCookielessRequest_BypassesOriginGuard', 1]
]);

function csrfTrx({ omit = null, failed = null } = {})
{
    const definitions = [];
    const results = [];
    let index = 0;
    for (const [method, count] of csrfMethodCounts)
    {
        for (let occurrence = 0; occurrence < count; occurrence += 1)
        {
            if (method === omit && occurrence === count - 1)
            {
                continue;
            }
            const id = `csrf-test-${index}`;
            definitions.push(
                `<UnitTest id="${id}"><TestMethod className="${csrfRuntimeClass}" name="${method}" /></UnitTest>`);
            results.push(
                `<UnitTestResult testId="${id}" testName="${method}" outcome="${method === failed ? 'Failed' : 'Passed'}" duration="00:00:00.001" />`);
            index += 1;
        }
    }
    return `<TestRun><Results>${results.join('')}</Results><TestDefinitions>${definitions.join('')}</TestDefinitions></TestRun>`;
}

test('CSRF runtime evidence requires the complete passing TestServer matrix', () =>
{
    const evidence = projectCsrfRuntimeEvidence(csrfTrx());

    assert.equal(evidence.length, csrfMethodCounts.size);
    assert.deepEqual(
        evidence.map((entry) => [entry.method.split('.').at(-1), entry.expectedResults]),
        [...csrfMethodCounts]);
    assert.throws(
        () => projectCsrfRuntimeEvidence(
            csrfTrx({ omit: 'CredentialedUnsafeRequest_RejectsMissingTrustedOrigin' })),
        /result count mismatch/);
    assert.throws(
        () => projectCsrfRuntimeEvidence(
            csrfTrx({ failed: 'CredentialedUnsafeRequest_RejectsCrossSiteOrigin' })),
        /non-passing results/);
});
