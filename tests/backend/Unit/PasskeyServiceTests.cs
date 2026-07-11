using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using SqlSugar;

namespace FsusBlog.Server.Tests;

/// <summary>
/// Fast behavioral contracts for Passkey cache policies, anonymous-safe account
/// metadata, credential ownership, and entity mapping. PostgreSQL concurrency
/// behavior lives in <c>PasskeySignCountConcurrencyTests</c>.
/// </summary>
public sealed class PasskeyServiceTests
{
    [Fact]
    public void CachePolicyId_SecurityPasskeyRegChallenge_HasStableNumericValue()
    {
        Assert.Equal(24, (int)CachePolicyId.SecurityPasskeyRegChallenge);
    }

    [Fact]
    public void CachePolicyId_SecurityPasskeyAuthChallenge_HasStableNumericValue()
    {
        Assert.Equal(25, (int)CachePolicyId.SecurityPasskeyAuthChallenge);
    }

    public static TheoryData<CachePolicyId, string, string> PasskeyPolicyCases => new()
    {
        { CachePolicyId.SecurityPasskeyRegChallenge, "sec", "pk-reg" },
        { CachePolicyId.SecurityPasskeyAuthChallenge, "sec", "pk-auth" }
    };

    [Theory]
    [MemberData(nameof(PasskeyPolicyCases))]
    public void CachePolicyRegistry_PasskeyPolicies_PreserveSecurityContract(
        CachePolicyId id,
        string expectedDomain,
        string expectedResource)
    {
        var registry = new CachePolicyRegistry();

        Assert.True(registry.TryGet(id, out CachePolicy policy));
        Assert.Equal(id, policy.Id);
        Assert.Equal(expectedDomain, policy.Domain);
        Assert.Equal(expectedResource, policy.Resource);
        Assert.True(policy.SecurityCritical);
        Assert.Equal(TimeSpan.Zero, policy.L1Ttl);
        Assert.Equal(TimeSpan.FromMinutes(5), policy.L2Ttl);
        Assert.Equal(0d, policy.L2JitterRatio);
        Assert.Null(policy.InvalidationTags);
    }

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge, "AABBCCDD1122", "fsus:sec:pk-reg:AABBCCDD1122")]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge, "EEFF99887766", "fsus:sec:pk-auth:EEFF99887766")]
    public void CachePolicy_PasskeyChallenge_BuildKeyUsesPolicyDomainAndResource(
        CachePolicyId id,
        string identity,
        string expectedKey)
    {
        var registry = new CachePolicyRegistry();
        Assert.True(registry.TryGet(id, out CachePolicy policy));

        Assert.Equal(expectedKey, policy.BuildKey(identity));
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    public void CachePolicy_PasskeyChallenge_EmptyIdentityNormalizesToDefault(string identity)
    {
        var registry = new CachePolicyRegistry();
        Assert.True(registry.TryGet(CachePolicyId.SecurityPasskeyRegChallenge, out CachePolicy policy));

        Assert.Equal("fsus:sec:pk-reg:default", policy.BuildKey(identity));
    }

    public static TheoryData<string?, bool, string, string, int> AnonymousMetadataCases => new()
    {
        { null, true, "fsus-anonymous-account", "Anonymous account", 0x42 },
        { "  Alice Public  ", true, "fsus-anonymous-account", "Alice Public", 0x24 },
        { "Alice Public", false, "Alice Public", "Alice Public", 0x11 }
    };

    [Theory]
    [MemberData(nameof(AnonymousMetadataCases))]
    public void BuildAnonymousSafeMetadata_MapsAccountLabelsAndPreservesStoredRandomHandle(
        string? publicHandle,
        bool anonymousIdentityModeEnabled,
        string expectedName,
        string expectedDisplayName,
        int handleSeed)
    {
        byte[] storedHandle = StableHandle((byte)handleSeed);

        PasskeyAccountMetadata metadata = PasskeyService.BuildAnonymousSafeMetadataForTests(
            publicHandle,
            anonymousIdentityModeEnabled,
            storedHandle);

        Assert.Equal(expectedName, metadata.Name);
        Assert.Equal(expectedDisplayName, metadata.DisplayName);
        Assert.Equal(storedHandle, metadata.UserHandle);
        Assert.NotSame(storedHandle, metadata.UserHandle);
    }

    [Fact]
    public void CredentialOwnership_AcceptsStoredRandomHandleAndRejectsInternalAccountIdDerivation()
    {
        byte[] storedHandle = StableHandle(0x51);
        string storedHandleText = EncodeBase64Url(storedHandle);

        Assert.True(PasskeyService.IsUserHandleOwnerOfCredentialForTests(storedHandle, storedHandleText));
        Assert.False(PasskeyService.IsUserHandleOwnerOfCredentialForTests(BitConverter.GetBytes(42), storedHandleText));
        Assert.False(PasskeyService.IsUserHandleOwnerOfCredentialForTests(storedHandle, null));
    }

    [Fact]
    public void PasskeyCredential_UsesAccountIdColumnAndIndexWithoutLegacyUserId()
    {
        PropertyInfo accountId = typeof(PasskeyCredential).GetProperty(nameof(PasskeyCredential.AccountId))
            ?? throw new InvalidOperationException("PasskeyCredential.AccountId is required.");

        Assert.Null(typeof(PasskeyCredential).GetProperty("UserId"));
        Assert.Equal("account_id", accountId.GetCustomAttribute<SugarColumn>()?.ColumnName);

        SugarIndexAttribute[] indexes = typeof(PasskeyCredential)
            .GetCustomAttributes<SugarIndexAttribute>()
            .ToArray();
        Assert.Contains(indexes, static index => index.IndexName == "idx_passkey_account_id");
        Assert.DoesNotContain(indexes, static index => index.IndexName == "idx_passkey_user_id");
        Assert.True(typeof(PasskeyCredential).GetProperty(nameof(PasskeyCredential.RowVersion))
            ?.GetCustomAttribute<SugarColumn>()?.IsIgnore);
    }

    private static byte[] StableHandle(byte seed)
    {
        byte[] handle = new byte[32];
        Array.Fill(handle, seed);
        return handle;
    }

    private static string EncodeBase64Url(byte[] value)
        => Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}
