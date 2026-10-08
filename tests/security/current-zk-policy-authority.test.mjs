import assert from 'node:assert/strict';
import test from 'node:test';

const { readCurrentZkPolicySources, validateCurrentZkPolicySources } = await import(new URL('../../tools/security/check-current-zk-policy-authority.mjs', import.meta.url));

test('current product policy and verifier have separate source authorities', () =>
{
    assert.deepEqual(validateCurrentZkPolicySources(readCurrentZkPolicySources()), []);
});

test('source boundary refuses legacy switches, duplicate hash and admin verifier mutation', () =>
{
    for (const [name, source] of [
        ['ZkCommentPolicyOptions.cs', 'public bool FallbackToLegacyAnonymous { get; init; }'],
        ['ZkCommentPolicyOptions.cs', 'public string? VerifyingKeyHash { get; init; }'],
        ['ZkAnonymousProofService.cs', 'CurrentZkCommentPolicy => File.OpenRead(manifestPath);'],
        ['NativeGroth16ZkProofBackend.cs', 'configuration["NativeGroth16:VerifyingKeyHash"] ?? configuration["ZkVerifier:VerifyingKeyHash"];'],
        ['SecurityAdminPolicyService.cs', 'UpdateVerifier(ZkVerifierOptions options);']
    ])
    {
        assert.equal(validateCurrentZkPolicySources({ [name]: source }).length, 1, name);
    }
});
