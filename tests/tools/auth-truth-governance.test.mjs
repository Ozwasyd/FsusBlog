import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkAccountLocaleFixtureGovernance } = await import(new URL('../../tools/test/check-account-locale-fixture-governance.mjs', import.meta.url));
const { checkAuthFixtureGovernance } = await import(new URL('../../tools/test/check-auth-fixture-governance.mjs', import.meta.url));
const { checkAuthTruthGovernance } = await import(new URL('../../tools/test/check-auth-truth-governance.mjs', import.meta.url));
const { scanAccountAuthFixtureSources } = await import(new URL('../../tools/test/account-auth-fixture-source-scan.mjs', import.meta.url));


const examples = [
    ['token-signing', 'jwt.sign(claims, key);'],
    ['direct-auth-storage', 'db.query("INSERT INTO step_up_proof VALUES (1)");'],
    ['placeholder-credential', 'const kind = "placeholder_credential";'],
    ['legacy-strength', 'const kind = "legacy_mfa";'],
    ['claim-only-step-up', 'const stepUpVerified = true;'],
    ['permission-second-map', 'const permissionMap = {};'],
    ['duration-hardcode', 'const cookieMaxAge = 2592000;'],
    ['truth-inference', 'truthFromFilename(file);'],
    ['refresh-context-rebuild', 'context.refreshAuthTime = now;'],
    ['cross-truth-root', 'const storage = sharedCanonicalLegacyRoot;'],
    ['legacy-wrapper', 'compatAuthTruthReader();'],
    ['ordinary-secret-output', 'console.error({ proofSecret });']
];

for (const [ruleId, source] of examples)
{
    test(`auth truth source scanner detects ${ruleId}: ${source.split('(')[0]}`, () =>
    {
        const report = scanAccountAuthFixtureSources('auth-truth', [{ path: 'tests/truth.ts', source }]);
        assert.ok(report.violations.some((item) => item.ruleId === ruleId));
    });
}

test('all checkers refuse terminal acceptance when actual cleanup authorities are absent', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'account-auth-source-scan-'));
    try
    {
        execFileSync('git', ['init', '--quiet', root]);
        writeFileSync(path.join(root, 'source.ts'), 'const observed = canonical.read(binding);\n');
        for (const checker of [checkAccountLocaleFixtureGovernance, checkAuthFixtureGovernance, checkAuthTruthGovernance])
        {
            const report = checker(root);
            assert.equal(report.status, 'blocked');
            assert.deepEqual(report.violations, []);
            assert.ok(report.blockers.some((blocker) => blocker.code === 'canonical-cleanup-completion-verifier-unavailable'));
            assert.ok(report.blockers.some((blocker) => blocker.code === 'ownership-or-consumer-inventory-unavailable'));
            assert.ok(report.blockers.every((blocker) => !('dependencyIssue' in blocker)));
            assert.equal('receiptDigest' in report, false);
        }
        symlinkSync('/does-not-exist', path.join(root, 'external.ts'));
        assert.ok(checkAuthTruthGovernance(root).blockers.some((item) => item.code === 'source-not-bounded-regular-file'));
        mkdirSync(path.join(root, 'nested'));
        writeFileSync(path.join(root, 'nested/source.ts'), 'const value = 1;');
        execFileSync('git', ['add', 'nested/source.ts'], { cwd: root });
        renameSync(path.join(root, 'nested'), path.join(root, 'actual'));
        symlinkSync(path.join(root, 'actual'), path.join(root, 'nested'));
        assert.ok(checkAuthTruthGovernance(root).blockers.some((item) => item.code === 'source-ancestor-not-regular-directory'));
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});
