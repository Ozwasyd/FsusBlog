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
}
