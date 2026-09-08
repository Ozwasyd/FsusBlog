import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    auditUiFreshnessCli,
    assertReceiptReplay,
    evidenceClass,
    fixtureSchema,
    readGitBlob,
    receiptSchema,
    validateReceipt
} from '../../tools/governance/cross-repository-dependency-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/governance/cross-repository-dependency-acceptance.json'), 'utf8'));

test('fixture matrix covers every issue #1981 controlled acceptance case', () => {
    assert.equal(fixtures.schema, fixtureSchema);
    assert.deepEqual(new Set(fixtures.automerge.map((entry) => entry.id)), new Set([
        'patch-positive', 'minor-positive', 'major-positive', 'check-skipped', 'check-neutral',
        'check-missing', 'check-failed', 'draft', 'conflict', 'blocking-label', 'target-not-latest'
    ]));
    assert.deepEqual(new Set(fixtures.freshness.map((entry) => entry.id)), new Set([
        'current', 'latest-target-pr', 'valid-general-exception', 'oversized-general-exception',
        'valid-vulnerability-exception', 'oversized-vulnerability-exception', 'expired-exception',
        'invalid-exception', 'pr-target-not-latest', 'closed-pr-no-successor', 'registry-unavailable'
    ]));
    assert.equal(fixtures.branchProtection.some((entry) => entry.id === 'bidirectional-drift'), true);
    assert.equal(fixtures.delegatedManager.some((entry) => entry.id === 'renovate-release-train-dual-owner'), true);
});

test('UI freshness CLI containment admits only the exact read adapter surface', () => {
    const cli = fs.readFileSync(path.join(root, 'tests/fixtures/governance/ui-freshness-cli-safety.txt'), 'utf8');
    const writer = "const resolved = path.resolve(root, outputPath); mkdirSync(path.dirname(resolved), { recursive: true }); writeFileSync(resolved, '{}');";
    assert.deepEqual(auditUiFreshnessCli(cli, writer), []);
    assert.ok(auditUiFreshnessCli(`${cli}\nfetch('https://example.invalid')`, writer).some((entry) => entry.startsWith('forbidden-network')));
    assert.ok(auditUiFreshnessCli(cli.replace('npm view', '/usr/bin/npm view'), writer).includes('exec-command-allowlist-drift'));
    assert.ok(auditUiFreshnessCli(cli.replace('npm view', 'wget'), writer).includes('exec-command-allowlist-drift'));
    assert.ok(auditUiFreshnessCli(`${cli}\nexecFileSync('gh',['api','--method','POST'])`, writer)
        .some((entry) => entry.startsWith('forbidden-network-or-process')));
    assert.ok(auditUiFreshnessCli(`${cli}\nwriteFileSync('/tmp/escape','x')`, writer)
        .some((entry) => entry.startsWith('forbidden-network-or-process')));
});

test('Git object reader rejects symlinks and path traversal before materialization', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cross-repo-git-'));
    try
    {
        const run = (args) => {
            const result = spawnSync('git', args, {
                cwd: repository, encoding: 'utf8',
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: 'Acceptance Fixture', GIT_AUTHOR_EMAIL: 'acceptance@example.invalid',
                    GIT_COMMITTER_NAME: 'Acceptance Fixture', GIT_COMMITTER_EMAIL: 'acceptance@example.invalid'
                }
            });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        };
        run(['init', '--quiet']);
        fs.writeFileSync(path.join(repository, 'regular.txt'), 'bound\n');
        fs.symlinkSync('regular.txt', path.join(repository, 'link.txt'));
        run(['add', 'regular.txt', 'link.txt']);
        run(['commit', '--quiet', '-m', 'fixture']);
        const sha = run(['rev-parse', 'HEAD']);
        assert.equal(readGitBlob(repository, sha, 'regular.txt').content.toString(), 'bound\n');
        assert.throws(() => readGitBlob(repository, sha, 'link.txt'), /not_regular_blob/);
        assert.throws(() => readGitBlob(repository, sha, '../regular.txt'), /unsafe_git_path/);
    }
    finally
    {
        fs.rmSync(repository, { recursive: true, force: true });
    }
});

test('receipt validation is closed, digest-bound and simulation-labelled', () => {
    const payload = {
        schema: receiptSchema, evidenceClass, terminalQualification: false,
        fixtureDigest: 'sha256:' + '1'.repeat(64), sources: {}, runtimeDependencies: {}, containment: {},
        cases: [], repositories: [], warnings: [], status: 'pass'
    };
    // Import-free duplicate of the public canonical digest is intentionally avoided: a malformed digest must fail.
    assert.throws(() => validateReceipt({ ...payload, receiptDigest: 'sha256:' + '0'.repeat(64) }), /receipt_digest/);
    assert.throws(() => validateReceipt({ ...payload, extra: true, receiptDigest: 'x' }), /receipt_fields/);
    assert.throws(() => validateReceipt({ ...payload, terminalQualification: true, receiptDigest: 'x' }), /receipt_header/);
    assert.throws(() => assertReceiptReplay({ value: 1 }, { value: 2 }), /receipt_replay_mismatch/);
    assert.equal(assertReceiptReplay({ value: 1 }, { value: 1 }), true);
});
