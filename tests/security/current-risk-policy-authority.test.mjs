import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { generateSecurityRiskPolicyCatalog, renderSecurityRiskPolicyCatalog } = await import(new URL('../../tools/contracts/generate-security-risk-policy-catalog.mjs', import.meta.url));
const { readCurrentRiskPolicySources, validateCurrentRiskPolicySources } = await import(new URL('../../tools/security/check-current-risk-policy-authority.mjs', import.meta.url));

test('current risk policy has one canonical authority across all production consumers', () =>
{
    assert.deepEqual(validateCurrentRiskPolicySources(readCurrentRiskPolicySources()), []);
    assert.doesNotThrow(() => generateSecurityRiskPolicyCatalog({ check: true }));
});

test('current risk authority refuses an old admin response and subsystem threshold bypass', () =>
{
    for (const [name, source] of [
        ['SecurityAdminModels.cs', 'record AdminResponse(SecurityRiskPolicySnapshot snapshot);'],
        ['SecurityRiskPolicyFactory.cs', 'SecurityRiskPolicy FromLegacy(AntiCrawlerPolicySnapshot snapshot);'],
        ['CrawlerRiskService.cs', 'return securityPolicy.Current.Options.RequireChallengeScore;'],
        ['SecurityAdminPolicyService.cs', 'SecurityRiskPolicy _previousRiskPolicy;'],
        ['challenge-kind-wire.ts', "case SecurityChallengeKind.Sha256PowV1: return 'sha256PowV1';"]
    ])
    {
        assert.equal(validateCurrentRiskPolicySources({ [name]: source }).length, 1, name);
    }
});

test('generated risk and challenge projections reject an omitted challenge wire member', () =>
{
    const catalog = fs.readFileSync(new URL('../../src/shared/Contracts/Security/SecurityRiskPolicyCatalog.cs', import.meta.url), 'utf8');
    const challenge = fs.readFileSync(new URL('../../src/shared/Contracts/Security/SecurityChallengeContracts.cs', import.meta.url), 'utf8');
    const mutated = challenge.replace(/SecurityChallengeKind\.Sha256PowV1\s*=>\s*"sha256PowV1"/u, 'SecurityChallengeKind.Unknown => "sha256PowV1"');
    assert.notEqual(mutated, challenge);
    assert.throws(() => renderSecurityRiskPolicyCatalog(catalog, mutated), /not exhaustive/u);
    assert.notEqual(renderSecurityRiskPolicyCatalog(catalog, challenge), renderSecurityRiskPolicyCatalog(catalog.replace('BlockScore = 90;', 'BlockScore = 91;'), challenge));
});

test('risk options keep the canonical response under generated route authority', () =>
{
    const source = fs.readFileSync(new URL('../../src/frontend/src/api/security.ts', import.meta.url), 'utf8');
    assert.match(source, /getRiskControlOptions\s*=\s*[^;]+requestSecurityBinary<SecurityRiskPolicy>\(\{ operationId: 'binary_get_admin_security_risk_control_options' \}/u);
    assert.doesNotMatch(source, /SecurityRiskPolicySnapshotV2|requestSecurityBinary<SecurityRiskPolicy>\(['"]/u);
});
