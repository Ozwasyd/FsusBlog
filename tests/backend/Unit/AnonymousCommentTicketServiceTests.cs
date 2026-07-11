using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentTicketServiceTests
{
    private static readonly byte[] Nullifier = Enumerable.Repeat((byte)0xA1, 32).ToArray();
    private static readonly byte[] Proof = Enumerable.Repeat((byte)0xB2, 64).ToArray();
    private static readonly byte[] CredentialCommitment = Enumerable.Repeat((byte)0xB3, 32).ToArray();
    private static readonly byte[] CredentialRoot = Enumerable.Repeat((byte)0xC3, 32).ToArray();
    private static readonly byte[] RevocationRoot = Enumerable.Repeat((byte)0xD4, 32).ToArray();
    private static readonly string VerifyingKeyHash = new('e', 64);
    private static readonly string PolicyHash = new('9', 64);
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";
    private static readonly ZkProdPolicySnapshot ReadyZkProdPolicy = new(
        true,
        true,
        true,
        true,
        true,
        string.Empty);
    private static readonly ZkProdPolicySnapshot DisabledZkProdPolicy = new(
        false,
        false,
        false,
        true,
        false,
        "disabled");
    private static readonly byte[] PublicInputs = NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
        ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
        Scope: "article:42",
        CircuitId: AnonymousPrivacyContract.CircuitId,
        VerifyingKeyHash: VerifyingKeyHash,
        PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
        CredentialEpoch: 20260619,
        NullifierHash: Convert.ToHexStringLower(Nullifier),
        CredentialCommitment: Convert.ToHexStringLower(CredentialCommitment),
        CredentialRoot: Convert.ToHexStringLower(CredentialRoot),
        CredentialLevel: "strong_anonymous",
        ReputationBucket: "rep:low",
        PolicyHash: PolicyHash,
        Proof: ReadOnlyMemory<byte>.Empty,
        RevocationRoot: Convert.ToHexStringLower(RevocationRoot),
        IssuerPublicKeyHash: new('f', 64))).ToArray();

    [Fact]
    public async Task IssueAsync_ValidProof_ReturnsTicketAndStoresOnlyHashPayload()
    {
        var time = new MutableTimeProvider(DateTimeOffset.Parse("2026-06-19T00:00:00Z"));
        var cache = new CapturingUnifiedCache(time);
        var service = CreateService(cache: cache, time: time);

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(ValidRequest(), CancellationToken.None);

        Assert.True(result.Issued);
        Assert.Equal(AnonymousCommentTicketStatuses.Issued, result.Status);
        Assert.Equal(20260619, result.Response.CredentialEpoch);
        Assert.Equal("strong_anonymous", result.Response.CredentialLevel);
        Assert.Equal(time.GetUtcNow().AddSeconds(120).ToUnixTimeMilliseconds(), result.Response.TicketExpiresAtUnixMs);
        Assert.Equal(32, result.Response.Ticket.Length);
        Assert.Equal(ExpectedModerationSubjectHash(), result.Response.ModerationSubjectHash);

        CacheWrite write = Assert.Single(cache.Writes);
        string ticketHash = AnonymousCommentTicketService.HashTicket(result.Response.Ticket);
        Assert.Equal(CachePolicyId.AnonymousCommentTicket, write.PolicyId);
        Assert.Equal(ticketHash, write.Identity);
        Assert.Equal(TimeSpan.FromSeconds(120), write.Ttl);
        Assert.False(ContainsSubsequence(write.Value, result.Response.Ticket));

        CacheReadResult<AnonymousCommentTicketPayload> consumed = await service.ConsumeTicketAsync(result.Response.Ticket, CancellationToken.None);
        Assert.True(consumed.Hit);
        Assert.NotNull(consumed.Value);
        Assert.Equal(42, consumed.Value!.ArticleId);
        Assert.Equal("article:42", consumed.Value.Scope);
        Assert.Equal(Convert.ToHexStringLower(Nullifier), consumed.Value.NullifierHash);

        CacheReadResult<AnonymousCommentTicketPayload> replay = await service.ConsumeTicketAsync(result.Response.Ticket, CancellationToken.None);
        Assert.False(replay.Hit);
    }

    [Fact]
    public void ModerationSubjectHash_UsesPepperAndIgnoresScope()
    {
        string nullifierHash = Convert.ToHexStringLower(Nullifier);
        IConfiguration configuration = BuildConfiguration();

        byte[] first = AnonymousCommentTicketService.CreateModerationSubjectHash(nullifierHash, configuration);
        byte[] second = AnonymousCommentTicketService.CreateModerationSubjectHash(nullifierHash, configuration);

        Assert.Equal(first, second);
        Assert.Equal(ExpectedModerationSubjectHash(), first);
        MethodInfo method = typeof(AnonymousCommentTicketService).GetMethod(
            nameof(AnonymousCommentTicketService.CreateModerationSubjectHash),
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;
        Assert.Equal(
            new string?[] { "nullifierHash", "configuration" },
            method.GetParameters().Select(static parameter => parameter.Name).ToArray());
    }

    [Fact]
    public async Task IssueAsync_ExpiredRootFailsClosedBeforeProofVerification()
    {
        var proof = new RecordingProofService(ZkProofVerificationResult.Success());
        var service = CreateService(
            rootService: new FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel>.Failure(ErrorCode.InfraFailure, "anonymous_root_unavailable")),
            proofService: proof);

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(ValidRequest(), CancellationToken.None);

        Assert.False(result.Issued);
        Assert.Equal(AnonymousCommentTicketStatuses.RootExpired, result.Status);
        Assert.Empty(proof.Requests);
    }

    [Fact]
    public async Task IssueAsync_InvalidProofDoesNotReserveNullifierOrStoreTicket()
    {
        var cache = new CapturingUnifiedCache(new MutableTimeProvider(DateTimeOffset.UtcNow));
        var nullifiers = new RecordingNullifierService();
        var service = CreateService(
            cache: cache,
            nullifierService: nullifiers,
            proofService: new RecordingProofService(ZkProofVerificationResult.InvalidProof("backend detail")));

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(ValidRequest(), CancellationToken.None);

        Assert.False(result.Issued);
        Assert.Equal(AnonymousCommentTicketStatuses.ProofInvalid, result.Status);
        Assert.Empty(nullifiers.Reservations);
        Assert.Empty(cache.Writes);
        Assert.Equal("anonymous_comment_ticket_denied", result.PublicMessage);
    }

    [Fact]
    public async Task IssueAsync_PublicInputsMismatchFailsClosedBeforeProofVerification()
    {
        var proof = new RecordingProofService(ZkProofVerificationResult.Success());
        var service = CreateService(proofService: proof);
        AnonymousCommentTicketRequestCoreModel request = ValidRequest() with
        {
            PublicInputs = [0x01, 0x02, 0x03]
        };

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(request, CancellationToken.None);

        Assert.False(result.Issued);
        Assert.Equal(AnonymousCommentTicketStatuses.ValidationFailed, result.Status);
        Assert.Empty(proof.Requests);
    }

    [Fact]
    public async Task IssueAsync_UsesPublishedCommentPolicyHashForTicketTranscript()
    {
        const string publishedPolicyHash = "8888888888888888888888888888888888888888888888888888888888888888";
        var proof = new RecordingProofService(ZkProofVerificationResult.Success());
        var service = CreateService(
            proofService: proof,
            policyService: new FixedCommentPolicyService(new AnonymousCommentPolicySnapshot(
                true,
                true,
                false,
                CommentAuthorModes.Anonymous,
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)
            {
                SnapshotHash = publishedPolicyHash
            }));
        AnonymousCommentTicketRequestCoreModel request = ValidRequest() with
        {
            PublicInputs = PublicInputsForPolicy(publishedPolicyHash)
        };

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(request, CancellationToken.None);

        Assert.True(result.Issued);
        ZkProofVerificationRequest proofRequest = Assert.Single(proof.Requests);
        Assert.Equal(publishedPolicyHash, proofRequest.PolicyHash);
    }

    [Theory]
    [InlineData("blocked", AnonymousCommentTicketStatuses.NullifierBlocked)]
    [InlineData("scope_limit_exceeded", AnonymousCommentTicketStatuses.ScopeLimitExceeded)]
    public async Task IssueAsync_NullifierPrecheckFailuresDoNotStoreTicket(string reservationStatus, string expectedStatus)
    {
        var cache = new CapturingUnifiedCache(new MutableTimeProvider(DateTimeOffset.UtcNow));
        var nullifiers = new RecordingNullifierService(new NullifierReservationResult(false, reservationStatus, reservationStatus, 1));
        var service = CreateService(cache: cache, nullifierService: nullifiers);

        AnonymousCommentTicketIssueResult result = await service.IssueAsync(ValidRequest(), CancellationToken.None);

        Assert.False(result.Issued);
        Assert.Equal(expectedStatus, result.Status);
        Assert.Empty(cache.Writes);
        Assert.Single(nullifiers.Prechecks);
        Assert.Empty(nullifiers.Reservations);
    }

    [Fact]
    public void AnonymousCommentTicketIssue_RuntimeUsesPrecheckInsteadOfReservation()
    {
        string issue = RuntimeMetadataInspection.DescribeMethods(
            typeof(AnonymousCommentTicketService),
            nameof(AnonymousCommentTicketService.IssueAsync));
        string nullifierService = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentAnonymousNullifierService),
            nameof(CommentAnonymousNullifierService.PrecheckAsync));

        Assert.Contains("PrecheckAsync", issue, StringComparison.Ordinal);
        Assert.DoesNotContain("CheckAndReserveAsync", issue, StringComparison.Ordinal);
        Assert.Contains("RecordAnonymousNullifierPrecheck", nullifierService, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConsumeTicketAsync_ExpiredTtlReturnsMiss()
    {
        var time = new MutableTimeProvider(DateTimeOffset.Parse("2026-06-19T00:00:00Z"));
        var service = CreateService(cache: new CapturingUnifiedCache(time), time: time);
        AnonymousCommentTicketIssueResult result = await service.IssueAsync(ValidRequest(), CancellationToken.None);

        time.Advance(TimeSpan.FromSeconds(121));
        CacheReadResult<AnonymousCommentTicketPayload> consumed = await service.ConsumeTicketAsync(result.Response.Ticket, CancellationToken.None);

        Assert.False(consumed.Hit);
    }

    [Fact]
    public async Task IssueAsync_ConcurrentSameNullifierPrechecksWithoutSpendingNullifier()
    {
        var nullifiers = new ConcurrentPrecheckNullifierService();
        var service = CreateService(nullifierService: nullifiers);

        AnonymousCommentTicketIssueResult[] results = await Task.WhenAll(
            Enumerable.Range(0, 16).Select(_ => service.IssueAsync(ValidRequest(), CancellationToken.None)));

        Assert.Equal(16, results.Count(static item => item.Issued));
        Assert.Equal(16, nullifiers.PrecheckCount);
        Assert.Equal(0, nullifiers.ReservationCount);
        Assert.Equal(0, nullifiers.ConsumeCount);
    }

    [Fact]
    public async Task BinaryEndpoint_IssuesAnonymousTicketFrame()
    {
        var aeds = new AedsEncoder();
        var service = CreateService();
        var proofService = new RecordingProofService(ZkProofVerificationResult.Success(), ReadyZkProdPolicy);
        DefaultHttpContext context = CreateContext(
            aeds,
            AedsFrameType.AnonymousCommentTicketRequest,
            PodBinaryCodec.EncodeAnonymousCommentTicketRequest(ValidRequest()));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCommentTicketAsync(
            context,
            aeds,
            service,
            proofService,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.AnonymousCommentTicketResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCommentTicketResponse(decoded.Payload, out var response));
        Assert.Equal(32, response.Ticket.Length);
        Assert.Equal(ExpectedModerationSubjectHash(), response.ModerationSubjectHash);
    }

    [Fact]
    public async Task BinaryEndpoint_ZkProdUnavailableFailsClosedBeforePayloadDecodeOrTicketIssue()
    {
        var aeds = new AedsEncoder();
        DefaultHttpContext context = CreateContext(aeds, AedsFrameType.CommentCreateV2Request, "not-ticket"u8.ToArray());
        var proofService = new RecordingProofService(ZkProofVerificationResult.Success(), DisabledZkProdPolicy);

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCommentTicketAsync(
            context,
            aeds,
            new ThrowingTicketService(),
            proofService,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var error));
        Assert.Equal("anonymous_comment_ticket_unavailable", PodBinaryCodec.ToErrorDetail(error).Message);
        Assert.Empty(proofService.Requests);
    }

    [Fact]
    public async Task BinaryEndpoint_RequiresStrongAnonymousAndBinaryFrames()
    {
        await using WebApplication app = EndpointContractApplication.Create();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/comment/anonymous-ticket",
            HttpMethods.Post);
        Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.NotNull(endpoint.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.HandleAnonymousCommentTicketAsync));
        Assert.Contains("CurrentZkProdPolicy", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("anonymous_comment_ticket_unavailable", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryDecodeAnonymousCommentTicketRequest", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("WriteAnonymousCommentTicketResponse", runtimeShape, StringComparison.Ordinal);
    }

    private static AnonymousCommentTicketService CreateService(
        CapturingUnifiedCache? cache = null,
        MutableTimeProvider? time = null,
        IAnonymousCredentialRootService? rootService = null,
        RecordingProofService? proofService = null,
        ICommentAnonymousNullifierService? nullifierService = null,
        IAnonymousCommentPolicyService? policyService = null)
    {
        time ??= new MutableTimeProvider(DateTimeOffset.Parse("2026-06-19T00:00:00Z"));
        cache ??= new CapturingUnifiedCache(time);
        rootService ??= new FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(CreateRootSnapshot(time)));
        proofService ??= new RecordingProofService(ZkProofVerificationResult.Success());
        nullifierService ??= new RecordingNullifierService();
        policyService ??= new FixedCommentPolicyService(proofService.CurrentCommentPolicy);
        return new AnonymousCommentTicketService(
            cache,
            rootService,
            proofService,
            nullifierService,
            policyService,
            BuildConfiguration(),
            time);
    }

    private static AnonymousCommentTicketRequestCoreModel ValidRequest()
        => new(
            ArticleId: 42,
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            CredentialEpoch: 20260619,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
            Scope: "article:42",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: VerifyingKeyHash,
            NullifierHash: Nullifier,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            RevocationRoot: RevocationRoot,
            CredentialLevel: "strong_anonymous",
            ReputationBucket: "rep:low",
            Groth16Proof: Proof,
            PublicInputs: PublicInputs);

    private static byte[] PublicInputsForPolicy(string policyHash)
        => NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
            Scope: "article:42",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: VerifyingKeyHash,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            CredentialEpoch: 20260619,
            NullifierHash: Convert.ToHexStringLower(Nullifier),
            CredentialCommitment: Convert.ToHexStringLower(CredentialCommitment),
            CredentialRoot: Convert.ToHexStringLower(CredentialRoot),
            CredentialLevel: "strong_anonymous",
            ReputationBucket: "rep:low",
            PolicyHash: policyHash,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Convert.ToHexStringLower(RevocationRoot),
            IssuerPublicKeyHash: new('f', 64))).ToArray();

    private static AnonymousCredentialRootSnapshotCoreModel CreateRootSnapshot(TimeProvider time)
        => new(
            CredentialEpoch: 20260619,
            RootExpiresAtUnixMs: time.GetUtcNow().AddMinutes(10).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: time.GetUtcNow().AddMinutes(20).ToUnixTimeMilliseconds(),
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: VerifyingKeyHash,
            IssuerPublicKeyHash: new('f', 64),
            CredentialRoot: CredentialRoot,
            RevocationRoot: RevocationRoot,
            CircuitMetadata: []);

    private static byte[] ExpectedModerationSubjectHash()
        => HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(ModerationPepper),
            Encoding.UTF8.GetBytes(Convert.ToHexStringLower(Nullifier)));

    private static IConfiguration BuildConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:AnonymousCommentTicketTtlSeconds"] = "120",
                ["Moderation:Pepper"] = ModerationPepper
            })
            .Build();

    private static DefaultHttpContext CreateContext(AedsEncoder aeds, AedsFrameType frameType, byte[] payload)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment/anonymous-ticket";
        context.Request.Headers.Accept = "application/octet-stream";
        byte[] frame = aeds.Encode(frameType, payload);
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frame.Length;
        context.Request.Body = new MemoryStream(frame);
        context.Response.Body = new MemoryStream();
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

    private sealed class FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel> result) : IAnonymousCredentialRootService
    {
        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(result);

        public void Invalidate()
        {
        }
    }

    private sealed class FixedCommentPolicyService(AnonymousCommentPolicySnapshot snapshot) : IAnonymousCommentPolicyService
    {
        public AnonymousCommentPolicySnapshot Current => snapshot;

        public Task<AnonymousCommentPolicySnapshot> GetCurrentAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null)
            => throw new NotSupportedException();

        public Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync(
            AnonymousCommentPolicyUpdateRequest request,
            long? adminPrincipalId = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected)
            => CommentAuthorModeDecision.Allow(snapshot.DefaultAuthorMode);

        public Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync(
            string? requestedAuthorMode,
            bool publicSendExplicitlySelected,
            CancellationToken cancellationToken = default)
            => Task.FromResult(EvaluateAuthorMode(requestedAuthorMode, publicSendExplicitlySelected));
    }

    private sealed class RecordingProofService(
        ZkProofVerificationResult result,
        ZkProdPolicySnapshot? zkProdPolicy = null) : IZkAnonymousProofService
    {
        public List<ZkProofVerificationRequest> Requests { get; } = [];

        public AnonymousCommentPolicySnapshot CurrentCommentPolicy => new(true, true, true, CommentAuthorModes.Anonymous, ["zh-CN"])
        {
            SnapshotHash = PolicyHash
        };

        public ZkAnonymousPolicySnapshot CurrentZkPolicy => new(true, true, "comment.create", []);

        public ZkProdPolicySnapshot CurrentZkProdPolicy { get; } = zkProdPolicy ?? ReadyZkProdPolicy;

        public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(result);
        }
    }

    private sealed class ThrowingTicketService : IAnonymousCommentTicketService
    {
        public Task<AnonymousCommentTicketIssueResult> IssueAsync(
            AnonymousCommentTicketRequestCoreModel request,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ticket service must not be called when ZK-Prod is unavailable");

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ticket consume must not be called from issue endpoint");
    }

    private sealed class RecordingNullifierService(NullifierReservationResult? result = null) : ICommentAnonymousNullifierService
    {
        private readonly NullifierReservationResult _result = result ?? new(true, "reserved", "reserved", 0);

        public List<(string NullifierHash, string Scope)> Prechecks { get; } = [];

        public List<(string NullifierHash, string Scope)> Reservations { get; } = [];

        public Task<NullifierReservationResult> PrecheckAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Prechecks.Add((nullifierHash, scope));
            return Task.FromResult(_result);
        }

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Reservations.Add((nullifierHash, scope));
            return Task.FromResult(_result);
        }

        public Task<NullifierReservationResult> TryConsumeAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
            => Task.FromResult(_result);

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class ConcurrentPrecheckNullifierService : ICommentAnonymousNullifierService
    {
        private int _precheckCount;
        private int _reservationCount;
        private int _consumeCount;

        public int PrecheckCount => _precheckCount;
        public int ReservationCount => _reservationCount;
        public int ConsumeCount => _consumeCount;

        public Task<NullifierReservationResult> PrecheckAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _precheckCount);
            return Task.FromResult(new NullifierReservationResult(true, "prechecked", "prechecked", 0));
        }

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _reservationCount);
            return Task.FromResult(new NullifierReservationResult(false, "scope_limit_exceeded", "scope_limit_exceeded", 1));
        }

        public Task<NullifierReservationResult> TryConsumeAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _consumeCount);
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 1));
        }

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan value) => _utcNow = _utcNow.Add(value);
    }

    private sealed record CacheWrite(CachePolicyId PolicyId, string Identity, byte[] Value, TimeSpan? Ttl);

    private sealed class CapturingUnifiedCache(MutableTimeProvider time) : IUnifiedCache
    {
        private readonly Dictionary<(CachePolicyId PolicyId, string Identity), (byte[] Value, DateTimeOffset? ExpiresAt)> _store = [];

        public List<CacheWrite> Writes { get; } = [];

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            byte[] copy = [.. value];
            Writes.Add(new CacheWrite(policyId, identity, copy, l2TtlOverride));
            _store[(policyId, identity)] = (copy, l2TtlOverride.HasValue ? time.GetUtcNow().Add(l2TtlOverride.Value) : null);
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            if (!_store.Remove((policyId, identity), out var entry) ||
                (entry.ExpiresAt.HasValue && entry.ExpiresAt.Value <= time.GetUtcNow()))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var decoded = decoder(entry.Value);
            return Task.FromResult(decoded.Success
                ? new CacheReadResult<T>(true, decoded.Value)
                : new CacheReadResult<T>(false, default));
        }

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<byte[]>(false, default));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(new NoopAsyncDisposable());
    }

    private sealed class NoopAsyncDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FixedHotArticlesCacheVersionProvider : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => 0;

        public string BuildVersionedHotArticlesIdentity(string identity) => identity;
    }

    private static bool ContainsSubsequence(byte[] source, byte[] candidate)
    {
        if (candidate.Length == 0 || source.Length < candidate.Length)
        {
            return false;
        }

        for (int i = 0; i <= source.Length - candidate.Length; i++)
        {
            if (source.AsSpan(i, candidate.Length).SequenceEqual(candidate))
            {
                return true;
            }
        }

        return false;
    }
}
