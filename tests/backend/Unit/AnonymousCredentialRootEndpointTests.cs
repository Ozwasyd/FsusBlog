using System.Net;
using System.Security.Claims;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialRootEndpointTests
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-18T08:00:00Z");

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
        ServiceDescriptor witnessService = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialRevocationWitnessService));
        Assert.Equal(ServiceLifetime.Scoped, store.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRootStore), store.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, service.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRootService), service.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, witnessService.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialRevocationWitnessService), witnessService.ImplementationType);
    }

    [Fact]
    public async Task RootService_CachesImmutableSnapshotUntilExplicitInvalidation()
    {
        var clock = new MutableTimeProvider(BaselineNow);
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
        Assert.Equal(BaselineNow.AddMinutes(90).ToUnixTimeMilliseconds(), first.Value.RootGraceExpiresAtUnixMs);
        Assert.True(first.Value.ZkAnonymousEnabled);
        Assert.True(first.Value.VerifierConfigured);
        Assert.Equal([1, 2], first.Value.CredentialRoot);
        Assert.Equal([3, 4], refreshed.Value.CredentialRoot);
    }

    [Fact]
    public async Task RootService_NegativeCachesUnavailableRootForShortTtl()
    {
        var clock = new MutableTimeProvider(BaselineNow);
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
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRootSnapshot(decoded.Payload, out AnonymousCredentialRootSnapshotCoreModel response));
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
    public void AnonymousCredentialRootEndpoints_AreAnonymousPublicReadAedsOnly()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs");
        string handler = ExtractMethod(source, "HandleAnonymousCredentialRootAsync", "HandleAnonymousCredentialIssueAsync");

        Assert.Contains("MapGet(\"/anonymous-credential/root\"", source, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/anonymous-credential/circuit\"", source, StringComparison.Ordinal);
        Assert.Contains(".AllowAnonymous()", source, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"public_read\")", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCredentialRootSnapshot", source, StringComparison.Ordinal);
        Assert.Contains("anonymous_root_unavailable", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".User", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("Cookie", handler, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Session", handler, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task HandleAnonymousCredentialRevocationWitnessAsync_AnonymousRequest_ReturnsCircuitFriendlyWitnessFrame()
    {
        var aeds = new AedsEncoder();
        byte[] root = Convert.FromHexString(new string('a', 64));
        byte[] handle = Convert.FromHexString(new string('b', 64));
        var request = new AnonymousCredentialRevocationWitnessRequestCoreModel(
            CredentialEpoch: 2048,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: 2,
            CircuitId: "fsus.anonymous.comment.v1",
            IssuerPublicKeyHash: new('f', 64),
            RevocationRoot: root,
            RevocationHandleHash: handle);
        var response = new AnonymousCredentialRevocationWitnessResponseCoreModel(
            CredentialEpoch: request.CredentialEpoch,
            AlgorithmId: AnonymousCredentialRevocationAccumulator.CircuitFriendlyNonMembershipAlgorithmId,
            PathDepth: 128,
            RevocationRoot: root,
            IssuerPublicKeyHash: request.IssuerPublicKeyHash,
            RevocationHandleHash: handle,
            LeafKey: Convert.FromHexString(new string('c', 32)),
            WitnessHash: Convert.FromHexString(new string('d', 64)),
            SiblingHashes: Enumerable.Range(0, 128 * 32).Select(static index => (byte)(index % 251)).ToArray());
        var service = new CapturingRevocationWitnessService(Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Success(response));
        DefaultHttpContext context = CreateWitnessContext(aeds, request);

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialRevocationWitnessAsync(
            context,
            aeds,
            service,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.AnonymousCredentialRevocationWitnessResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialRevocationWitnessResponse(
            decoded.Payload,
            out AnonymousCredentialRevocationWitnessResponseCoreModel actual));
        Assert.Equal(1, service.CallCount);
        Assert.Equal(request.CredentialEpoch, service.LastRequest.CredentialEpoch);
        Assert.Equal(request.CircuitNumericId, service.LastRequest.CircuitNumericId);
        Assert.Equal(request.PublicInputLayoutVersion, service.LastRequest.PublicInputLayoutVersion);
        Assert.Equal(request.CircuitId, service.LastRequest.CircuitId);
        Assert.Equal(request.IssuerPublicKeyHash, service.LastRequest.IssuerPublicKeyHash);
        Assert.Equal(request.RevocationRoot, service.LastRequest.RevocationRoot);
        Assert.Equal(request.RevocationHandleHash, service.LastRequest.RevocationHandleHash);
        Assert.Equal(response.AlgorithmId, actual.AlgorithmId);
        Assert.Equal(response.PathDepth, actual.PathDepth);
        Assert.Equal(response.LeafKey, actual.LeafKey);
        Assert.Equal(response.WitnessHash, actual.WitnessHash);
        Assert.Equal(response.SiblingHashes, actual.SiblingHashes);
    }

    [Fact]
    public void AnonymousCredentialRevocationWitnessEndpoint_IsStrongAnonymousPublicReadAedsOnly()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs");
        string handler = ExtractMethod(source, "HandleAnonymousCredentialRevocationWitnessAsync", "HandleAnonymousCredentialIssueAsync");

        Assert.Contains("MapPost(\"/anonymous-credential/revocation-witness\"", source, StringComparison.Ordinal);
        Assert.Contains(".AllowAnonymous()", source, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"public_read\")", source, StringComparison.Ordinal);
        Assert.Contains(".RequireNoStoreResponse()", source, StringComparison.Ordinal);
        Assert.Contains(".RequireStrongAnonymousRequest()", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCredentialRevocationWitnessRequest", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCredentialRevocationWitnessResponse", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".User", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("Cookie", handler, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Session", handler, StringComparison.OrdinalIgnoreCase);
    }

    private static AnonymousCredentialRootRecord CreateRecord(long epoch, byte[] credentialRoot)
        => new(
            epoch,
            credentialRoot,
            RevocationRoot: [11, 12],
            RootHash: Convert.ToHexString(credentialRoot).ToLowerInvariant(),
            CircuitId: "fsus.anonymous.comment.v1",
            CircuitNumericId: 7,
            VerifyingKeyHash: "vk-sha256",
            IssuerPublicKeyHash: new string('f', 64),
            PublicInputLayoutVersion: 2,
            CreatedAtUtc: BaselineNow.UtcDateTime,
            ExpiresAtUtc: BaselineNow.AddMinutes(60).UtcDateTime,
            GraceExpiresAtUtc: BaselineNow.AddMinutes(90).UtcDateTime,
            Status: AnonymousCredentialRootStatuses.Active,
            CircuitMetadata: [13, 14]);

    private static AnonymousCredentialRootSnapshotCoreModel CreateSnapshot()
        => new(
            CredentialEpoch: 2048,
            RootExpiresAtUnixMs: BaselineNow.AddMinutes(60).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: BaselineNow.AddMinutes(90).ToUnixTimeMilliseconds(),
            CircuitNumericId: 7,
            PublicInputLayoutVersion: 2,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: "fsus.anonymous.comment.v1",
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

    private static DefaultHttpContext CreateWitnessContext(
        AedsEncoder aeds,
        AnonymousCredentialRevocationWitnessRequestCoreModel request)
    {
        byte[] payload = PodBinaryCodec.EncodeAnonymousCredentialRevocationWitnessRequest(request);
        byte[] frame = aeds.Encode(AedsFrameType.AnonymousCredentialRevocationWitnessRequest, payload);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-witness";
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/anonymous-credential/revocation-witness";
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frame.Length;
        context.Request.Body = new MemoryStream(frame);
        context.Request.Headers.Cookie = "fsus_auth=should-not-be-read";
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "unit-test"));
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>()
            .AddSingleton<IHotArticlesCacheVersionProvider>(new FixedHotArticlesCacheVersionProvider())
            .AddSingleton<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>()
            .BuildServiceProvider();
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

    private static string ExtractMethod(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"{startMarker} not found");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"{endMarker} not found after {startMarker}");
        return source[start..end];
    }

    private sealed class CapturingRootService(Result<AnonymousCredentialRootSnapshotCoreModel> result) : IAnonymousCredentialRootService
    {
        public int CallCount { get; private set; }

        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(result);
        }

        public void Invalidate()
        {
        }
    }

    private sealed class CapturingRevocationWitnessService(
        Result<AnonymousCredentialRevocationWitnessResponseCoreModel> result) : IAnonymousCredentialRevocationWitnessService
    {
        public int CallCount { get; private set; }

        public AnonymousCredentialRevocationWitnessRequestCoreModel LastRequest { get; private set; }

        public Task<Result<AnonymousCredentialRevocationWitnessResponseCoreModel>> CreateWitnessAsync(
            AnonymousCredentialRevocationWitnessRequestCoreModel request,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            LastRequest = request;
            return Task.FromResult(result);
        }
    }

    private sealed class CountingRootStore(params AnonymousCredentialRootRecord?[] records) : IAnonymousCredentialRootStore
    {
        private readonly Queue<AnonymousCredentialRootRecord?> _records = new(records);

        public int CallCount { get; private set; }
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
