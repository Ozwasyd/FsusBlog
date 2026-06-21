using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Entities;
using SqlSugar;
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
    public void BuildAnonymousSafeMetadata_WithoutPublicHandle_UsesGenericAnonymousLabelAndStoredHandle()
    {
        byte[] storedHandle = StableHandle(0x42);

        object metadata = InvokeMetadataBuilder(
            username: "legacy-alice",
            publicHandle: null,
            anonymousIdentityModeEnabled: true,
            stableUserHandle: storedHandle);

        Assert.Equal("fsus-anonymous-account", GetProperty<string>(metadata, "Name"));
        Assert.Equal("Anonymous account", GetProperty<string>(metadata, "DisplayName"));
        Assert.Equal(storedHandle, GetProperty<byte[]>(metadata, "UserHandle"));
        Assert.NotEqual(BitConverter.GetBytes(42), GetProperty<byte[]>(metadata, "UserHandle"));
        Assert.DoesNotContain("42", GetProperty<string>(metadata, "Name"), StringComparison.Ordinal);
        Assert.DoesNotContain("42", GetProperty<string>(metadata, "DisplayName"), StringComparison.Ordinal);
    }

    [Fact]
    public void BuildAnonymousSafeMetadata_WithPublicHandle_UsesItOnlyForDisplayName()
    {
        byte[] storedHandle = StableHandle(0x24);

        object metadata = InvokeMetadataBuilder(
            username: "legacy-alice",
            publicHandle: "  Alice Public  ",
            anonymousIdentityModeEnabled: true,
            stableUserHandle: storedHandle);

        Assert.Equal("fsus-anonymous-account", GetProperty<string>(metadata, "Name"));
        Assert.Equal("Alice Public", GetProperty<string>(metadata, "DisplayName"));
        Assert.Equal(storedHandle, GetProperty<byte[]>(metadata, "UserHandle"));
    }

    [Fact]
    public void BuildAnonymousSafeMetadata_LegacyMode_PreservesExistingUsernameMetadata()
    {
        byte[] storedHandle = StableHandle(0x11);

        object metadata = InvokeMetadataBuilder(
            username: "legacy-alice",
            publicHandle: "Alice Public",
            anonymousIdentityModeEnabled: false,
            stableUserHandle: storedHandle);

        Assert.Equal("legacy-alice", GetProperty<string>(metadata, "Name"));
        Assert.Equal("legacy-alice", GetProperty<string>(metadata, "DisplayName"));
        Assert.Equal(storedHandle, GetProperty<byte[]>(metadata, "UserHandle"));
    }

    [Fact]
    public void BuildAnonymousSafeMetadata_DifferentStoredHandlesRemainDistinct()
    {
        object first = InvokeMetadataBuilder(
            username: null,
            publicHandle: null,
            anonymousIdentityModeEnabled: true,
            stableUserHandle: StableHandle(0x31));
        object second = InvokeMetadataBuilder(
            username: null,
            publicHandle: null,
            anonymousIdentityModeEnabled: true,
            stableUserHandle: StableHandle(0x32));

        Assert.NotEqual(GetProperty<byte[]>(first, "UserHandle"), GetProperty<byte[]>(second, "UserHandle"));
    }

    [Fact]
    public void IsUserHandleOwnerOfCredential_UsesStoredRandomHandle()
    {
        byte[] storedHandle = StableHandle(0x51);
        string storedHandleText = EncodeBase64Url(storedHandle);

        Assert.True(PasskeyService.IsUserHandleOwnerOfCredentialForTests(storedHandle, storedHandleText));
        Assert.False(PasskeyService.IsUserHandleOwnerOfCredentialForTests(BitConverter.GetBytes(42), storedHandleText));
        Assert.False(PasskeyService.IsUserHandleOwnerOfCredentialForTests(storedHandle, null));
    }

    [Fact]
    public void PasskeyService_DoesNotDeriveUserHandleOrLabelsFromInternalUserId()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");

        Assert.DoesNotContain("BitConverter.GetBytes(userId)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus-account-{userId}", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyRegisterBeginContract_UsesSafeAccountHandleAndDisplayLabels()
    {
        string userPods = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Models/UserPods.cs");
        string readModels = BackendTestPaths.ReadAllTextFromRoot("src/core/Mapping/Models/ReadModels.cs");
        string passkeyCodec = BackendTestPaths.ReadAllTextFromRoot("src/core/Cache/PodBinaryCodec.Passkey.cs");
        string passkeyService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");

        string podBlock = ExtractBlock(userPods, "public readonly struct PasskeyRegisterBeginPod");
        string modelBlock = ExtractBlock(readModels, "public sealed record class PasskeyRegisterBeginCoreModel");
        string codecBlock = ExtractBlock(passkeyCodec, "public static void WritePasskeyRegisterBegin");
        string decodeBlock = ExtractBlock(passkeyCodec, "public static bool TryDecodePasskeyRegisterBegin");
        string serviceBeginBlock = ExtractBlock(passkeyService, "private static PasskeyRegisterBeginCoreModel ToRegisterBeginCore");
        string serviceOptionsBlock = ExtractBlock(passkeyService, "private static CredentialCreateOptions ToCredentialCreateOptions");

        Assert.Contains("AccountName", podBlock, StringComparison.Ordinal);
        Assert.Contains("AccountDisplayName", podBlock, StringComparison.Ordinal);
        Assert.Contains("AccountHandle", podBlock, StringComparison.Ordinal);
        Assert.Contains("AccountName", modelBlock, StringComparison.Ordinal);
        Assert.Contains("AccountDisplayName", modelBlock, StringComparison.Ordinal);
        Assert.Contains("AccountHandle", modelBlock, StringComparison.Ordinal);

        foreach (string block in new[] { podBlock, modelBlock, codecBlock, decodeBlock, serviceBeginBlock, serviceOptionsBlock })
        {
            Assert.DoesNotContain("UserName", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserDisplayName", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserId", block, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void PasskeyCredential_UsesAccountIdColumnAndIndex()
    {
        PropertyInfo accountId = typeof(PasskeyCredential).GetProperty("AccountId")
            ?? throw new InvalidOperationException("PasskeyCredential.AccountId is required.");

        Assert.Null(typeof(PasskeyCredential).GetProperty("UserId"));
        Assert.Equal("account_id", accountId.GetCustomAttribute<SugarColumn>()?.ColumnName);

        SugarIndexAttribute[] indexes = typeof(PasskeyCredential).GetCustomAttributes<SugarIndexAttribute>().ToArray();
        Assert.Contains(indexes, static index => index.IndexName == "idx_passkey_account_id");
        Assert.DoesNotContain(indexes, static index => index.IndexName == "idx_passkey_user_id");
    }

    [Fact]
    public void PasskeyService_SourceUsesAccountIdForCredentialOwnership()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");

        Assert.Contains("int accountId", source, StringComparison.Ordinal);
        Assert.Contains("c.AccountId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PasskeyCredential.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("c.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("storedCred.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId = userId", source, StringComparison.Ordinal);
    }

    private static object InvokeMetadataBuilder(
        string? username,
        string? publicHandle,
        bool anonymousIdentityModeEnabled,
        byte[] stableUserHandle)
    {
        MethodInfo? method = typeof(PasskeyService).GetMethod(
            "BuildAnonymousSafeMetadataForTests",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);
        return method.Invoke(null, [username, publicHandle, anonymousIdentityModeEnabled, stableUserHandle])
            ?? throw new InvalidOperationException("Metadata builder returned null.");
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

    private static string ExtractBlock(string source, string startToken)
    {
        int start = source.IndexOf(startToken, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start token: {startToken}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Missing block start for token: {startToken}");

        int depth = 0;
        for (int index = braceStart; index < source.Length; index++)
        {
            depth += source[index] switch
            {
                '{' => 1,
                '}' => -1,
                _ => 0
            };

            if (depth == 0)
            {
                return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"Missing block end for token: {startToken}");
    }
}
