using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using System.Reflection;

namespace FsusBlog.Server.Tests;

/// <summary>
/// Unit tests for passkey infrastructure: cache policy enumeration, registry
/// configuration, key construction, and credential summary DTO invariants.
/// Tier: fast — no external services required.
/// </summary>
public sealed class PasskeyServiceTests
{
    // ─── CachePolicyId numeric stability ─────────────────────────────────────
    // These values are embedded in persisted Redis keys; they must never drift.

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

    [Fact]
    public void CachePolicyId_PasskeyValues_AreDistinct()
    {
        Assert.NotEqual(CachePolicyId.SecurityPasskeyRegChallenge, CachePolicyId.SecurityPasskeyAuthChallenge);
    }

    // ─── CachePolicyRegistry — presence ──────────────────────────────────────

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_AreRegistered(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        bool found = registry.TryGet(id, out _);
        Assert.True(found);
    }

    // ─── CachePolicyRegistry — security requirements ──────────────────────────

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_AreMarkedSecurityCritical(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(id, out CachePolicy policy);
        Assert.True(policy.SecurityCritical);
    }

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_HaveZeroL1Ttl(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(id, out CachePolicy policy);
        Assert.Equal(TimeSpan.Zero, policy.L1Ttl);
    }

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_HaveFiveMinuteL2Ttl(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(id, out CachePolicy policy);
        Assert.Equal(TimeSpan.FromMinutes(5), policy.L2Ttl);
    }

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_HaveNoJitter(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(id, out CachePolicy policy);
        Assert.Equal(0d, policy.L2JitterRatio);
    }

