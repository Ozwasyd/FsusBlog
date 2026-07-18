using System.Net;
using System.Security.Claims;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRootEndpointTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-18T08:00:00Z");

    [Fact]
    public void Migration_CreatesAnonymousCredentialRootPublicMetadataTable()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260618-post-anonymous-credential-root-metadata");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string[] entityColumns = typeof(AnonymousCredentialRoot)
            .GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential_root", fingerprint, StringComparison.Ordinal);
        Assert.Contains("epoch bigint PRIMARY KEY", fingerprint, StringComparison.Ordinal);
        Assert.Contains("root_hash varchar(128) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("root_grace_expires_at_utc timestamp NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("circuit_id varchar(96) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("verifying_key_hash varchar(128) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("public_input_layout_version integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_anonymous_credential_root_status_expires", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("user_id", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("session", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("cookie", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(entityColumns, static column => column.Contains("User", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Session", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Cookie", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RuntimeServices_RegisterAnonymousCredentialRootCacheService()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor store = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialRootStore));
        ServiceDescriptor service = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialRootService));
        ServiceDescriptor artifactService = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialRevocationArtifactService));
        Assert.Equal(ServiceLifetime.Scoped, store.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRootStore), store.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, service.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRootService), service.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, artifactService.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRevocationArtifactService), artifactService.ImplementationType);
    }

    [Fact]
    public async Task RootService_CachesImmutableSnapshotUntilExplicitInvalidation()
    {
        var clock = new MutableTimeProvider(s_baselineNow);
        var store = new CountingRootStore(
            CreateRecord(epoch: 100, credentialRoot: [1, 2]),
            CreateRecord(epoch: 101, credentialRoot: [3, 4]));
        IAnonymousCredentialRootService service = CreateRootService(store, clock, zkEnabled: true, verifierConfigured: true);

        Result<AnonymousCredentialRootSnapshotCoreModel> first = await service.GetCurrentSnapshotAsync(CancellationToken.None);
        Result<AnonymousCredentialRootSnapshotCoreModel> cached = await service.GetCurrentSnapshotAsync(CancellationToken.None);
        service.Invalidate();
        Result<AnonymousCredentialRootSnapshotCoreModel> refreshed = await service.GetCurrentSnapshotAsync(CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(cached.IsSuccess, cached.Error.Message);
        Assert.True(refreshed.IsSuccess, refreshed.Error.Message);
        Assert.Equal(1, store.CallCountBeforeInvalidate);
        Assert.Equal(2, store.CallCount);
        Assert.Equal(100, first.Value.CredentialEpoch);
        Assert.Equal(100, cached.Value.CredentialEpoch);
        Assert.Equal(101, refreshed.Value.CredentialEpoch);
        Assert.Equal(s_baselineNow.AddMinutes(90).ToUnixTimeMilliseconds(), first.Value.RootGraceExpiresAtUnixMs);
        Assert.True(first.Value.ZkAnonymousEnabled);
        Assert.True(first.Value.VerifierConfigured);
        Assert.Equal([1, 2], first.Value.CredentialRoot);
        Assert.Equal([3, 4], refreshed.Value.CredentialRoot);
    }

    [Fact]
    public async Task RootService_NegativeCachesUnavailableRootForShortTtl()
    {
        var clock = new MutableTimeProvider(s_baselineNow);
        var store = new CountingRootStore(null, CreateRecord(epoch: 102, credentialRoot: [9]));
        IAnonymousCredentialRootService service = CreateRootService(store, clock, zkEnabled: true, verifierConfigured: true);

        Result<AnonymousCredentialRootSnapshotCoreModel> first = await service.GetCurrentSnapshotAsync(CancellationToken.None);
        Result<AnonymousCredentialRootSnapshotCoreModel> cachedMiss = await service.GetCurrentSnapshotAsync(CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(6));
        Result<AnonymousCredentialRootSnapshotCoreModel> refreshed = await service.GetCurrentSnapshotAsync(CancellationToken.None);

        Assert.True(first.IsFailure);
        Assert.Equal("anonymous_root_unavailable", first.Error.Message);
        Assert.True(cachedMiss.IsFailure);
        Assert.Equal("anonymous_root_unavailable", cachedMiss.Error.Message);
        Assert.Equal(1, store.CallCountBeforeInvalidate);
        Assert.True(refreshed.IsSuccess, refreshed.Error.Message);
        Assert.Equal(102, refreshed.Value.CredentialEpoch);
        Assert.Equal(2, store.CallCount);
    }

    [Fact]
    public async Task HandleAnonymousCredentialRootAsync_AnonymousCookieRequest_ReturnsAedsRootSnapshot()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext();
        var snapshot = CreateSnapshot();
        var service = new CapturingRootService(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(snapshot));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialRootAsync(context, aeds, service, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.AnonymousCredentialRootSnapshot, decoded.FrameType);
        Assert.True(
            PodBinaryCodec.TryDecodeAnonymousCredentialRootSnapshot(decoded.Payload, out AnonymousCredentialRootSnapshotCoreModel response),
            $"root snapshot payload decode failed; bytes={decoded.Payload.Length}");
        Assert.Equal(snapshot.CredentialEpoch, response.CredentialEpoch);
        Assert.Equal(snapshot.RootGraceExpiresAtUnixMs, response.RootGraceExpiresAtUnixMs);
        Assert.True(response.ZkAnonymousEnabled);
        Assert.True(response.VerifierConfigured);
        Assert.Equal([5, 6, 7], response.CredentialRoot);
        Assert.Equal(1, service.CallCount);
    }

    [Fact]
    public async Task HandleAnonymousCredentialRootAsync_UnavailableRoot_ReturnsAedsError503()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext();
        var service = new CapturingRootService(
            Result<AnonymousCredentialRootSnapshotCoreModel>.Failure(ErrorCode.InfraFailure, "anonymous_root_unavailable"));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialRootAsync(context, aeds, service, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("anonymous_root_unavailable", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AnonymousCredentialRootEndpoints_AreAnonymousPublicReadAedsOnly()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        foreach (string route in new[]
        {
            "/api/binary/anonymous-credential/root",
            "/api/binary/anonymous-credential/circuit"
        })
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, HttpMethods.Get);
            Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
            Assert.Equal(
                "public_read",
                Assert.IsType<EnableRateLimitingAttribute>(
                    endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        }

        string handler = string.Join('\n',
            RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
                typeof(BinaryEndpoints),
                "anonymous_root_unavailable"),
            RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
                typeof(BinaryEndpoints),
                "WriteAnonymousCredentialRootSnapshot"));
        Assert.Contains("WriteAnonymousCredentialRootSnapshot", handler, StringComparison.Ordinal);
        Assert.Contains("anonymous_root_unavailable", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpContext.get_User", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("Cookie", handler, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Session", handler, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AnonymousCredentialRevocationEndpoints_RetireCredentialSpecificBodyAndExposePublicArtifacts()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint retired = EndpointContractApplication.Find(
            app,
            "/api/binary/anonymous-credential/revocation-witness",
            HttpMethods.Post);
        Assert.NotNull(retired.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.NotNull(retired.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());
        Assert.NotNull(retired.Metadata.GetMetadata<NoStoreResponseMetadata>());
        Assert.Equal(
            "public_read",
            Assert.IsType<EnableRateLimitingAttribute>(
                retired.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);

        foreach (string route in new[]
        {
            "/api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/full.aeds",
            "/api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/delta/{baseVersion:long}.aeds"
        })
        {
            RouteEndpoint artifact = EndpointContractApplication.Find(app, route, HttpMethods.Get);
            Assert.NotNull(artifact.Metadata.GetMetadata<IAllowAnonymous>());
            Assert.Null(artifact.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());
        }

        string handler = string.Join('\n',
            RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
                typeof(BinaryEndpoints),
                "credential_specific_revocation_witness_retired"),
            RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
                typeof(BinaryEndpoints),
                "WriteAnonymousCredentialRevocationArtifact"));
        Assert.Contains("credential_specific_revocation_witness_retired", handler, StringComparison.Ordinal);
        Assert.Contains("WriteAnonymousCredentialRevocationArtifact", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("TryDecodeAnonymousCredentialRevocation", handler, StringComparison.Ordinal);
    }

    private static AnonymousCredentialRootRecord CreateRecord(long epoch, byte[] credentialRoot)
        => new(
            epoch,
            credentialRoot,
            RevocationRoot: [11, 12],
            RootHash: Convert.ToHexString(credentialRoot).ToLowerInvariant(),
            CircuitId: AnonymousPrivacyContract.CircuitId,
            CircuitNumericId: 7,
            VerifyingKeyHash: "vk-sha256",
            IssuerPublicKeyHash: new string('f', 64),
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            CreatedAtUtc: s_baselineNow.UtcDateTime,
            ExpiresAtUtc: s_baselineNow.AddMinutes(60).UtcDateTime,
            GraceExpiresAtUtc: s_baselineNow.AddMinutes(90).UtcDateTime,
            Status: AnonymousCredentialRootStatuses.Active,
            CircuitMetadata: [13, 14]);

    private static AnonymousCredentialRootSnapshotCoreModel CreateSnapshot()
        => new(
            CredentialEpoch: 2048,
            RootExpiresAtUnixMs: s_baselineNow.AddMinutes(60).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: s_baselineNow.AddMinutes(90).ToUnixTimeMilliseconds(),
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: "vk-sha256",
            IssuerPublicKeyHash: new('f', 64),
            CredentialRoot: [5, 6, 7],
            RevocationRoot: [8, 9],
            CircuitMetadata: [10]);

    private static IAnonymousCredentialRootService CreateRootService(
        IAnonymousCredentialRootStore store,
        MutableTimeProvider clock,
        bool zkEnabled,
        bool verifierConfigured)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = zkEnabled ? "true" : "false"
            })
            .Build();
        var services = new ServiceCollection()
            .AddSingleton(configuration)
            .AddSingleton<TimeProvider>(clock)
            .AddSingleton<IZkProofVerifier>(new StaticZkProofVerifier(verifierConfigured))
            .AddSingleton(store)
            .AddSingleton<IAnonymousCredentialRootService, AnonymousCredentialRootService>()
            .BuildServiceProvider(validateScopes: true);
        return services.GetRequiredService<IAnonymousCredentialRootService>();
    }

    private static DefaultHttpContext CreateEndpointContext()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-root";
        context.Request.Method = HttpMethods.Get;
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.Headers.Cookie = "fsus_auth=should-not-be-read";
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "unit-test"));
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(BinaryFrameResult result, DefaultHttpContext context, AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);

        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class CapturingRootService(Result<AnonymousCredentialRootSnapshotCoreModel> result) : IAnonymousCredentialRootService
    {
        public int CallCount
        {
            get; private set;
        }

        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(result);
        }

        public void Invalidate()
        {
        }
    }

    private sealed class CountingRootStore(params AnonymousCredentialRootRecord?[] records) : IAnonymousCredentialRootStore
    {
        private readonly Queue<AnonymousCredentialRootRecord?> _records = new(records);

        public int CallCount
        {
            get; private set;
        }
        public int CallCountBeforeInvalidate => Math.Min(CallCount, 1);

        public Task<AnonymousCredentialRootRecord?> GetCurrentAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(_records.Count > 0 ? _records.Dequeue() : null);
        }
    }

    private sealed class StaticZkProofVerifier(bool configured) : IZkProofVerifier
    {
        public bool IsConfigured => configured;

        public Task<ZkProofVerificationResult> VerifyAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(configured ? ZkProofVerificationResult.Success() : ZkProofVerificationResult.VerifierUnavailable());
    }

    private sealed class FixedHotArticlesCacheVersionProvider : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => 0;

        public string BuildVersionedHotArticlesIdentity(string identity) => identity;
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan interval)
            => _utcNow = _utcNow.Add(interval);
    }
}
