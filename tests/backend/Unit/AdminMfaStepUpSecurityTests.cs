using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminMfaStepUpSecurityTests
{
    [Fact]
    public void MfaChallengeStart_DoesNotAutoIssueAdminSensitiveProofForNonMfaAccounts()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("IsAdminSensitiveAction(action)", source, StringComparison.Ordinal);
        Assert.Contains("MFA_REQUIRED", source, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "if (!user.Value.MfaEnabled)\r\n            {\r\n                string proofToken = await challengeService.CreateProofTokenAsync(user.Value.Id, action",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AdminUserMutations_RequireAdminSensitiveMfaProof()
    {
        string adminUsers = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AdminUsers.cs");
        string binaryCore = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");

        Assert.Contains("AdminSensitiveAction", binaryCore, StringComparison.Ordinal);
        Assert.Contains("MfaProofHeader", binaryCore, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeProofTokenAsync(userId, AdminSensitiveAction, proofToken)", binaryCore, StringComparison.Ordinal);
        Assert.True(CountOccurrences(adminUsers, "RequireAdminSensitiveStepUpAsync(httpContext, mfaChallengeService)") >= 2);
    }

    [Fact]
    public void ContentBackupExport_RequiresAdminSensitiveMfaProof()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string contentExportEndpoint = ExtractBetween(
            source,
            "group.MapGet(\"/content/export\"",
            "group.MapGet(\"/articles/{articleId:int}/export\"");

        Assert.Contains("HttpContext context", contentExportEndpoint, StringComparison.Ordinal);
        Assert.Contains("IMfaChallengeService mfaChallengeService", contentExportEndpoint, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, mfaChallengeService)", contentExportEndpoint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ValidateAdminSensitiveProof_RejectsMissingProofWithoutCacheLookup()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        var service = CreateService(cache);

        Assert.False(await service.ValidateAndConsumeProofTokenAsync(42, "admin-sensitive", string.Empty));
        Assert.False(await service.ValidateAndConsumeProofTokenAsync(42, "admin-sensitive", "   "));
        await cache.DidNotReceiveWithAnyArgs().ConsumeOnceAsync(default, string.Empty);
    }

    [Fact]
    public async Task ValidateAdminSensitiveProof_AcceptsValidProofOnceAndRejectsInvalidOrReusedProof()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        string? storedIdentity = null;
        bool consumed = false;
        cache.SetStringAsync(CachePolicyId.SecurityMfaProof, Arg.Any<string>(), "1", Arg.Any<TimeSpan?>())
            .Returns(call =>
            {
                storedIdentity = call.ArgAt<string>(1);
                return Task.CompletedTask;
            });
        cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, Arg.Any<string>())
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
        var service = CreateService(cache);

        string token = await service.CreateProofTokenAsync(42, "admin-sensitive", TimeSpan.FromMinutes(5));

        Assert.Equal($"42:admin-sensitive:{token}", storedIdentity);
        Assert.False(await service.ValidateAndConsumeProofTokenAsync(42, "admin-sensitive", "invalid-token"));
        Assert.False(await service.ValidateAndConsumeProofTokenAsync(42, "different-action", token));
        Assert.True(await service.ValidateAndConsumeProofTokenAsync(42, "admin-sensitive", token));
        Assert.False(await service.ValidateAndConsumeProofTokenAsync(42, "admin-sensitive", token));
    }

    private static MfaChallengeService CreateService(IUnifiedCache cache)
        => new(cache, NullLogger<MfaChallengeService>.Instance);

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
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            current = Directory.GetParent(current)?.FullName ?? string.Empty;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
