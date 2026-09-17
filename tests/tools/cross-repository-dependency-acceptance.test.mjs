import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    auditUiFreshnessCli,
    aggregateRepositoryOutcomes,
    assertFixtureBinding,
    assertReceiptReplay,
    evaluateDelegatedOwnerInvariant,
    evidenceClass,
    fixtureSchema,
    readGitBlob,
    receiptSchema,
    validateReceipt
} = await import(pathToFileURL(path.join(root, 'tools/governance/cross-repository-dependency-acceptance.mjs')));

const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/governance/cross-repository-dependency-acceptance.json'), 'utf8'));

test('fixture matrix covers every issue #1981 controlled acceptance case', () =>
{
    assert.equal(fixtures.schema, fixtureSchema);
    assert.deepEqual(new Set(fixtures.automerge.map((entry) => entry.id)), new Set([
        'patch-positive', 'minor-positive', 'major-positive', 'check-skipped', 'check-neutral',
        'check-missing', 'check-failed', 'draft', 'conflict', 'blocking-label', 'target-not-latest'
    ]));
    assert.deepEqual(new Set(fixtures.freshness.map((entry) => entry.id)), new Set([
        'current', 'latest-target-pr', 'valid-general-exception', 'oversized-general-exception',
        'valid-vulnerability-exception', 'oversized-vulnerability-exception', 'expired-exception',
        'invalid-exception', 'pr-target-not-latest', 'closed-pr-no-successor', 'registry-unavailable',
        'current-unavailable', 'current-with-exception', 'latest-pr-with-exception', 'current-with-open-pr'
    ]));
    assert.equal(fixtures.branchProtection.some((entry) => entry.id === 'bidirectional-drift'), true);
    assert.equal(fixtures.delegatedManager.some((entry) => entry.id === 'renovate-release-train-dual-owner'), true);
    assert.deepEqual(new Set(fixtures.crossRepository.map((entry) => entry.id)), new Set([
        'fsusblog-pass-fsusui-fail', 'fsusblog-fail-fsusui-pass'
    ]));
    assert.deepEqual(fixtures.blocker[0], {
        id: 'exact-one-idempotent-recovery-concurrency',
        expect: { create: 'create', idempotent: 'none', recovery: 'close', concurrentRejected: true }
    });
});

test('cross-repository aggregation fails when either repository fails', () =>
{
    assert.equal(aggregateRepositoryOutcomes({ fsusblog: true, fsusui: true }), true);
    assert.equal(aggregateRepositoryOutcomes({ fsusblog: true, fsusui: false }), false);
    assert.equal(aggregateRepositoryOutcomes({ fsusblog: false, fsusui: true }), false);
    assert.equal(aggregateRepositoryOutcomes({ fsusblog: false, fsusui: false }), false);
});

test('fixture binding rejects working-tree semantics outside the bound Blog source', () =>
{
    const source = fs.readFileSync(path.join(root, 'tests/fixtures/governance/cross-repository-dependency-acceptance.json'));
    assert.equal(assertFixtureBinding(fixtures, source), true);
    assert.throws(() => assertFixtureBinding({ ...fixtures, now: '2026-09-08T12:00:00Z' }, source),
        /acceptance_fixtures_not_source_bound/);
});

test('bounded delegated-owner invariant rejects missing, duplicate and dual ownership', () =>
{
    assert.deepEqual(evaluateDelegatedOwnerInvariant(['fsusui-release-train']), { valid: true, reasons: [] });
    assert.deepEqual(evaluateDelegatedOwnerInvariant(['renovate']), { valid: true, reasons: [] });
    assert.equal(evaluateDelegatedOwnerInvariant([]).valid, false);
    assert.ok(evaluateDelegatedOwnerInvariant(['renovate', 'renovate']).reasons.includes('delegated-manager-owner-duplicated'));
    assert.deepEqual(evaluateDelegatedOwnerInvariant(['renovate', 'fsusui-release-train']), {
        valid: false, reasons: ['delegated-manager-dual-owner']
    });
});

test('UI freshness CLI containment admits only the exact read adapter surface', () =>
{
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

test('Git object reader rejects symlinks and path traversal before materialization', () =>
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cross-repo-git-'));
    try
    {
        const run = (args) =>
        {
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

test('receipt validation is closed, digest-bound and simulation-labelled', () =>
{
    const file = { mode: '100644', objectId: 'a'.repeat(40), digest: 'sha256:' + '2'.repeat(64) };
    const source = {
        sha: 'a'.repeat(40),
        authorityDigests: { 'config/authority.json': file },
        materializedClosureDigests: { 'config/authority.json': file, 'tools/evaluator.mjs': file },
        implementationClosureDigests: { 'tools/evaluator.mjs': file }
    };
    const payload = {
        schema: receiptSchema, evidenceClass, terminalQualification: true,
        qualification: {
            mode: 'explicit-user-authorized-local-equivalent',
            hostedEvidenceClaimed: false,
            platformDisclosure: {
                observedAt: '2026-09-08T07:45:20Z',
                hostedExecutionEvidence: 'unavailable', hostedEvidenceClaimed: false,
                productionRulesetMutation: false,
                repositories: {
                    fsusblog: {
                        actionsPermission: 'enabled', rulesetId: 20602288,
                        requiredStatusChecks: [], classicBranchProtection: 'not-configured'
                    },
                    fsusui: {
                        actionsPermission: 'enabled', rulesetId: 20388040,
                        requiredStatusChecks: [], classicBranchProtection: 'not-configured'
                    }
                }
            }
        },
        fixtureDigest: 'sha256:' + '1'.repeat(64), sources: { fsusblog: source, fsusui: source },
        runtimeDependencies: { uiJson5: { packageTreeDigest: 'sha256:' + '3'.repeat(64), files: { 'package.json': 'sha256:' + '4'.repeat(64) } } },
        containment: {},
        cases: [{ id: 'fixture', pass: true, repositoryPass: { fsusblog: true, fsusui: true } }],
        repositories: [{ name: 'fsusblog', status: 'pass' }, { name: 'fsusui', status: 'pass' }],
        warnings: [], status: 'pass'
    };
    // Import-free duplicate of the public canonical digest is intentionally avoided: a malformed digest must fail.
    assert.throws(() => validateReceipt({ ...payload, receiptDigest: 'sha256:' + '0'.repeat(64) }), /receipt_digest/);
    assert.throws(() => validateReceipt({ ...payload, extra: true, receiptDigest: 'x' }), /receipt_fields/);
    assert.throws(() => validateReceipt({ ...payload, terminalQualification: false, receiptDigest: 'x' }),
        /receipt_terminal_qualification/);
    assert.throws(() => validateReceipt({ ...payload, evidenceClass: 'hosted-actions', receiptDigest: 'x' }), /receipt_header/);
    assert.throws(() => validateReceipt({ ...payload, qualification: {
        ...payload.qualification, hostedEvidenceClaimed: true
    }, receiptDigest: 'x' }), /receipt_qualification/);
    assert.throws(() => validateReceipt({ ...payload, qualification: {
        ...payload.qualification,
        platformDisclosure: { ...payload.qualification.platformDisclosure, repositories: {} }
    }, receiptDigest: 'x' }), /receipt_platform_disclosure/);
    assert.throws(() => assertReceiptReplay({ value: 1 }, { value: 2 }), /receipt_replay_mismatch/);
    assert.equal(assertReceiptReplay({ value: 1 }, { value: 1 }), true);
});
