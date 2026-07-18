using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class Sha256PowChallengeProviderTests
{
    private const string ClientIp = "203.0.113.47";
    private const string BrowserFingerprint = "unit-browser";
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterSha256PowProvider()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(Sha256PowChallengeProvider));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    [Fact]
    public async Task IssueAsync_ReturnsAssignmentWithPowPayloadAndPersistsAuditMetadata()
    {
        var fixture = CreateFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.Sha256PowV1, result.Assignment.Kind);
        Assert.Equal("public.read", result.Assignment.Action);
        Assert.Equal("/article/42", result.Assignment.RouteKey);
        Assert.Equal(HashA, result.Assignment.SubjectHash);
        Assert.Equal(HashB, result.Assignment.ClientIpHash);
        Assert.Equal(HashC, result.Assignment.DeviceFpHash);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.Equal(["difficulty", "salt", "signature", "timestamp"], result.ProviderPayload.Keys.Order(StringComparer.Ordinal));
        SecurityChallengeIssueRequest issued = Assert.Single(fixture.Persistence.Issues);
        Assert.Equal(result.Assignment.ChallengeId, issued.ChallengeId);
        Assert.Equal(Sha256PowChallengeProvider.WireKind, issued.Kind);
        Assert.Equal(Sha256PowChallengeProvider.Algorithm, issued.Algorithm);
        Assert.Equal("risk-policy-v2", issued.PolicyVersion);
        Assert.NotEqual(result.ProviderPayload["salt"], issued.PayloadHash);
        Assert.Matches("^[0-9a-f]{64}$", issued.PayloadHash);
    }

    [Fact]
    public async Task VerifyAsync_AcceptsLegacyFpowProofAndConsumesItOnce()
    {
        var fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        string proof = CreateEncodedProof(issued.ProviderPayload);

        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, proof),
            CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment.ChallengeId, proof),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        Assert.False(replay.Succeeded);
        Assert.Equal("pow_verify_failed", replay.Reason);
        Assert.Equal(2, fixture.Persistence.Attempts.Count);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, fixture.Persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, fixture.Persistence.Attempts[1].Outcome);
        Assert.Equal("pow_verify_failed", fixture.Persistence.Attempts[1].Reason);
    }

    [Fact]
    public async Task VerifyAsync_RejectsDifficultyBelowGovernorRequirementBeforeConsumingProof()
    {
        var fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        string proof = CreateEncodedProof(issued.ProviderPayload, difficultyOverride: 0);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, proof),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("difficulty_insufficient", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("difficulty_insufficient", attempt.Reason);
    }

    [Fact]
    public async Task VerifyAsync_RejectsTamperedSignature()
    {
        var fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        var tampered = new Dictionary<string, string>(issued.ProviderPayload, StringComparer.Ordinal)
        {
            ["signature"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        };
        string proof = CreateEncodedProof(tampered);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, proof),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pow_verify_failed", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("pow_verify_failed", attempt.Reason);
    }

    [Fact]
    public async Task VerifyAsync_RejectsProofIssuedForDifferentChallengeContext()
    {
        var fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issuedA = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        SecurityChallengeProviderIssueResult issuedB = await fixture.Provider.IssueAsync(
            CreateIssueRequest(action: "comment.create", routeKey: "comment.create", subjectHash: HashC),
            CancellationToken.None);
        string proofA = CreateEncodedProof(issuedA.ProviderPayload);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(
                issuedB.Assignment!.ChallengeId,
                proofA,
                action: "comment.create",
                routeKey: "comment.create",
                subjectHash: HashC),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pow_verify_failed", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(issuedB.Assignment.ChallengeId, attempt.ChallengeId);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("pow_verify_failed", attempt.Reason);
    }

    private static ProviderFixture CreateFixture()
    {
        var cache = new OneShotCache();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:Pow:SigningKey"] = "unit-test-pow-signing-key-with-enough-entropy"
            })
            .Build();
        var governor = new AdaptivePowGovernor(cache);
        var pow = new RedisPowService(configuration, NullLogger<RedisPowService>.Instance, governor, cache);
        var persistence = new RecordingChallengePersistence();
        var provider = new Sha256PowChallengeProvider(pow, governor, persistence, TimeProvider.System);

        return new ProviderFixture(provider, persistence);
    }

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest(
        string action = "public.read",
        string routeKey = "/article/42",
        string subjectHash = HashA)
        => new(
            CreateContext(),
            Sha256PowChallengeProvider.WireKind,
            action,
            routeKey,
            "tenant-main",
            subjectHash,
            HashB,
            HashC,
            "risk-policy-v2",
            1,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateVerifyRequest(
        string challengeId,
        string proof,
        string action = "public.read",
        string routeKey = "/article/42",
        string subjectHash = HashA)
        => new(
            CreateContext(),
            Sha256PowChallengeProvider.WireKind,
            challengeId,
            action,
            routeKey,
            subjectHash,
            HashB,
            HashC,
            "risk-policy-v2",
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [Sha256PowChallengeProvider.ProofPayloadKey] = proof
            });

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(ClientIp);
        context.TraceIdentifier = "trace-unit";
        context.Request.Headers["traceparent"] = Traceparent;
        return context;
    }

    private static string CreateEncodedProof(IReadOnlyDictionary<string, string> challengePayload, int? difficultyOverride = null)
    {
        int difficulty = difficultyOverride ?? int.Parse(challengePayload["difficulty"]);
        string salt = challengePayload["salt"];
        string nonce = SolveNonce(salt, BrowserFingerprint, difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = salt,
            PowNonce = nonce,
            Difficulty = difficulty,
            PowTimestamp = long.Parse(challengePayload["timestamp"]),
            PowSignature = challengePayload["signature"],
            BrowserFp = BrowserFingerprint
        };

        return EncodeBinaryProof(request);
    }

    private static string EncodeBinaryProof(VirtualPowRequest request)
    {
        byte[] salt = Encoding.UTF8.GetBytes(request.PowSalt);
        byte[] nonce = Encoding.UTF8.GetBytes(request.PowNonce);
        byte[] signature = Encoding.UTF8.GetBytes(request.PowSignature);
        byte[] browserFp = Encoding.UTF8.GetBytes(request.BrowserFp);
        int length = 17
            + sizeof(ushort) + salt.Length
            + sizeof(ushort) + nonce.Length
            + sizeof(ushort) + signature.Length
            + sizeof(ushort) + browserFp.Length;
        byte[] buffer = new byte[length];
        buffer[0] = (byte)'F';
        buffer[1] = (byte)'P';
        buffer[2] = (byte)'O';
        buffer[3] = (byte)'W';
        buffer[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(5), request.Difficulty);
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(9), request.PowTimestamp);
        int offset = 17;
        WriteString(buffer, salt, ref offset);
        WriteString(buffer, nonce, ref offset);
        WriteString(buffer, signature, ref offset);
        WriteString(buffer, browserFp, ref offset);

        return Convert.ToBase64String(buffer);
    }

    private static void WriteString(byte[] buffer, byte[] value, ref int offset)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(offset), checked((ushort)value.Length));
        offset += sizeof(ushort);
        value.CopyTo(buffer.AsSpan(offset));
        offset += value.Length;
    }

    private static string SolveNonce(string salt, string browserFingerprint, int difficulty)
    {
        for (long nonce = 0; nonce < 1_000_000; nonce++)
        {
            string candidate = nonce.ToString();
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{salt}:{candidate}:{browserFingerprint}"));
            if (HasLeadingDifficulty(hash, difficulty))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("Unable to solve unit PoW nonce.");
    }

    private static bool HasLeadingDifficulty(ReadOnlySpan<byte> hash, int difficulty)
    {
        int fullBytes = difficulty / 8;
        for (int i = 0; i < fullBytes; i++)
        {
            if (hash[i] != 0)
            {
                return false;
            }
        }

        int remainingBits = difficulty % 8;
        return remainingBits == 0 || (hash[fullBytes] >> (8 - remainingBits)) == 0;
    }

    private sealed record ProviderFixture(Sha256PowChallengeProvider Provider, RecordingChallengePersistence Persistence);

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeIssueRequest> Issues { get; } = [];

        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
        {
            Issues.Add(request);
            return Task.FromResult(new SecurityChallenge
            {
                ChallengeId = request.ChallengeId,
                Status = SecurityChallengeStatuses.Issued,
                Kind = request.Kind,
                Algorithm = request.Algorithm,
                Action = request.Action,
                RouteKey = request.RouteKey,
                SubjectHash = request.SubjectHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                PolicyVersion = request.PolicyVersion,
                PayloadHash = request.PayloadHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                IssuedAtUtc = request.IssuedAtUtc,
                ExpiresAtUtc = request.ExpiresAtUtc
            });
        }

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                AttemptId = SecurityChallengeContracts.CreateChallengeId(),
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
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);
    }

    private sealed class OneShotCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, string> _leases = new(StringComparer.Ordinal);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(_leases.TryAdd($"{policyId}:{identity}", value));

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<byte[]>));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<ReadOnlyMemory<byte>>));

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(NullAsyncDisposable.Instance);

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";

        private sealed class NullAsyncDisposable : IAsyncDisposable
        {
            public static readonly NullAsyncDisposable Instance = new();

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
