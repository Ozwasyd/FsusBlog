using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PowValidationLogicTests
{
    private const string VisitLogIpKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("172.17.0.1")]
    [InlineData("172.18.0.1")]
    public async Task ValidateAsync_RejectsProofBoundToFallbackIpWithoutConsumingProof(string proofIp)
    {
        var fixture = CreateFixture();
        var proof = await CreateEncodedProofAsync(fixture.Service, proofIp);

        var rejectedContext = CreatePowContext("198.51.100.42", proof);
        IActionResult? rejected = await PowValidationLogic.ValidateAsync(
            rejectedContext,
            NullLogger.Instance,
            fixture.Service,
            fixture.Governor);

        Assert.IsType<UnauthorizedObjectResult>(rejected);

        var acceptedContext = CreatePowContext(proofIp, proof);
        IActionResult? accepted = await PowValidationLogic.ValidateAsync(
            acceptedContext,
            NullLogger.Instance,
            fixture.Service,
            fixture.Governor);

        Assert.Null(accepted);

        var replayContext = CreatePowContext(proofIp, proof);
        IActionResult? replay = await PowValidationLogic.ValidateAsync(
            replayContext,
            NullLogger.Instance,
            fixture.Service,
            fixture.Governor);

        Assert.IsType<UnauthorizedObjectResult>(replay);
    }

    [Fact]
    public async Task ValidateAsync_AcceptsProofBoundToNormalizedClientIp()
    {
        const string ClientIp = "203.0.113.10";
        var fixture = CreateFixture();
        var proof = await CreateEncodedProofAsync(fixture.Service, ClientIp);
        var context = CreatePowContext(ClientIp, proof);

        IActionResult? result = await PowValidationLogic.ValidateAsync(
            context,
            NullLogger.Instance,
            fixture.Service,
            fixture.Governor);

        Assert.Null(result);
    }

    [Fact]
    public async Task ValidateAsync_NormalizesInternalPowExceptionsToUnauthorized()
    {
        const string ClientIp = "203.0.113.10";
        var fixture = CreateFixture();
        string proof = await CreateEncodedProofAsync(fixture.Service, ClientIp);
        var context = CreatePowContext(ClientIp, proof);

        IActionResult? result = await PowValidationLogic.ValidateAsync(
            context,
            NullLogger.Instance,
            new ThrowingPowService(),
            fixture.Governor);

        Assert.IsType<UnauthorizedObjectResult>(result);
    }

    [Fact]
    public async Task ValidateAsync_InternalPowExceptionLog_UsesIpHashAndOmitsRawClientIp()
    {
        const string ClientIp = "203.0.113.10";
        var fixture = CreateFixture();
        string proof = await CreateEncodedProofAsync(fixture.Service, ClientIp);
        var context = CreatePowContext(ClientIp, proof, new Dictionary<string, string?>
        {
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "4",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = VisitLogIpKey
        });
        var logger = new CapturingLogger();

        IActionResult? result = await PowValidationLogic.ValidateAsync(
            context,
            logger,
            new ThrowingPowService(),
            fixture.Governor);

        Assert.IsType<UnauthorizedObjectResult>(result);
        string rendered = Assert.Single(logger.Messages);
        Assert.DoesNotContain(ClientIp, rendered, StringComparison.Ordinal);
        Assert.Contains(ExpectedIpHash(ClientIp), rendered, StringComparison.Ordinal);
        Assert.Contains("ClientIpHash", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ValidateAsync_AccessDeniedLog_UsesIpHashAndOmitsRawClientIp()
    {
        const string ClientIp = "203.0.113.10";
        var fixture = CreateFixture();
        string proof = await CreateEncodedProofAsync(fixture.Service, ClientIp);
        var context = CreatePowContext(ClientIp, proof, new Dictionary<string, string?>
        {
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "4",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = VisitLogIpKey
        });
        var logger = new CapturingLogger();

        IActionResult? result = await PowValidationLogic.ValidateAsync(
            context,
            logger,
            new RejectingPowService(),
            fixture.Governor);

        Assert.IsType<UnauthorizedObjectResult>(result);
        string rendered = Assert.Single(logger.Messages);
        Assert.DoesNotContain(ClientIp, rendered, StringComparison.Ordinal);
        Assert.Contains(ExpectedIpHash(ClientIp), rendered, StringComparison.Ordinal);
        Assert.Contains("ClientIpHash", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void PowValidationLogic_LoggingContract_UsesHashedClientIdentityParameters()
    {
        MethodInfo accessDenied = typeof(PowValidationLogic).GetMethod(
            "LogAccessDenied",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("PoW access-denied logger was not found.");
        Assert.Equal(
            ["logger", "clientIpHash", "traceId", "reason"],
            accessDenied.GetParameters().Select(static parameter => parameter.Name!).ToArray());
        Assert.DoesNotContain(accessDenied.GetParameters(), static parameter =>
            string.Equals(parameter.Name, "clientIp", StringComparison.OrdinalIgnoreCase)
            || string.Equals(parameter.Name, "ip", StringComparison.OrdinalIgnoreCase));

        Assert.Equal("VisitLog:IpPseudonymization", VisitLogIpPseudonymizer.SectionName);
        const string Ip = "203.0.113.44";
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [VisitLogIpPseudonymizer.CurrentEpochKey] = "4",
                [VisitLogIpPseudonymizer.CurrentKeyKey] = VisitLogIpKey
            })
            .Build();
        string ipHash = new VisitLogIpPseudonymizer(configuration, false, TimeProvider.System)
            .PseudonymizeCurrent(VisitLogIpPseudonymScope.SecurityLog, Ip, DateTimeOffset.UtcNow).Hash;
        Assert.Matches("^[0-9a-f]{32}$", ipHash);
        Assert.DoesNotContain(Ip, ipHash, StringComparison.Ordinal);

        MethodInfo crawlerHasher = typeof(CrawlerDetectorService).GetMethod(
            "ResolveClientIpHashForLog",
            BindingFlags.NonPublic | BindingFlags.Static,
            binder: null,
            types: [typeof(string), typeof(IConfiguration)],
            modifiers: null)
            ?? throw new InvalidOperationException("Crawler client identity hasher was not found.");
        Assert.Equal(ipHash, crawlerHasher.Invoke(null, [Ip, configuration]));

        MethodInfo userLoginFailure = typeof(UserService).GetMethod(
            "LogLoginFailure",
            BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("User login failure logger was not found.");
        Assert.Equal("clientIpHash", userLoginFailure.GetParameters()[1].Name);
    }

    private static PowFixture CreateFixture()
    {
        var cache = new OneShotCache();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:Pow:SigningKey"] = "unit-test-pow-signing-key-with-enough-entropy"
            })
            .Build();
        var governor = new AdaptivePowGovernor(cache);
        var service = new RedisPowService(configuration, NullLogger<RedisPowService>.Instance, governor, cache);

        return new PowFixture(service, governor);
    }

    private static async Task<string> CreateEncodedProofAsync(RedisPowService service, string clientIp)
    {
        const string BrowserFingerprint = "unit-browser";
        var challenge = await service.GenerateChallengeAsync(clientIp);
        string nonce = SolveNonce(challenge.Salt, BrowserFingerprint, challenge.Difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = challenge.Salt,
            PowNonce = nonce,
            Difficulty = challenge.Difficulty,
            PowTimestamp = challenge.Timestamp,
            PowSignature = challenge.Signature,
            BrowserFp = BrowserFingerprint
        };

        return EncodeBinaryProof(request);
    }

    private static DefaultHttpContext CreatePowContext(
        string remoteIp,
        string proof,
        IReadOnlyDictionary<string, string?>? configurationValues = null)
    {
        var services = new ServiceCollection();
        if (configurationValues is not null)
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(configurationValues)
                .Build();
            services.AddSingleton(configuration);
            services.AddSingleton<IVisitLogIpPseudonymizer>(
                new VisitLogIpPseudonymizer(configuration, false, TimeProvider.System));
            services.AddSingleton(TimeProvider.System);
        }

        var context = new DefaultHttpContext
        {
            RequestServices = services.BuildServiceProvider()
        };
        context.Connection.RemoteIpAddress = IPAddress.Parse(remoteIp);
        context.Request.Headers["X-Fsus-Pow-Proof"] = proof;
        return context;
    }

    private static string ExpectedIpHash(string ip)
        => new VisitLogIpPseudonymizer(4, Convert.FromBase64String(VisitLogIpKey))
            .PseudonymizeCurrent(VisitLogIpPseudonymScope.SecurityLog, ip, DateTimeOffset.UtcNow).Hash;

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

    private sealed record PowFixture(RedisPowService Service, AdaptivePowGovernor Governor);

    private sealed class ThrowingPowService : IPowService
    {
        public Task<PowChallenge> GenerateChallengeAsync(string clientIp, string? bindingContext = null)
            => throw new NotSupportedException();

        public Task<bool> VerifyAsync(IPowRequest req, string clientIp, string? bindingContext = null)
            => throw new OverflowException("unit pow failure");
    }

    private sealed class RejectingPowService : IPowService
    {
        public Task<PowChallenge> GenerateChallengeAsync(string clientIp, string? bindingContext = null)
            => throw new NotSupportedException();

        public Task<bool> VerifyAsync(IPowRequest req, string clientIp, string? bindingContext = null)
            => Task.FromResult(false);
    }

    private sealed class CapturingLogger : ILogger
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Messages.Add(formatter(state, exception));
        }
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
