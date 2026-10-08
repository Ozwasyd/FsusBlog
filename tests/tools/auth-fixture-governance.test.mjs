import assert from 'node:assert/strict';
import test from 'node:test';

const { scanAccountAuthFixtureSources } = await import(new URL('../../tools/test/account-auth-fixture-source-scan.mjs', import.meta.url));


const examples = [
    ['universal-reset', 'renamedAuth.resetMfa(userId);'],
    ['universal-reset', 'unbanUser(userId);'],
    ['revoke-all', 'sessionPorts.revokeAllSessions(userId);'],
    ['full-admin-default', 'const defaultAdminPermissions = ["full"];'],
    ['direct-auth-storage', 'db.query("UPDATE sys_user SET active = true");'],
    ['token-signing', 'jwt.sign(claims, material);'],
    ['default-auth-account', 'const handle = "binaryadmin";'],
    ['security-owner-cleanup', 'cleanup.clearBanCache(userId);'],
    ['old-auth-entry', 'const script = "prepare-auth-smoke-users.mjs";'],
    ['http-private-fallback', 'fallbackToPrivateFixture();'],
    ['legacy-wrapper', 'compatAuthSessionReader();'],
    ['ordinary-secret-output', 'console.log({ accessToken });'],
    ['manual-browser-storage', 'const renamed = localStorage; renamed["set" + "Item"]("state", value);'],
    ['manual-cookie', 'const renamed = document; renamed["coo" + "kie"] = value;'],
    ['token-signing', 'const signer = jwt; signer["si" + "gn"](claims, material);']
];

for (const [ruleId, source] of examples)
{
    test(`auth source scanner detects ${ruleId}: ${source.split('(')[0]}`, () =>
    {
        const report = scanAccountAuthFixtureSources('auth-fixture', [{ path: 'tests/auth.ts', source }]);
        assert.ok(report.violations.some((item) => item.ruleId === ruleId));
        assert.equal(report.phase, 'source-pattern-scan');
        assert.equal('accepted' in report, false);
        assert.equal('receipt' in report, false);
    });
}

test('AST source scan distinguishes inert comments from calls and rejects malformed syntax', () =>
{
    const safe = scanAccountAuthFixtureSources('auth-fixture', [{ path: 'tests/auth.mjs',
        source: '// resetMfa(userId);\nconst result = await canonical.verify(binding);' }]);
    assert.deepEqual(safe.violations, []);
    const invalid = scanAccountAuthFixtureSources('auth-fixture', [{ path: 'tests/auth.mjs', source: 'const =' }]);
    assert.equal(invalid.violations[0].ruleId, 'source-syntax-unavailable');
});

test('source reports contain locations and digests without echoing detected secret content', () =>
{
    const material = 'this-value-must-never-appear-in-diagnostics';
    const report = scanAccountAuthFixtureSources('auth-fixture', [{ path: 'tests/auth.ts',
        source: `console.log({ accessToken: "${material}" });` }]);
    assert.ok(report.violations.some((item) => item.ruleId === 'ordinary-secret-output'));
    assert.equal(JSON.stringify(report).includes(material), false);
    assert.equal(report.violations[0].line, 1);
});

test('duplicate, absolute and parent-traversal input paths are refused', () =>
{
    for (const paths of [['tests/a.ts', 'tests/a.ts'], ['/tmp/a.ts'], ['tests/../a.ts']])
    {
        assert.throws(() => scanAccountAuthFixtureSources('auth-fixture', paths.map((sourcePath) => ({ path: sourcePath, source: '' }))));
    }
});
