using System.Net;
using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentTicketEndpointFilterTests
{
    private static readonly byte[] s_nullifier = Enumerable.Repeat((byte)0xA1, 32).ToArray();
    private static readonly byte[] s_credentialRoot = Enumerable.Repeat((byte)0xC3, 32).ToArray();
    private static readonly byte[] s_revocationRoot = Enumerable.Repeat((byte)0xD4, 32).ToArray();
    private static readonly string s_verifyingKeyHash = new('e', 64);
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-08-30T00:00:00Z");
    private const string ModerationPepper = "anonymous-ticket-filter-test-moderation-pepper";
    private const string SecretCookie = "AccessToken=secret-cookie";
    private const string SecretBearer = "secret-bearer-token";
    private const string SecretBridge = "secret-authoring-bridge-token";
    private const string SecretProof = "secret-proof-material";

    [Theory]
    [InlineData(IdentityContamination.Cookie)]
    [InlineData(IdentityContamination.Authorization)]
    [InlineData(IdentityContamination.CookieAndAuthorization)]
    [InlineData(IdentityContamination.AuthenticatedPrincipal)]
    [InlineData(IdentityContamination.AuthoringBridgeHeader)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-real-endpoint-identity-contamination-rejects-before-every-ticket-boundary")]
    public async Task RealEndpoint_IdentityContaminationRejectsBeforeEveryTicketBoundary(
        IdentityContamination contamination)
    {
        await using var server = await AnonymousTicketPipelineServer.CreateAsync();
        PipelineResponse response = await server.SendAsync(server.ValidFrame, contamination);

        Assert.True(
            response.StatusCode == HttpStatusCode.Forbidden,
            $"Unexpected status {response.StatusCode}: {Encoding.UTF8.GetString(response.Body)}");
        ErrorDetail error = ReadError(response);
        Assert.Equal(ErrorCode.Forbidden, error.Code);
        Assert.Equal(RejectIdentifiedPrincipalFilter.ErrorDetails, error.Details);
        Assert.Equal(RejectIdentifiedPrincipalFilter.PublicErrorMessage, error.Message);
        server.AssertNoTicketBoundaryCalls();
        server.AssertSecretsWereNotLogged();
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task RealEndpoint_ConcurrentIdentityContaminationNeverEntersExpensiveBoundaries()
    {
        const int Attempts = 32;
        await using var server = await AnonymousTicketPipelineServer.CreateAsync();

        var requests = new Func<Task<PipelineResponse>>[Attempts];
        for (int index = 0; index < Attempts; index += 1)
        {
            IdentityContamination contamination = (index % 3) switch
            {
                0 => IdentityContamination.Cookie,
                1 => IdentityContamination.Authorization,
                _ => IdentityContamination.AuthoringBridgeHeader
            };
            requests[index] = () => server.SendAsync(server.ValidFrame, contamination);
        }

        PipelineResponse[] responses = await RealConcurrencyHarness.RunAsync(requests);

        Assert.All(responses, static response => Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode));
        Assert.All(responses.Select(ReadError), static error => Assert.Equal(
            RejectIdentifiedPrincipalFilter.ErrorDetails,
            error.Details));

        server.AssertNoTicketBoundaryCalls();
        server.AssertSecretsWereNotLogged();
    }

    [Theory]
    [InlineData(InvalidPayloadKind.MalformedAeds)]
    [InlineData(InvalidPayloadKind.OversizedProof)]
    [InlineData(InvalidPayloadKind.OrdinaryValidation)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-real-endpoint-identity-contamination-precedes-payload-and-validation-failures")]
    public async Task RealEndpoint_IdentityContaminationPrecedesPayloadAndValidationFailures(
        InvalidPayloadKind payloadKind)
    {
        await using var server = await AnonymousTicketPipelineServer.CreateAsync();
        byte[] frame = payloadKind switch
        {
            InvalidPayloadKind.MalformedAeds => [0x01, 0x02, 0x03],
            InvalidPayloadKind.OversizedProof => server.OversizedProofFrame,
            InvalidPayloadKind.OrdinaryValidation => server.InvalidArticleFrame,
            _ => throw new ArgumentOutOfRangeException(nameof(payloadKind), payloadKind, null)
        };
        PipelineResponse response = await server.SendAsync(frame, IdentityContamination.CookieAndAuthorization);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(
            RejectIdentifiedPrincipalFilter.ErrorDetails,
            ReadError(response).Details);
        server.AssertNoTicketBoundaryCalls();
        server.AssertSecretsWereNotLogged();
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task RealEndpoint_CleanValidRequestEntersDecodeProofNullifierAndTicketStore()
    {
        await using var server = await AnonymousTicketPipelineServer.CreateAsync();
        PipelineResponse response = await server.SendAsync(server.ValidFrame, IdentityContamination.None);

        Assert.True(
            response.StatusCode == HttpStatusCode.OK,
            $"Unexpected status {response.StatusCode}: {Encoding.UTF8.GetString(response.Body)}");
        AedsDecodeResult decoded = ReadFrame(response);
        Assert.Equal(AedsFrameType.AnonymousCommentTicketResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCommentTicketResponse(decoded.Payload, out var ticket));
        Assert.Equal(32, ticket.Ticket.Length);
        Assert.Equal(1, server.RequestContext.ReadFrameCalls);
        Assert.Equal(1, server.Root.ReadCalls);
        Assert.Equal(1, server.Proof.VerifyCalls);
        Assert.Equal(1, server.Nullifier.PrecheckCalls);
        Assert.Equal(0, server.Nullifier.ReservationCalls);
        Assert.Equal(1, server.TicketStore.WriteCalls);
    }

    private static ErrorDetail ReadError(PipelineResponse response)
    {
        AedsDecodeResult decoded = ReadFrame(response);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out ApiErrorPod pod));
        return PodBinaryCodec.ToErrorDetail(pod);
    }

    private static AedsDecodeResult ReadFrame(PipelineResponse response)
    {
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(response.Body);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    public enum IdentityContamination
    {
        None,
        Cookie,
        Authorization,
        CookieAndAuthorization,
        AuthenticatedPrincipal,
        AuthoringBridgeHeader
    }

    public enum InvalidPayloadKind
    {
        MalformedAeds,
        OversizedProof,
        OrdinaryValidation
    }

    private sealed record PipelineResponse(HttpStatusCode StatusCode, byte[] Body);

    private sealed class AnonymousTicketPipelineServer : IAsyncDisposable
    {
        private readonly WebApplication _application;
        private readonly TestServer _server;

        private AnonymousTicketPipelineServer(
            WebApplication application,
            TestServer server,
            RecordingBinaryEndpointRequestContext requestContext,
            RecordingRootService root,
            RecordingProofService proof,
            RecordingNullifierService nullifier,
            RecordingTicketStore ticketStore,
            CapturingLoggerProvider logs,
            byte[] validFrame,
            byte[] oversizedProofFrame,
            byte[] invalidArticleFrame)
        {
            _application = application;
            _server = server;
            RequestContext = requestContext;
            Root = root;
            Proof = proof;
            Nullifier = nullifier;
            TicketStore = ticketStore;
            Logs = logs;
            ValidFrame = validFrame;
            OversizedProofFrame = oversizedProofFrame;
            InvalidArticleFrame = invalidArticleFrame;
        }

        public RecordingBinaryEndpointRequestContext RequestContext
        {
            get;
        }

        public RecordingRootService Root
        {
            get;
        }

        public RecordingProofService Proof
        {
            get;
        }

        public RecordingNullifierService Nullifier
        {
            get;
        }

        public RecordingTicketStore TicketStore
        {
            get;
        }

        public CapturingLoggerProvider Logs
        {
            get;
        }

        public byte[] ValidFrame
        {
            get;
        }

        public byte[] OversizedProofFrame
        {
            get;
        }

        public byte[] InvalidArticleFrame
        {
            get;
        }

        public static async Task<AnonymousTicketPipelineServer> CreateAsync()
        {
            var aeds = new AedsEncoder();
            var requestContext = new RecordingBinaryEndpointRequestContext();
            var root = new RecordingRootService();
            var proof = new RecordingProofService();
            var nullifier = new RecordingNullifierService();
            var ticketStore = new RecordingTicketStore();
            var policy = new FixedCommentPolicyService(proof.CurrentCommentPolicy);
            var logs = new CapturingLoggerProvider();

            WebApplicationBuilder builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AllowedHosts"] = "*",
                ["AnonymousIdentity:AnonymousCommentTicketTtlSeconds"] = "120",
                ["Moderation:Pepper"] = ModerationPepper,
                ["RateLimiting:PublicReadPermitLimit"] = "100000"
            });
            EndpointContractApplication.AddContractServices(builder);
            builder.Logging.ClearProviders();
            builder.Logging.AddProvider(logs);
            builder.Services.RemoveAll<IBinaryEndpointRequestContext>();
            builder.Services.RemoveAll<IAnonymousCommentTicketService>();
            builder.Services.RemoveAll<IZkAnonymousProofService>();
            builder.Services.AddSingleton<IBinaryEndpointRequestContext>(requestContext);
            builder.Services.AddSingleton<IZkAnonymousProofService>(proof);
            builder.Services.AddSingleton<IAnonymousCommentTicketService>(new AnonymousCommentTicketService(
                ticketStore,
                ticketStore,
                root,
                proof,
                nullifier,
                policy,
                builder.Configuration,
                new FixedTimeProvider(s_now),
                ticketStore));

            WebApplication app = builder.Build();
            app.UseRouting();
            app.Use(async (context, next) =>
            {
                if (context.Request.Headers.ContainsKey("X-Test-Authenticated-Principal"))
                {
                    context.User = new ClaimsPrincipal(new ClaimsIdentity(
                        [new Claim(ClaimTypes.NameIdentifier, "42")],
                        "test-authentication"));
                }

                await next(context);
            });
            app.UseRateLimiter();
            app.MapBinaryEndpoints();
            await app.StartAsync();
            TestServer server = app.GetTestServer();

            AnonymousCommentTicketRequestCoreModel valid = CreateTicketRequest(proof.CurrentCommentPolicy);
            return new AnonymousTicketPipelineServer(
                app,
                server,
                requestContext,
                root,
                proof,
                nullifier,
                ticketStore,
                logs,
                EncodeFrame(aeds, valid),
                EncodeFrame(aeds, valid with
                {
                    Groth16Proof = Enumerable.Repeat((byte)0xF1, AnonymousPrivacyContract.MaxGroth16ProofBytes + 1).ToArray()
                }),
                EncodeFrame(aeds, valid with
                {
                    ArticleId = 0
                }));
        }

        public async Task<PipelineResponse> SendAsync(
            byte[] frame,
            IdentityContamination contamination)
        {
            var responseBody = new MemoryStream();
            HttpContext context = await _server.SendAsync(context =>
            {
                context.Request.Method = HttpMethods.Post;
                context.Request.Scheme = "https";
                context.Request.Host = new HostString("console.example.test");
                context.Request.Path = "/api/binary/comment/anonymous-ticket";
                context.Request.ContentType = "application/octet-stream";
                context.Request.ContentLength = frame.Length;
                context.Request.Body = new MemoryStream(frame, writable: false);
                context.Response.Body = responseBody;
                ApplyContamination(context, contamination);
            }, CancellationToken.None);
            await context.Response.CompleteAsync();
            return new PipelineResponse((HttpStatusCode)context.Response.StatusCode, responseBody.ToArray());
        }

        public void AssertNoTicketBoundaryCalls()
        {
            Assert.Equal(0, RequestContext.ReadFrameCalls);
            Assert.Equal(0, Root.ReadCalls);
            Assert.Equal(0, Proof.VerifyCalls);
            Assert.Equal(0, Nullifier.PrecheckCalls);
            Assert.Equal(0, Nullifier.ReservationCalls);
            Assert.Equal(0, TicketStore.WriteCalls);
        }

        public void AssertSecretsWereNotLogged()
        {
            string rendered = string.Join('\n', Logs.Messages);
            Assert.DoesNotContain(SecretCookie, rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(SecretBearer, rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(SecretBridge, rendered, StringComparison.Ordinal);
            Assert.DoesNotContain(SecretProof, rendered, StringComparison.Ordinal);
        }

        public async ValueTask DisposeAsync()
        {
            await _application.DisposeAsync();
            Logs.Dispose();
        }

        private static void ApplyContamination(HttpContext context, IdentityContamination contamination)
        {
            switch (contamination)
            {
                case IdentityContamination.None:
                    break;
                case IdentityContamination.Cookie:
                    context.Request.Headers.Cookie = SecretCookie;
                    break;
                case IdentityContamination.Authorization:
                    context.Request.Headers.Authorization = $"Bearer {SecretBearer}";
                    break;
                case IdentityContamination.CookieAndAuthorization:
                    context.Request.Headers.Cookie = SecretCookie;
                    context.Request.Headers.Authorization = $"Bearer {SecretBearer}";
                    break;
                case IdentityContamination.AuthenticatedPrincipal:
                    context.Request.Headers["X-Test-Authenticated-Principal"] = "true";
                    break;
                case IdentityContamination.AuthoringBridgeHeader:
                    context.Request.Headers[RejectIdentifiedPrincipalFilter.AccessTokenBridgeHeaderName] = SecretBridge;
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(contamination), contamination, null);
            }
        }

        private static byte[] EncodeFrame(AedsEncoder aeds, AnonymousCommentTicketRequestCoreModel request)
            => aeds.Encode(
                AedsFrameType.AnonymousCommentTicketRequest,
                PodBinaryCodec.EncodeAnonymousCommentTicketRequest(request));

        private static AnonymousCommentTicketRequestCoreModel CreateTicketRequest(
            AnonymousCommentPolicySnapshot policy)
        {
            string scope = "comment:v1:article:42:top";
            byte[] proof = Encoding.UTF8.GetBytes(SecretProof);
            byte[] publicInputs = NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
                ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
                Scope: scope,
                CircuitId: AnonymousPrivacyContract.CircuitId,
                VerifyingKeyHash: s_verifyingKeyHash,
                PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
                NullifierHash: Convert.ToHexStringLower(s_nullifier),
                CredentialRoot: Convert.ToHexStringLower(s_credentialRoot),
                PolicyHash: AnonymousCommentPolicySnapshotHash.Resolve(policy),
                IsEligible: true,
                MayComment: true,
                RateClass: AnonymousPrivacyContract.CommonRateClass,
                RequiresModeration: false,
                Proof: ReadOnlyMemory<byte>.Empty,
                RevocationRoot: Convert.ToHexStringLower(s_revocationRoot),
                IssuerPublicKeyHash: s_issuerPublicKeyHash)).ToArray();
            return new AnonymousCommentTicketRequestCoreModel(
                ArticleId: 42,
                ParentId: null,
                RootId: null,
                ReplyToCommentId: null,
                CircuitNumericId: 7,
                PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
                ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
                Scope: scope,
                CircuitId: AnonymousPrivacyContract.CircuitId,
                VerifyingKeyHash: s_verifyingKeyHash,
                NullifierHash: s_nullifier,
                CredentialRoot: s_credentialRoot,
                RevocationRoot: s_revocationRoot,
                IsEligible: true,
                MayComment: true,
                RateClass: AnonymousPrivacyContract.CommonRateClass,
                RequiresModeration: false,
                Groth16Proof: proof,
                PublicInputs: publicInputs);
        }
    }

    private sealed class RecordingBinaryEndpointRequestContext : IBinaryEndpointRequestContext
    {
        private readonly BinaryEndpointRequestContext _inner = new(
            new BinaryRequestBinder(),
            new FixedHotArticlesCacheVersionProvider());
        private int _readFrameCalls;

        public int ReadFrameCalls => Volatile.Read(ref _readFrameCalls);

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Interlocked.Increment(ref _readFrameCalls);
            return _inner.ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken, maxFrameBytes);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Interlocked.Increment(ref _readFrameCalls);
            return _inner.ReadFrameAsync(httpContext, aeds, expectedFrameTypes, cancellationToken, maxFrameBytes);
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken)
            => _inner.ReadNameMutationAsync(httpContext, aeds, expectedFrameType, cancellationToken);

        public string BuildArticleViewerIdentity(HttpContext context, int articleId)
            => _inner.BuildArticleViewerIdentity(context, articleId);

        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
            => _inner.GetArticleListCacheVersionAsync(cache);

        public string BuildArticleHotCacheIdentity(int count)
            => _inner.BuildArticleHotCacheIdentity(count);

        public string? GetDeviceFingerprint(HttpContext context)
            => _inner.GetDeviceFingerprint(context);

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
            => _inner.TryReadMfaProof(context, out proofToken);
    }

    private sealed class FixedHotArticlesCacheVersionProvider : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => 0;

        public string BuildVersionedHotArticlesIdentity(string identity)
            => $"{identity}:0";
    }

    private sealed class RecordingRootService : IAnonymousCredentialRootService
    {
        private int _readCalls;

        public int ReadCalls => Volatile.Read(ref _readCalls);

        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _readCalls);
            return Task.FromResult(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(new(
                CredentialEpoch: 20260830,
                RootExpiresAtUnixMs: s_now.AddMinutes(10).ToUnixTimeMilliseconds(),
                RootGraceExpiresAtUnixMs: s_now.AddMinutes(20).ToUnixTimeMilliseconds(),
                CircuitNumericId: 7,
                PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
                ZkAnonymousEnabled: true,
                VerifierConfigured: true,
                CircuitId: AnonymousPrivacyContract.CircuitId,
                VerifyingKeyHash: s_verifyingKeyHash,
                IssuerPublicKeyHash: s_issuerPublicKeyHash,
                CredentialRoot: s_credentialRoot,
                RevocationRoot: s_revocationRoot,
                CircuitMetadata: Encoding.UTF8.GetBytes("{\"anonymity_sets\":[{\"is_eligible\":true,\"may_comment\":true,\"rate_class\":\"common\",\"requires_moderation\":false,\"size\":20}]}"))));
        }

        public void Invalidate()
        {
        }
    }

    private sealed class RecordingProofService : IZkAnonymousProofService
    {
        private int _verifyCalls;

        public int VerifyCalls => Volatile.Read(ref _verifyCalls);

        public AnonymousCommentPolicySnapshot CurrentCommentPolicy
        {
            get;
        } = new(
            true,
            true,
            true,
            CommentAuthorModes.ZkAnonymous,
            ["zh-CN"]);

        public ZkAnonymousPolicySnapshot CurrentZkPolicy => new(true, true, "comment.create", []);

        public ZkCommentPolicySnapshot CurrentZkCommentPolicy => new(true, true, true, true, true, string.Empty);

        public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _verifyCalls);
            return Task.FromResult(ZkProofVerificationResult.Success());
        }
    }

    private sealed class RecordingNullifierService : ICommentAnonymousNullifierService
    {
        private int _precheckCalls;
        private int _reservationCalls;

        public int PrecheckCalls => Volatile.Read(ref _precheckCalls);

        public int ReservationCalls => Volatile.Read(ref _reservationCalls);

        public Task<NullifierReservationResult> PrecheckAsync(
            string nullifierHash,
            string scope,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _precheckCalls);
            return Task.FromResult(new NullifierReservationResult(true, "prechecked", "prechecked", 0));
        }

        public Task<NullifierReservationResult> CheckAndReserveAsync(
            string nullifierHash,
            string scope,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _reservationCalls);
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 0));
        }

        public Task<bool> IncrementUsageAsync(
            string nullifierHash,
            string scope,
            long commentId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> BlockAsync(
            string nullifierHash,
            string scope,
            string reason,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class RecordingTicketStore : ICacheRawWriter, ICacheOneTimeStore, ICacheRawReader
    {
        private int _writeCalls;

        public int WriteCalls => Volatile.Read(ref _writeCalls);

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _writeCalls);
            return Task.CompletedTask;
        }

        public Task SetNegativeAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<bool> ConsumeOnceAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<byte[]>(false, default));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));
    }

    private sealed class FixedCommentPolicyService(AnonymousCommentPolicySnapshot snapshot)
        : IAnonymousCommentPolicyService
    {
        public AnonymousCommentPolicySnapshot Current => snapshot;

        public Task<AnonymousCommentPolicySnapshot> GetCurrentAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public AnonymousCommentPolicySnapshot UpdatePolicy(
            AnonymousCommentPolicyUpdateRequest request,
            long? adminPrincipalId = null)
            => throw new NotSupportedException();

        public Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync(
            AnonymousCommentPolicyUpdateRequest request,
            long? adminPrincipalId = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public CommentAuthorModeDecision EvaluateAuthorMode(
            string? requestedAuthorMode,
            bool publicSendExplicitlySelected)
            => CommentAuthorModeDecision.Allow(snapshot.DefaultAuthorMode);

        public Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync(
            string? requestedAuthorMode,
            bool publicSendExplicitlySelected,
            CancellationToken cancellationToken = default)
            => Task.FromResult(EvaluateAuthorMode(requestedAuthorMode, publicSendExplicitlySelected));
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<string> _messages = new();

        public IReadOnlyCollection<string> Messages => _messages.ToArray();

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(_messages);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger(System.Collections.Concurrent.ConcurrentQueue<string> messages)
            : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => messages.Enqueue(formatter(state, exception));
        }
    }
}
