using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using Fido2NetLib;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminMfaStepUpSecurityTests
{
    [Fact]
    public void AdminStepUpEndpoints_UseAdminPasskeyApiAndAdminManagePolicy()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string block = ExtractBetween(
            endpoints,
            "MapPost(\"/auth/admin/step-up/passkey/begin\"",
            "group.MapPost(\"/auth/admin/logout\"");

        Assert.Contains("MapPost(\"/auth/admin/step-up/passkey/begin\"", block, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/auth/admin/step-up/passkey/complete\"", block, StringComparison.Ordinal);
        Assert.Contains("BeginAdminStepUpAssertionAsync", block, StringComparison.Ordinal);
        Assert.Contains("CompleteAdminStepUpAssertionAsync", block, StringComparison.Ordinal);
        Assert.Contains(".RequireAdminPermission(AdminPermissions.AdminManage)", block, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.PasskeyLoginBegin", block, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.MfaChallengeResult", block, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminSensitiveMutations_UseAdminStepUpProofInsteadOfUserMfa()
    {
        string adminUsers = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AdminUsers.cs");
        string binaryCore = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");
        string authoring = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string security = ReadRepoFile("src/backend/Modules/Endpoints/SecurityEndpoints.cs");

        Assert.Contains("AdminSensitiveAction", binaryCore, StringComparison.Ordinal);
        Assert.Contains("MfaProofHeader", binaryCore, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", binaryCore, StringComparison.Ordinal);
        Assert.Contains("adminPrincipalId", binaryCore, StringComparison.Ordinal);
        Assert.Contains("adminSessionId", binaryCore, StringComparison.Ordinal);
        Assert.DoesNotContain("IsMfaVerified()", binaryCore, StringComparison.Ordinal);
        Assert.True(CountOccurrences(adminUsers, "RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)") >= 2);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals)", authoring, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals)", security, StringComparison.Ordinal);
        Assert.DoesNotContain("RequireAdminSensitiveStepUpAsync(context, mfaChallengeService)", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("RequireAdminSensitiveStepUpAsync(context, mfaChallengeService)", security, StringComparison.Ordinal);
    }

    [Fact]
    public void OrdinaryMfaChallengeStart_DoesNotIssueAdminSensitiveProof()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string mfaStart = ExtractBetween(
            source,
            "MapPost(\"/auth/mfa/challenge/start\"",
            "group.MapPost(\"/auth/mfa/challenge\"");

        Assert.Contains("IsAdminSensitiveAction(action)", mfaStart, StringComparison.Ordinal);
        Assert.Contains("MFA_REQUIRED", mfaStart, StringComparison.Ordinal);
        Assert.True(
            mfaStart.IndexOf("IsAdminSensitiveAction(action)", StringComparison.Ordinal) <
            mfaStart.IndexOf("CreateProofTokenAsync(user.Value.Id, action", StringComparison.Ordinal));
    }

    [Fact]
    public void ContentBackupExport_RequiresAdminSensitiveAdminProof()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string contentExportEndpoint = ExtractBetween(
            source,
            "group.MapGet(\"/content/export\"",
            "group.MapGet(\"/articles/{articleId:int}/export\"");

        Assert.Contains("HttpContext context", contentExportEndpoint, StringComparison.Ordinal);
        Assert.Contains("IAdminPrincipalService adminPrincipals", contentExportEndpoint, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals)", contentExportEndpoint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AdminStepUpProof_RejectsMissingProofWithoutCacheLookup()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        AdminPrincipalService service = CreateAdminService(cache);

        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", string.Empty, CancellationToken.None));
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", "   ", CancellationToken.None));
        await cache.DidNotReceiveWithAnyArgs().ConsumeOnceAsync(default, string.Empty, default);
    }

    [Fact]
    public async Task AdminStepUpProof_BindsToAdminPrincipalSessionActionAndConsumesOnce()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        string? storedIdentity = null;
        bool consumed = false;
        cache.SetStringAsync(CachePolicyId.SecurityMfaProof, Arg.Any<string>(), "1", Arg.Any<TimeSpan?>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                storedIdentity = call.ArgAt<string>(1);
                return Task.CompletedTask;
            });
        cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string identity = call.ArgAt<string>(1);
                if (!string.Equals(identity, storedIdentity, StringComparison.Ordinal) || consumed)
                {
                    return Task.FromResult(false);
                }

                consumed = true;
                return Task.FromResult(true);
            });
        AdminPrincipalService service = CreateAdminService(cache);

        string token = await service.CreateAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", TimeSpan.FromMinutes(5), CancellationToken.None);

        Assert.Equal($"admin:42:sid-1:admin-sensitive:{token}", storedIdentity);
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", "invalid-token", CancellationToken.None));
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "other-session", "admin-sensitive", token, CancellationToken.None));
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(7, "sid-1", "admin-sensitive", token, CancellationToken.None));
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "different-action", token, CancellationToken.None));
        Assert.True(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", token, CancellationToken.None));
        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", token, CancellationToken.None));
    }

    [Fact]
    public async Task OrdinaryUserMfaProof_CannotSatisfyAdminStepUp()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call => Task.FromResult(string.Equals(
                call.ArgAt<string>(1),
                "42:admin-sensitive:ordinary-proof",
                StringComparison.Ordinal)));
        AdminPrincipalService service = CreateAdminService(cache);

        Assert.False(await service.ValidateAndConsumeAdminStepUpProofTokenAsync(42, "sid-1", "admin-sensitive", "ordinary-proof", CancellationToken.None));
    }

    private static AdminPrincipalService CreateAdminService(IUnifiedCache cache)
        => new(
            Substitute.For<IFido2>(),
            Substitute.For<ISqlSugarClient>(),
            cache,
            Substitute.For<IJwtHelper>(),
            new ConfigurationBuilder().Build(),
            NullLogger<AdminPrincipalService>.Instance);

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        int end = source.IndexOf(endMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        Assert.True(end > start, $"Missing end marker after {startMarker}: {endMarker}");
        return source[start..end];
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
