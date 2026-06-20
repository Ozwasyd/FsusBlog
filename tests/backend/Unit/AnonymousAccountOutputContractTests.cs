using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousAccountOutputContractTests
{
    [Fact]
    public void AuthMeEndpoint_EmitsAnonymousAccountSnapshotWithoutLegacyIdentityFields()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        string handler = ExtractEndpointBlock(source, "group.MapGet(\"/auth/me\"");

        Assert.Contains("AedsFrameType.IdentityAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteIdentityAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.Contains("UserAccountReader.ToAnonymousAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("CurrentUserSnapshotDto", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".Username", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".Role", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthProtocolContracts_DoNotExposeUsernameOrRoleAsIdentityFields()
    {
        string outputs = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Outputs",
            "ServerResponseContracts.cs");
        string userPods = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Models",
            "UserPods.cs");
        string codec = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "core",
            "Cache",
            "PodBinaryCodec.User.cs");

        string authIdentity = ExtractRecord(outputs, "public readonly record struct AuthIdentitySnapshotDto");
        string authFlow = ExtractRecord(outputs, "public readonly record struct AuthLoginFlowDto");
        string currentUser = ExtractRecord(outputs, "public readonly record struct CurrentUserSnapshotDto");
        string mfaChallenge = ExtractRecord(outputs, "public readonly record struct MfaChallengeResultDto");
        string authLoginPod = ExtractStruct(userPods, "public readonly struct AuthLoginFlowPod");
        string currentUserPod = ExtractStruct(userPods, "public readonly struct CurrentUserSnapshotPod");
        string mfaChallengePod = ExtractStruct(userPods, "public readonly struct MfaChallengeResultPod");
        string authLoginCodec = ExtractBetween(codec, "public static void WriteAuthLoginFlow", "public static void WriteCurrentUserSnapshot");
        string mfaChallengeCodec = ExtractBetween(codec, "public static void WriteMfaChallengeResult", "public static void WriteMfaPasswordProofRequest");

        foreach (string block in new[] { authIdentity, authFlow, currentUser, mfaChallenge, authLoginPod, currentUserPod, mfaChallengePod, authLoginCodec, mfaChallengeCodec })
        {
            Assert.DoesNotContain("Username", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserName", block, StringComparison.Ordinal);
            Assert.DoesNotContain("Role", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserId", block, StringComparison.Ordinal);
        }

        Assert.Contains("AccountId", authFlow, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", authFlow, StringComparison.Ordinal);
        Assert.Contains("AccountId", currentUser, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", currentUser, StringComparison.Ordinal);
        Assert.Contains("AccountId", authLoginPod, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", authLoginPod, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHandleEndpoint_UsesDedicatedFrameValidationAndProfileCommand()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        string handler = ExtractEndpointBlock(source, "group.MapPut(\"/auth/public-handle\"");

        Assert.Contains("AedsFrameType.AuthUpdatePublicHandleRequest", handler, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.TryDecodeStringMutationRequest", handler, StringComparison.Ordinal);
        Assert.Contains("contentFilterService.ValidateContent(publicHandle)", handler, StringComparison.Ordinal);
        Assert.Contains("profileCommands.UpdatePublicHandleAsync", handler, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.EmptySuccess", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateUsernameAsync", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("GenerateAccessToken", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void UserAccountReader_ProjectsSysUserAsAnonymousAccountContainer()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var user = new User
        {
            Id = 42,
            Username = "legacy-admin",
            Password = "legacy-password-hash",
            Role = "admin",
            Status = 1,
            BanReason = "limited",
            DeletedAt = deletedAt,
            PublicHandle = "Public Alice",
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled = true,
            RecoveryEnabled = true,
            MfaEnabled = true,
            AnonymousCredentialStatus = "active",
            AnonymousCredentialLevel = "strong_anonymous"
        };

        UserAccountSnapshot account = UserAccountReader.ToAccountSnapshot(user);
        Assert.Equal("active", ReadProperty<string?>(account, "AnonymousCredentialStatus"));
        Assert.Equal("strong_anonymous", ReadProperty<string?>(account, "AnonymousCredentialLevel"));

        MethodInfo? mapper = typeof(UserAccountReader).GetMethod(
            "ToAnonymousAccountSnapshot",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(mapper);

        object anonymous = mapper.Invoke(null, [account])!;
        string[] propertyNames = anonymous.GetType().GetProperties().Select(property => property.Name).ToArray();
        Assert.DoesNotContain("Username", propertyNames);
        Assert.DoesNotContain("Role", propertyNames);
        Assert.Equal(42, ReadProperty<int>(anonymous, "AccountId"));
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, ReadProperty<string>(anonymous, "IdentityKind"));
        Assert.Equal("Public Alice", ReadProperty<string?>(anonymous, "PublicHandle"));
        Assert.True(ReadProperty<bool>(anonymous, "PasskeyEnabled"));
        Assert.True(ReadProperty<bool>(anonymous, "RecoveryEnabled"));
        Assert.True(ReadProperty<bool?>(anonymous, "TotpStepUpEnabled"));
        Assert.Equal("active", ReadProperty<string?>(anonymous, "AnonymousCredentialStatus"));
        Assert.Equal("strong_anonymous", ReadProperty<string?>(anonymous, "AnonymousCredentialLevel"));
        Assert.Equal(1, ReadProperty<int>(anonymous, "Status"));
        Assert.Equal("limited", ReadProperty<string?>(anonymous, "BanReason"));
        Assert.Equal(deletedAt, ReadProperty<DateTime?>(anonymous, "DeletedAt"));
    }

    private static T? ReadProperty<T>(object instance, string propertyName)
    {
        PropertyInfo? property = instance.GetType().GetProperty(propertyName);
        Assert.NotNull(property);
        return (T?)property.GetValue(instance);
    }

    private static string ExtractEndpointBlock(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing endpoint marker {marker}");
        int end = source.IndexOf(".Require", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing endpoint terminator after {marker}");
        int nextSemicolon = source.IndexOf(';', end);
        Assert.True(nextSemicolon > end, $"Missing endpoint semicolon after {marker}");
        return source[start..(nextSemicolon + 1)];
    }

    private static string ExtractRecord(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing record marker {marker}");
        int end = source.IndexOf(";", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing record terminator after {marker}");
        return source[start..(end + 1)];
    }

    private static string ExtractStruct(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing struct marker {marker}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Missing struct body after {marker}");
        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Missing struct terminator after {marker}");
    }

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker {endMarker}");
        return source[start..end];
    }
}
