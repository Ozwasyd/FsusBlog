using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
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
    public void AdminStepUpEndpoints_BindChallengeToAuthenticatedPrincipalSession()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string block = ExtractBetween(
            endpoints,
            "MapPost(\"/auth/admin/step-up/passkey/begin\"",
            "group.MapPost(\"/auth/admin/logout\"");

        Assert.True(CountOccurrences(block, "TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId)") >= 2);
        Assert.DoesNotContain("request.AdminPrincipalId", block, StringComparison.Ordinal);
        Assert.DoesNotContain("request.AdminSessionId", block, StringComparison.Ordinal);
        AssertContainsAfter(block, "TryResolveAdminSessionContext", "BeginAdminStepUpAssertionAsync(adminPrincipalId, adminSessionId");
        AssertContainsAfter(block, "TryResolveAdminSessionContext", "CompleteAdminStepUpAssertionAsync(\n                adminPrincipalId,\n                adminSessionId");
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
        Assert.True(CountOccurrences(adminUsers, "RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)") >= 1);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds)", authoring, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds)", security, StringComparison.Ordinal);
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
            mfaStart.IndexOf("CreateProofTokenAsync", StringComparison.Ordinal));
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
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds)", contentExportEndpoint, StringComparison.Ordinal);
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

    [Fact]
    public async Task OrdinaryRiskControlProof_CannotSatisfyAdminStepUp()
    {
        var cache = new DualProofCache();
        var adminService = CreateAdminService(cache);
        var challengeProofs = new SecurityChallengeProofService(cache, new RecordingChallengePersistence(), new FixedTimeProvider());
        SecurityChallengeProofMintResult proof = await challengeProofs.MintProofAsync(CreateChallengeProofMintRequest(), CancellationToken.None);

        bool accepted = await adminService.ValidateAndConsumeAdminStepUpProofTokenAsync(
            42,
            "sid-1",
            "admin-sensitive",
            proof.ProofToken,
            CancellationToken.None);

        Assert.False(accepted);
    }

    [Fact]
    public async Task AdminStepUpProof_CannotSatisfyOrdinaryRiskControlChallengeProof()
    {
        var cache = new DualProofCache();
        var adminService = CreateAdminService(cache);
        var challengeProofs = new SecurityChallengeProofService(cache, new RecordingChallengePersistence(), new FixedTimeProvider());
        string adminProof = await adminService.CreateAdminStepUpProofTokenAsync(
            42,
            "sid-1",
            "admin-sensitive",
            TimeSpan.FromMinutes(5),
            CancellationToken.None);

        SecurityChallengeProofConsumeResult result = await challengeProofs.ConsumeProofAsync(
            CreateChallengeProofConsumeRequest(adminProof),
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal("proof_replayed_or_missing", result.Reason);
    }

    private static AdminPrincipalService CreateAdminService(IUnifiedCache cache)
        => new(
            Substitute.For<IFido2>(),
            Substitute.For<ISqlSugarClient>(),
            cache,
            Substitute.For<IJwtHelper>(),
            new ConfigurationBuilder().Build(),
            NullLogger<AdminPrincipalService>.Instance);

    private static SecurityChallengeProofMintRequest CreateChallengeProofMintRequest()
        => new(
            "018ff2fe-7a68-7cc0-9e6c-111111111111",
            "passkeyStepUpV1",
            "profile.email.change",
            "user:42:email",
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            "risk-policy-v2",
            FixedTimeProvider.UtcNow,
            FixedTimeProvider.UtcNow.AddMinutes(5));

    private static SecurityChallengeProofConsumeRequest CreateChallengeProofConsumeRequest(string proofToken)
        => new(
            proofToken,
            "018ff2fe-7a68-7cc0-9e6c-111111111111",
            "passkeyStepUpV1",
            "profile.email.change",
            "user:42:email",
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            "risk-policy-v2");

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

    private static void AssertContainsAfter(string source, string first, string second)
    {
        int firstIndex = source.IndexOf(first, StringComparison.Ordinal);
        int secondIndex = source.IndexOf(second, StringComparison.Ordinal);
        Assert.True(firstIndex >= 0, $"Missing marker: {first}");
        Assert.True(secondIndex >= 0, $"Missing marker: {second}");
        Assert.True(secondIndex > firstIndex, $"{second} must appear after {first}");
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private sealed class FixedTimeProvider : TimeProvider
    {
        public static readonly DateTimeOffset UtcNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class DualProofCache : IUnifiedCache
    {
        private readonly Dictionary<string, byte[]> _raw = new(StringComparer.Ordinal);
        private readonly HashSet<string> _strings = new(StringComparer.Ordinal);

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            _raw[BuildKey(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            _strings.Add(BuildKey(policyId, identity));
            return Task.CompletedTask;
        }

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_strings.Remove(BuildKey(policyId, identity)));

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            string key = BuildKey(policyId, identity);
            if (!_raw.Remove(key, out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
            => Task.FromResult(new SecurityChallengeAttempt
            {
                ChallengeId = request.ChallengeId,
                Outcome = request.Outcome,
                Reason = request.Reason,
                PayloadHash = request.PayloadHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                AttemptedAtUtc = request.AttemptedAtUtc ?? DateTime.UtcNow
            });

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
