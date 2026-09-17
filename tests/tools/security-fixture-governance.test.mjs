import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {buildSecurityFixtureAcceptance, runSecurityFixtureMutations, scanSecurityFixtureGovernance} = await import(new URL('../../tools/test/check-security-fixture-governance.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = 'tests/frontend/support/session-fixtures.mjs';
const original = readFileSync(path.join(root, target), 'utf8');

function canonical(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digest(value)
{
    return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

test('security fixture scanner accepts the exact owner and zero active legacy paths', () =>
{
    const result = scanSecurityFixtureGovernance();
    assert.deepEqual(result.violations, []);
    assert.match(result.ownershipDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('admin auth fixture advances the projection version when it rotates a session token', () =>
{
    assert.match(
        original,
        /ON CONFLICT \(sessionid\) DO UPDATE SET[\s\S]*accesstokenhash = EXCLUDED\.accesstokenhash,[\s\S]*validationversion = admin_session\.validationversion \+ 1,/u
    );
});

test('security fixture governance kills every parent counterexample class', () =>
{
    const mutations = runSecurityFixtureMutations();
    assert.equal(mutations.length >= 10, true);
    assert.equal(mutations.every((item) => item.killed && item.ruleIds.length > 0), true);
});

for (const [name, source, ruleId] of [
    ['global reset flag', 'FSUSBLOG_RESET_SECURITY_TEST_STATE=1', 'legacy-reset-flag'],
    ['renamed reset wrapper', 'const ResetSecurityTestState = () => {}', 'legacy-reset-symbol'],
    ['wildcard Redis cleanup', "redis-cli --scan --pattern '*pow-risk:*' | xargs redis-cli DEL", 'wildcard-redis-cleanup'],
    ['global risk delete', 'DELETE FROM security_risk_event;', 'global-security-delete'],
    ['auth ban cleanup', 'banreason = NULL', 'auth-ban-side-effect'],
    ['auth credential cleanup', 'clearFixtureAnonymousCredentialIssuanceAudit(userId)', 'auth-credential-side-effect'],
    ['request-loop threshold', 'for (let attempt = 0; attempt < 30; attempt += 1) { await fetchChallenge() }', 'threshold-request-loop'],
    ['threshold override', 'overrideThreshold = true', 'threshold-override'],
    ['production secret', "productionToken = 'secret'", 'raw-production-secret']
])
{
    test(`security scanner rejects ${name}`, () =>
    {
        const result = scanSecurityFixtureGovernance({
            sourceOverrides: new Map([[target, `${original}\n${source}\n`]])
        });
        assert.equal(result.violations.some((item) => item.ruleId === ruleId && item.file === target), true);
    });
}

test('terminal acceptance receipt is warning-free and fully recomputable', () =>
{
    const receipt = buildSecurityFixtureAcceptance();
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(receipt.violations, []);
    assert.deepEqual(receipt.privacyLeaks, []);
    assert.deepEqual(receipt.warnings, []);
    assert.equal(receipt.mutations.every((item) => item.killed), true);
    const body = { ...receipt };
    delete body.contentDigest;
    assert.equal(receipt.contentDigest, digest(body));

    const tampered = structuredClone(receipt);
    tampered.warnings.push('unknown');
    const tamperedBody = { ...tampered };
    delete tamperedBody.contentDigest;
    assert.notEqual(tampered.contentDigest, digest(tamperedBody));
});
