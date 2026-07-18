using Fido2NetLib;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminMfaStepUpSecurityTests
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminStepUpEndpoints_UseAdminPasskeyApiAndAdminManagePolicy()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint begin = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/admin/step-up/passkey/begin",
            HttpMethods.Post);
        RouteEndpoint complete = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/admin/step-up/passkey/complete",
            HttpMethods.Post);
        AssertAdminManage(begin);
        AssertAdminManage(complete);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(typeof(BinaryEndpoints), "MapBinaryAuthEndpoints");
        Assert.Contains("BeginAdminStepUpAssertionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("CompleteAdminStepUpAssertionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("WritePasskeyLoginBegin", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("WriteMfaChallengeResult", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task OrdinaryAccountStepUpEndpoints_UsePasskeyApiAndReturnMfaProof()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint begin = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/step-up/passkey/begin",
            HttpMethods.Post);
        RouteEndpoint complete = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/step-up/passkey/complete",
            HttpMethods.Post);
        AssertAnonymousAccount(begin);
        AssertAnonymousAccount(complete);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(typeof(BinaryEndpoints), "MapBinaryAuthEndpoints");
        Assert.Contains("BeginActionStepUpAssertionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("CompleteActionStepUpAssertionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("CreateProofTokenAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("WritePasskeyLoginBegin", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("WriteMfaChallengeResult", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminStepUpEndpoints_BindChallengeToAuthenticatedPrincipalSessionAtRuntime()
    {
        string beginHandler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "TryResolveAdminSessionContext",
            "BeginAdminStepUpAssertionAsync");
        string completeHandler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "TryResolveAdminSessionContext",
            "CompleteAdminStepUpAssertionAsync");

        Assert.Contains("TryResolveAdminSessionContext", beginHandler, StringComparison.Ordinal);
        Assert.Contains("BeginAdminStepUpAssertionAsync", beginHandler, StringComparison.Ordinal);
        Assert.Contains("TryResolveAdminSessionContext", completeHandler, StringComparison.Ordinal);
        Assert.Contains("CompleteAdminStepUpAssertionAsync", completeHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminStepUpPasskeyBeginRequest.get_AdminPrincipalId", beginHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminStepUpPasskeyBeginRequest.get_AdminSessionId", beginHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminStepUpPasskeyCompleteRequest.get_AdminPrincipalId", completeHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminStepUpPasskeyCompleteRequest.get_AdminSessionId", completeHandler, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminSensitiveMutations_UseAdminStepUpProofInsteadOfUserMfa()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint adminUserStatus = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/users/status",
            HttpMethods.Put);
        RouteEndpoint contentExport = EndpointContractApplication.Find(
            app,
            "/api/binary/author/content/export",
            HttpMethods.Get);
        RouteEndpoint riskOptions = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/security/risk-control/options",
            HttpMethods.Put);
        Assert.NotNull(adminUserStatus.RequestDelegate);
        Assert.NotNull(contentExport.RequestDelegate);
        Assert.NotNull(riskOptions.RequestDelegate);

        string binaryCore = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "RequireAdminSensitiveStepUpAsync");
        string authoring = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringEndpoints),
            "RequireAdminSensitiveStepUpAsync");
        string security = RuntimeMetadataInspection.DescribeMethods(
            typeof(SecurityEndpoints),
            "RequireAdminSensitiveStepUpAsync");
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", binaryCore, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", authoring, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", security, StringComparison.Ordinal);
        Assert.DoesNotContain("IsMfaVerified", binaryCore, StringComparison.Ordinal);
        Assert.DoesNotContain("IMfaChallengeService", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("IMfaChallengeService", security, StringComparison.Ordinal);
    }

    [Fact]
    public void OrdinaryMfaChallengeStart_RejectsAdminSensitiveActionBeforeMintingProof()
    {
        string handler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "IsAdminSensitiveAction",
            "MFA_REQUIRED",
            "CreateProofTokenAsync");

        Assert.Contains("IsAdminSensitiveAction", handler, StringComparison.Ordinal);
        Assert.Contains("MFA_REQUIRED", handler, StringComparison.Ordinal);
        Assert.Contains("CreateProofTokenAsync", handler, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task ContentBackupExport_RequiresAdminSensitiveAdminProof()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/author/content/export",
            HttpMethods.Get);

        string handler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(AuthoringEndpoints),
            "ExportContentBackupAsync",
            "RequireAdminSensitiveStepUpAsync");
        Assert.Contains("IAdminPrincipalService", handler, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", handler, StringComparison.Ordinal);
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
            NullLogger<AdminPrincipalService>.Instance,
            Substitute.For<IAdminAuditLogChannel>());

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

    private static void AssertAdminManage(RouteEndpoint endpoint)
    {
        ClaimsAuthorizationRequirement requirement = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(AdminPermissions.AdminManage, requirement.AllowedValues ?? []);
    }

    private static void AssertAnonymousAccount(RouteEndpoint endpoint)
    {
        ClaimsAuthorizationRequirement requirement = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == "identity_kind");
        Assert.Contains(AnonymousIdentityRuntime.AnonymousAccountKind, requirement.AllowedValues ?? []);
    }

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
