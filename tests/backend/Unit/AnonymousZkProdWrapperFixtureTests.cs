using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AnonymousZkProdWrapperFixtureTests(PostgresSchemaMigrationFixture fixture)
{
    private const int ArticleId = 42;
    private const int OtherArticleId = 43;
    private const long CredentialEpoch = 20260619;
    private const uint CircuitNumericId = 7;
    private static readonly byte[] s_credentialRoot = Enumerable.Repeat((byte)0xC3, 32).ToArray();
    private static readonly byte[] s_revocationRoot = Enumerable.Repeat((byte)0xD4, 32).ToArray();
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private static readonly string s_policyHash = AnonymousCommentPolicySnapshotHash.Compute(AnonymousCommentPolicySnapshot.Default with
    {
        ZkAnonymousEnabled = true
    });

    [Fact]
    public async Task WrapperFixture_HappyPath_NativeVerifierTicketSubmitCreatesApprovedAnonymousComment()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        var nullifiers = new RecordingNullifierService();
        AnonymousCommentTicketService ticketService = CreateTicketService(temp, nativeLibrary, nullifiers: nullifiers);
        byte[] nullifier = ScopeNullifier(ArticleId);
        byte[] proof = ComputeFixtureProof(temp, ArticleId, nullifier);

        AnonymousCommentTicketIssueResult ticket = await ticketService.IssueAsync(
            ValidTicketRequest(temp, ArticleId, nullifier, proof),
            CancellationToken.None);

        Assert.True(ticket.Issued, ticket.Status);
        Assert.Equal(1, nativeLibrary.CallCount);
        Assert.Equal(AnonymousPrivacyContract.CommonRateClass, ticket.Response.RateClass);

        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, ArticleId);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentCommandService commentService = CreateCommentService(temp, nativeLibrary, db, ticketService, nullifiers, dispatcher);

        bool created = await commentService.CreateStrongAnonymousCommentAsync(
            CreateSubmitRequest(ticket.Response.Ticket),
            RegionDecision(),
            CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Null(comment.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
        Assert.Equal(Hex(nullifier), comment.AnonymousNullifierHash);
        Assert.Equal("comment:v1:article:42:top", comment.AnonymousScope);
        Assert.Null(comment.CredentialLevel);
        Assert.Null(comment.ReputationBucket);
        Assert.Null(comment.AccountAgeBucket);
        Assert.Equal(AnonymousPrivacyContract.CommonRateClass, comment.AnonymousRateClass);
        Assert.False(comment.AnonymousRequiresModeration);
        // RegionDecision.HideUntilReviewed forces an initial Hidden disposition.
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);

        CommentRegionCompliance compliance = Assert.Single(db.Queryable<CommentRegionCompliance>().ToList());
        Assert.Equal(comment.Id, compliance.CommentId);
        Assert.Equal(RegionCodes.Singapore, compliance.SubmitRegion);
        Assert.True(compliance.RequiresManualReview);

        var increment = Assert.Single(nullifiers.Increments);
        Assert.Equal(Hex(nullifier), increment.NullifierHash);
        Assert.Equal("comment:v1:article:42:top", increment.Scope);
        Assert.Equal(comment.Id, increment.CommentId);

        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Equal(ArticleId, scope.ArticleId);
        Assert.Null(scope.AccountId);
        // Hidden-until-reviewed comments do not change the public article projection.
        Assert.False(scope.PublicArticleChanged);
    }

    [Fact]
    public async Task WrapperFixture_TamperedProofFailsBeforeTicketOrNullifierReservation()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        var nullifiers = new RecordingNullifierService();
        var cache = new CapturingUnifiedCache(new MutableTimeProvider(DateTimeOffset.Parse("2026-06-19T00:00:00Z")));
        AnonymousCommentTicketService ticketService = CreateTicketService(
            temp,
            nativeLibrary,
            cache: cache,
            nullifiers: nullifiers);
        byte[] nullifier = ScopeNullifier(ArticleId);
        byte[] proof = ComputeFixtureProof(temp, ArticleId, nullifier);
        proof[0] ^= 0xff;

        AnonymousCommentTicketIssueResult ticket = await ticketService.IssueAsync(
            ValidTicketRequest(temp, ArticleId, nullifier, proof),
            CancellationToken.None);

        Assert.False(ticket.Issued);
        Assert.Equal(AnonymousCommentTicketStatuses.ProofInvalid, ticket.Status);
        Assert.Equal(1, nativeLibrary.CallCount);
        Assert.Empty(cache.Writes);
        Assert.Empty(nullifiers.Reservations);
    }

    [Fact]
    public async Task WrapperFixture_TicketReplayWritesOnlyOnePendingComment()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        var nullifiers = new RecordingNullifierService();
        AnonymousCommentTicketService ticketService = CreateTicketService(temp, nativeLibrary, nullifiers: nullifiers);
        byte[] nullifier = ScopeNullifier(ArticleId);
        byte[] proof = ComputeFixtureProof(temp, ArticleId, nullifier);
        AnonymousCommentTicketIssueResult ticket = await ticketService.IssueAsync(
            ValidTicketRequest(temp, ArticleId, nullifier, proof),
            CancellationToken.None);
        Assert.True(ticket.Issued, ticket.Status);

        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, ArticleId);
        CommentCommandService commentService = CreateCommentService(temp, nativeLibrary, db, ticketService, nullifiers);
        AnonymousCommentCreateRequestCoreModel request = CreateSubmitRequest(ticket.Response.Ticket);

        bool firstCreated = await commentService.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);
        Assert.True(firstCreated);
        // Ticket is consumed after the first commit; a second attempt either fails closed or
        // resolves as an idempotent mutation replay without creating another row.
        _ = await commentService.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Single(nullifiers.Increments);
    }

    [Fact]
    public async Task WrapperFixture_CrossScopeNullifierIndependenceIssuesUnlinkableTickets()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        AnonymousCommentTicketService ticketService = CreateTicketService(temp, nativeLibrary);
        byte[] firstNullifier = ScopeNullifier(ArticleId);
        byte[] secondNullifier = ScopeNullifier(OtherArticleId);

        AnonymousCommentTicketIssueResult first = await ticketService.IssueAsync(
            ValidTicketRequest(temp, ArticleId, firstNullifier, ComputeFixtureProof(temp, ArticleId, firstNullifier)),
            CancellationToken.None);
        AnonymousCommentTicketIssueResult second = await ticketService.IssueAsync(
            ValidTicketRequest(temp, OtherArticleId, secondNullifier, ComputeFixtureProof(temp, OtherArticleId, secondNullifier)),
            CancellationToken.None);

        Assert.True(first.Issued);
        Assert.True(second.Issued);
        Assert.NotEqual(Hex(firstNullifier), Hex(secondNullifier));
        Assert.False(first.Response.ModerationSubjectHash.AsSpan().SequenceEqual(second.Response.ModerationSubjectHash));
        Assert.Equal(2, nativeLibrary.CallCount);
    }

    [Fact]
    public void WrapperFixture_FeatureFlagOffIsExpectedUnavailable()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        IZkAnonymousProofService proofService = CreateProofService(temp, nativeLibrary, zkProdEnabled: false);

        ZkCommentPolicySnapshot policy = proofService.CurrentZkCommentPolicy;

        Assert.False(policy.Enabled);
        Assert.Equal("disabled", policy.UnavailableReason);
    }

    private static AnonymousCommentTicketService CreateTicketService(
        TempNativeZkFixture temp,
        HashingNativeGroth16FixtureLibrary nativeLibrary,
        CapturingUnifiedCache? cache = null,
        RecordingNullifierService? nullifiers = null)
    {
        var time = new MutableTimeProvider(DateTimeOffset.UtcNow);
        IConfiguration configuration = BuildConfiguration(temp);
        CapturingUnifiedCache ticketCache = cache ?? new CapturingUnifiedCache(time);
        return new AnonymousCommentTicketService(
            ticketCache,
            ticketCache,
            new FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(CreateRootSnapshot(temp, time))),
            CreateProofService(temp, nativeLibrary),
            nullifiers ?? new RecordingNullifierService(),
            CreatePolicyService(),
            configuration,
            time,
            ticketCache);
    }

    private static IAnonymousCommentPolicyService CreatePolicyService()
        => new FixedCommentPolicyService(new AnonymousCommentPolicySnapshot(
            true,
            true,
            true,
            CommentAuthorModes.ZkAnonymous,
            AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)
        {
            SnapshotHash = s_policyHash
        });

    private static IZkAnonymousProofService CreateProofService(
        TempNativeZkFixture temp,
        HashingNativeGroth16FixtureLibrary nativeLibrary,
        bool zkProdEnabled = true)
    {
        IConfiguration configuration = BuildConfiguration(temp, zkProdEnabled);
        var rootReader = new FixedRootReader(Hex(s_credentialRoot), CredentialEpoch);
        var backend = new NativeGroth16ZkProofBackend(
            new NativeGroth16ZkProofBackendOptions(
                temp.NativeLibraryPath,
                temp.VerifyingKeyPath,
                temp.VerifyingKeySha256,
                "fsus_zk_groth16_verify"),
            nativeLibrary,
            NullLogger<NativeGroth16ZkProofBackend>.Instance);
        var verifier = new ProductionZkProofVerifier(
            configuration,
            rootReader,
            backend,
            NullLogger<ProductionZkProofVerifier>.Instance);
        return new ZkAnonymousProofService(
            configuration,
            verifier,
            new ZkCommentPolicyAuthority(configuration),
            new ZkVerifierReadiness(ZkVerifierOptions.FromConfiguration(configuration), verifier),
            rootReader,
            new ConfiguredBlindCredentialSigner(),
            new EnabledBlindCredentialGate());
    }

    private static CommentCommandService CreateCommentService(
        TempNativeZkFixture temp,
        HashingNativeGroth16FixtureLibrary nativeLibrary,
        SqlSugarClient db,
        IAnonymousCommentTicketService ticketService,
        RecordingNullifierService nullifierService,
        RecordingCacheInvalidationDispatcher? dispatcher = null)
    {
        dispatcher ??= new RecordingCacheInvalidationDispatcher();
        var notifications = new CommentNotificationService(
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            dispatcher,
            notifications,
            NullLogger<CommentModerationService>.Instance,
            anonymousPolicy: CreatePolicyService());
        IAnonymousCommentPolicyService policy = CreatePolicyService();
        IConfiguration configuration = BuildConfiguration(temp);
        var attribution = new CommentAttributionPrivacyService(
            NullLogger<CommentAttributionPrivacyService>.Instance,
            policy: policy,
            nullifiers: nullifierService,
            tickets: ticketService,
            displayNames: new CommentAnonymousDisplayNameGenerator(),
            configuration: configuration,
            zkProofs: CreateProofService(temp, nativeLibrary));
        return new CommentCommandService(
            db,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution,
            dispatcher);
    }

    private static AnonymousCommentTicketRequestCoreModel ValidTicketRequest(
        TempNativeZkFixture temp,
        int articleId,
        byte[] nullifier,
        byte[] proof)
        => new(
            ArticleId: articleId,
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            CircuitNumericId: CircuitNumericId,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
            Scope: AnonymousCommentScopePolicy.CreateTopLevelScope(articleId),
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: temp.VerifyingKeySha256,
            NullifierHash: nullifier,
            CredentialRoot: s_credentialRoot,
            RevocationRoot: s_revocationRoot,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Groth16Proof: proof,
            PublicInputs: PublicInputs(articleId, nullifier, temp.VerifyingKeySha256));

    private static AnonymousCommentCreateRequestCoreModel CreateSubmitRequest(byte[] ticket)
        => new(
            ArticleId,
            "anonymous ZK production smoke comment",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            "comment:v1:article:42:top",
            "en",
            [.. ticket]);

    private static byte[] PublicInputs(int articleId, byte[] nullifier, string verifyingKeyHash)
        => NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            ActionContext: "comment.create",
            Scope: AnonymousCommentScopePolicy.CreateTopLevelScope(articleId),
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            NullifierHash: Hex(nullifier),
            CredentialRoot: Hex(s_credentialRoot),
            PolicyHash: s_policyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Hex(s_revocationRoot),
            IssuerPublicKeyHash: s_issuerPublicKeyHash)).ToArray();

    private static byte[] ComputeFixtureProof(TempNativeZkFixture temp, int articleId, byte[] nullifier)
    {
        var request = new ProductionZkProofBackendRequest(
            ActionContext: "comment.create",
            Scope: AnonymousCommentScopePolicy.CreateTopLevelScope(articleId),
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: temp.VerifyingKeySha256,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            NullifierHash: Hex(nullifier),
            CredentialRoot: Hex(s_credentialRoot),
            PolicyHash: s_policyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Hex(s_revocationRoot),
            IssuerPublicKeyHash: s_issuerPublicKeyHash);
        return ComputeFixtureProof(temp.VerifyingKeyBytes, request);
    }

    private static byte[] ComputeFixtureProof(
        ReadOnlySpan<byte> verifyingKey,
        ProductionZkProofBackendRequest request)
    {
        ReadOnlyMemory<byte> publicInputs = NativeGroth16PublicInputCodec.Encode(request);
        byte[] payload = new byte[verifyingKey.Length + publicInputs.Length];
        verifyingKey.CopyTo(payload);
        publicInputs.Span.CopyTo(payload.AsSpan(verifyingKey.Length));
        return SHA256.HashData(payload);
    }

    private static AnonymousCredentialRootSnapshotCoreModel CreateRootSnapshot(TempNativeZkFixture temp, TimeProvider time)
        => new(
            CredentialEpoch: CredentialEpoch,
            RootExpiresAtUnixMs: time.GetUtcNow().AddMinutes(10).ToUnixTimeMilliseconds(),
            RootGraceExpiresAtUnixMs: time.GetUtcNow().AddMinutes(20).ToUnixTimeMilliseconds(),
            CircuitNumericId: CircuitNumericId,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ZkAnonymousEnabled: true,
            VerifierConfigured: true,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: temp.VerifyingKeySha256,
            IssuerPublicKeyHash: s_issuerPublicKeyHash,
            CredentialRoot: s_credentialRoot,
            RevocationRoot: s_revocationRoot,
            CircuitMetadata: Encoding.UTF8.GetBytes("{\"anonymity_sets\":[{\"is_eligible\":true,\"may_comment\":true,\"rate_class\":\"common\",\"requires_moderation\":false,\"size\":20}]}"));

    private static IConfiguration BuildConfiguration(TempNativeZkFixture temp, bool zkProdEnabled = true)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum",
                ["AnonymousIdentity:AnonymousCommentTicketTtlSeconds"] = "120",
                ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
                ["AnonymousIdentity:ZkVerifier:CircuitId"] = AnonymousPrivacyContract.CircuitId,
                ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = temp.VerifyingKeySha256,
                ["AnonymousIdentity:ZkVerifier:TrustedSetupManifestPath"] = temp.ManifestPath,
                ["AnonymousIdentity:ZkVerifier:VerifyingKeyManifestPath"] = temp.ManifestPath,
                ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = AnonymousPrivacyContract.PublicInputLayoutVersion.ToString(),
                ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4096",
                ["AnonymousIdentity:ZkVerifier:Backend"] = ZkVerifierOptions.NativeGroth16Backend,
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "1000",
                ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = "2",
                ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = zkProdEnabled.ToString(),
                ["AnonymousIdentity:ZkCommentPolicy:RequireTrustedSetupVerified"] = "true",
                ["AnonymousIdentity:ZkCommentPolicy:RequireCredential"] = "true",
                ["Moderation:Pepper"] = "unit-test-moderation-pepper-with-at-least-thirty-two-chars"
            })
            .Build();

    private static RegionModerationDecision RegionDecision()
        => new(
            true,
            RegionCodes.Singapore,
            0.95d,
            "unit",
            "ip-hash",
            [],
            [],
            [],
            RegionLegalModerationService.CurrentPolicyVersion,
            "allowed",
            "allowed",
            RequiresManualReview: true,
            HideUntilReviewed: true);

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticlePublicationRecord),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentAnonymousNullifier),
            typeof(CommentRegionCompliance),
            typeof(CommentBlockedRegion));
    }

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, 'unit article', 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static byte[] ScopeNullifier(int articleId)
        => SHA256.HashData(Encoding.UTF8.GetBytes($"fixture-credential-secret:comment.create:article:{articleId}"));

    private static string Hex(byte[] value)
        => Convert.ToHexString(value).ToLowerInvariant();

    private sealed class FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel> result) : IAnonymousCredentialRootService
    {
        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(result);

        public void Invalidate()
        {
        }
    }

    private sealed class FixedRootReader(string acceptedRoot, long acceptedEpoch) : IAnonymousCredentialRootReader
    {
        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot
        {
            get;
        } = new(
            [new AnonymousCredentialAcceptedRoot(acceptedEpoch, acceptedRoot, Hex(s_revocationRoot), s_issuerPublicKeyHash, AnonymousCredentialRootStatuses.Active, DateTimeOffset.UtcNow.AddHours(1))],
            1,
            DateTimeOffset.UtcNow);

        public Task RefreshAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch)
            => epoch == acceptedEpoch && string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal);

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => IsRootAccepted(rootHash, epoch) &&
                string.Equals(revocationRootHash, Hex(s_revocationRoot), StringComparison.Ordinal) &&
                string.Equals(issuerPublicKeyHash, s_issuerPublicKeyHash, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class RecordingNullifierService : ICommentAnonymousNullifierService
    {
        public List<(string NullifierHash, string Scope)> Reservations { get; } = [];

        public List<(string NullifierHash, string Scope, long CommentId)> Increments { get; } = [];

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Reservations.Add((nullifierHash, scope));
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 0));
        }

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
        {
            Increments.Add((nullifierHash, scope, commentId));
            return Task.FromResult(true);
        }

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class ConfiguredBlindCredentialSigner : IRfc9474BlindCredentialSigner
    {
        public bool IsConfigured => true;
        public string KeyId => "unit-test-blind-issuer";
        public string PublicKeyHash => AnonymousZkProdWrapperFixtureTests.s_issuerPublicKeyHash;
        public byte[] SubjectPublicKeyInfo => [1];
        public int ModulusBytes => Rfc9474BlindCredentialProfile.ModulusBytes;

        public ValueTask<Result<byte[]>> BlindSignAsync(
            ReadOnlyMemory<byte> blindedMessage,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class EnabledBlindCredentialGate : IBlindCredentialRuntimeGate
    {
        public bool IsEnabled => true;
        public TimeSpan GetEnvelopeDelay(TimeSpan elapsed) => TimeSpan.Zero;
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
        {
            if (!_store.TryGetValue((policyId, identity), out var entry) ||
                (entry.ExpiresAt.HasValue && entry.ExpiresAt.Value <= time.GetUtcNow()))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var decoded = decoder(entry.Value);
            return Task.FromResult(decoded.Success
                ? new CacheReadResult<T>(true, decoded.Value)
                : new CacheReadResult<T>(false, default));
        }

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            if (!_store.TryGetValue((policyId, identity), out var entry) ||
                (entry.ExpiresAt.HasValue && entry.ExpiresAt.Value <= time.GetUtcNow()))
            {
                return Task.FromResult(new CacheReadResult<byte[]>(false, default));
            }

            return Task.FromResult(new CacheReadResult<byte[]>(true, entry.Value.ToArray()));
        }

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            if (!_store.TryGetValue((policyId, identity), out var entry) ||
                (entry.ExpiresAt.HasValue && entry.ExpiresAt.Value <= time.GetUtcNow()))
            {
                return Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));
            }

            return Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(true, entry.Value));
        }

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

    private sealed class RecordingCacheInvalidationDispatcher : ICacheInvalidationDispatcher
    {
        public List<CommentCacheInvalidationScope?> CommentScopes { get; } = [];

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
        {
            CommentScopes.Add(scope);
            return Task.CompletedTask;
        }

        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
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

    // Wrapper-only fixture: release gates reject this hashing proof as production evidence.
    private sealed class HashingNativeGroth16FixtureLibrary : INativeGroth16VerifierLibrary
    {
        public bool IsLoaded => true;

        public int CallCount
        {
            get; private set;
        }

        public NativeGroth16VerifierCallResult Verify(
            ReadOnlySpan<byte> verifyingKey,
            ReadOnlySpan<byte> publicInputs,
            ReadOnlySpan<byte> proof)
        {
            CallCount++;
            byte[] payload = new byte[verifyingKey.Length + publicInputs.Length];
            verifyingKey.CopyTo(payload);
            publicInputs.CopyTo(payload.AsSpan(verifyingKey.Length));
            byte[] expectedProof = SHA256.HashData(payload);
            return proof.SequenceEqual(expectedProof)
                ? NativeGroth16VerifierCallResult.Accepted()
                : NativeGroth16VerifierCallResult.Rejected("invalid_proof");
        }

        public void Dispose()
        {
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;
    }

    private sealed class NoopAsyncDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class TempNativeZkFixture : IDisposable
    {
        private TempNativeZkFixture(string directoryPath, byte[] verifyingKeyBytes)
        {
            DirectoryPath = directoryPath;
            VerifyingKeyBytes = verifyingKeyBytes;
            VerifyingKeyPath = Path.Combine(directoryPath, "comment.v5.vk");
            NativeLibraryPath = Path.Combine(directoryPath, "libfsus_zk_groth16.so");
            VerifyingKeySha256 = Hex(SHA256.HashData(verifyingKeyBytes));
            Directory.CreateDirectory(directoryPath);
            File.WriteAllBytes(VerifyingKeyPath, verifyingKeyBytes);
            ManifestPath = Path.Combine(directoryPath, "fixture-manifest.json");
            File.WriteAllText(ManifestPath, System.Text.Json.JsonSerializer.Serialize(new
            {
                production_usable = true,
                verifying_key_hash = VerifyingKeySha256
            }));
        }

        public string ManifestPath { get; }

        public string DirectoryPath
        {
            get;
        }

        public string VerifyingKeyPath
        {
            get;
        }

        public string NativeLibraryPath
        {
            get;
        }

        public byte[] VerifyingKeyBytes
        {
            get;
        }

        public string VerifyingKeySha256
        {
            get;
        }

        public static TempNativeZkFixture Create()
            => new(
                Path.Combine(Path.GetTempPath(), "fsus-zk-prod-smoke-native-" + Guid.NewGuid().ToString("N")),
                "fixture-verifying-key"u8.ToArray());

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(DirectoryPath))
                {
                    Directory.Delete(DirectoryPath, recursive: true);
                }
            }
            catch
            {
                // Test cleanup best effort only.
            }
        }
    }
}