    [Theory]
    [InlineData(CachePolicyId.SecurityPasskeyRegChallenge)]
    [InlineData(CachePolicyId.SecurityPasskeyAuthChallenge)]
    public void CachePolicyRegistry_PasskeyPolicies_HaveNoInvalidationTags(CachePolicyId id)
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(id, out CachePolicy policy);
        Assert.Null(policy.InvalidationTags);
    }

    // ─── CachePolicyRegistry — naming conventions ─────────────────────────────

    [Fact]
    public void CachePolicyRegistry_PasskeyRegChallenge_HasCorrectDomainAndResource()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyRegChallenge, out CachePolicy policy);
        Assert.Equal("sec", policy.Domain);
        Assert.Equal("pk-reg", policy.Resource);
    }

    [Fact]
    public void CachePolicyRegistry_PasskeyAuthChallenge_HasCorrectDomainAndResource()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyAuthChallenge, out CachePolicy policy);
        Assert.Equal("sec", policy.Domain);
        Assert.Equal("pk-auth", policy.Resource);
    }

    // ─── CachePolicy.BuildKey — passkey session key construction ──────────────

    [Fact]
    public void CachePolicy_PasskeyReg_BuildKey_ProducesExpectedKey()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyRegChallenge, out CachePolicy policy);

        string key = policy.BuildKey("AABBCCDD1122");

        Assert.Equal("fsus:sec:pk-reg:AABBCCDD1122", key);
    }

    [Fact]
    public void CachePolicy_PasskeyAuth_BuildKey_ProducesExpectedKey()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyAuthChallenge, out CachePolicy policy);

        string key = policy.BuildKey("EEFF99887766");

        Assert.Equal("fsus:sec:pk-auth:EEFF99887766", key);
    }

    [Fact]
    public void CachePolicy_PasskeyReg_BuildKey_WhitespaceIdentity_NormalizesToDefault()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyRegChallenge, out CachePolicy policy);

        string key = policy.BuildKey("  ");

        Assert.Equal("fsus:sec:pk-reg:default", key);
    }

    [Fact]
    public void CachePolicy_PasskeyReg_BuildKey_EmptyIdentity_NormalizesToDefault()
    {
        var registry = new CachePolicyRegistry();
        registry.TryGet(CachePolicyId.SecurityPasskeyRegChallenge, out CachePolicy policy);

        string key = policy.BuildKey(string.Empty);

        Assert.Equal("fsus:sec:pk-reg:default", key);
    }

    // ─── Anonymous account metadata ──────────────────────────────────────────

    [Fact]
    public void BuildAnonymousSafeMetadata_WithoutPublicHandle_UsesInternalAccountLabel()
    {
        object metadata = InvokeMetadataBuilder(
            userId: 42,
            username: "legacy-alice",
            publicHandle: null,
            anonymousIdentityModeEnabled: true);

        Assert.Equal("fsus-account-42", GetProperty<string>(metadata, "Name"));
        Assert.Equal("fsus-account-42", GetProperty<string>(metadata, "DisplayName"));
        Assert.Equal(BitConverter.GetBytes(42), GetProperty<byte[]>(metadata, "UserHandle"));
    }

    [Fact]
    public void BuildAnonymousSafeMetadata_WithPublicHandle_UsesItOnlyForDisplayName()
    {
        object metadata = InvokeMetadataBuilder(
            userId: 42,
            username: "legacy-alice",
            publicHandle: "  Alice Public  ",
            anonymousIdentityModeEnabled: true);

        Assert.Equal("fsus-account-42", GetProperty<string>(metadata, "Name"));
        Assert.Equal("Alice Public", GetProperty<string>(metadata, "DisplayName"));
    }

    [Fact]
    public void BuildAnonymousSafeMetadata_LegacyMode_PreservesExistingUsernameMetadata()
    {
        object metadata = InvokeMetadataBuilder(
            userId: 42,
            username: "legacy-alice",
            publicHandle: "Alice Public",
            anonymousIdentityModeEnabled: false);

        Assert.Equal("legacy-alice", GetProperty<string>(metadata, "Name"));
        Assert.Equal("legacy-alice", GetProperty<string>(metadata, "DisplayName"));
    }

    private static object InvokeMetadataBuilder(int userId, string username, string? publicHandle, bool anonymousIdentityModeEnabled)
    {
        MethodInfo? method = typeof(PasskeyService).GetMethod(
            "BuildAnonymousSafeMetadataForTests",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);
        return method.Invoke(null, [userId, username, publicHandle, anonymousIdentityModeEnabled])
            ?? throw new InvalidOperationException("Metadata builder returned null.");
    }

    private static T GetProperty<T>(object source, string propertyName)
    {
        PropertyInfo? property = source.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(property);
        return Assert.IsType<T>(property.GetValue(source));
    }

    // ─── PasskeyCredentialSummaryDto — value semantics ─────────────────────────

    [Fact]
    public void PasskeyCredentialSummaryDto_StoresAllPopulatedFieldsCorrectly()
    {
        var createdAt = new DateTime(2026, 4, 27, 12, 0, 0, DateTimeKind.Utc);
        var lastUsedAt = new DateTime(2026, 4, 27, 18, 30, 0, DateTimeKind.Utc);

        var dto = new PasskeyCredentialSummaryDto(
            Id: 42,
            DeviceFriendlyName: "MacBook Touch ID",
            CreatedAt: createdAt,
            LastUsedAt: lastUsedAt,
            AaGuid: "aaguid-test-value",
            BackupEligible: true,
            BackupState: true);

        Assert.Equal(42, dto.Id);
        Assert.Equal("MacBook Touch ID", dto.DeviceFriendlyName);
        Assert.Equal(createdAt, dto.CreatedAt);
        Assert.Equal(lastUsedAt, dto.LastUsedAt);
        Assert.Equal("aaguid-test-value", dto.AaGuid);
        Assert.True(dto.BackupEligible);
        Assert.True(dto.BackupState);
    }

    [Fact]
    public void PasskeyCredentialSummaryDto_AllowsNullOptionalFields()
    {
        var dto = new PasskeyCredentialSummaryDto(
            Id: 1,
            DeviceFriendlyName: null,
            CreatedAt: DateTime.UtcNow,
            LastUsedAt: null,
            AaGuid: "00000000-0000-0000-0000-000000000000",
            BackupEligible: false,
            BackupState: false);

        Assert.Null(dto.DeviceFriendlyName);
        Assert.Null(dto.LastUsedAt);
        Assert.False(dto.BackupEligible);
        Assert.False(dto.BackupState);
    }

    [Fact]
    public void PasskeyCredentialSummaryDto_StructuralEquality_IdenticalInstancesAreEqual()
    {
        var created = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        var a = new PasskeyCredentialSummaryDto(7, "iPhone FaceID", created, null, "aaguid-abc", true, false);
        var b = new PasskeyCredentialSummaryDto(7, "iPhone FaceID", created, null, "aaguid-abc", true, false);

        Assert.Equal(a, b);
    }

    [Fact]
    public void PasskeyCredentialSummaryDto_StructuralEquality_DifferentIdProducesInequality()
    {
        var created = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        var a = new PasskeyCredentialSummaryDto(1, "Key A", created, null, "aaguid-abc", false, false);
        var b = new PasskeyCredentialSummaryDto(2, "Key A", created, null, "aaguid-abc", false, false);

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void PasskeyCredentialSummaryDto_BackupEligibleAndBackupState_AreIndependent()
    {
        // BackupEligible=true but BackupState=false is a valid, distinct state
        var dto = new PasskeyCredentialSummaryDto(
            Id: 1,
            DeviceFriendlyName: null,
            CreatedAt: DateTime.UtcNow,
            LastUsedAt: null,
            AaGuid: "guid",
            BackupEligible: true,
            BackupState: false);

        Assert.True(dto.BackupEligible);
        Assert.False(dto.BackupState);
    }

    [Fact]
    public void PasskeyCredentialSummaryDto_WithLastUsedAt_ReportsCorrectDate()
    {
        var lastUsed = new DateTime(2026, 4, 27, 10, 0, 0, DateTimeKind.Utc);

        var dto = new PasskeyCredentialSummaryDto(1, "YubiKey", DateTime.UtcNow, lastUsed, "guid", true, true);

        Assert.Equal(lastUsed, dto.LastUsedAt);
        Assert.True(dto.BackupState);
    }
}
