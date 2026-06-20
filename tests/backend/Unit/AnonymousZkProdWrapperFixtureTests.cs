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
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousZkProdWrapperFixtureTests
{
    private const int ArticleId = 42;
    private const int OtherArticleId = 43;
    private const long CredentialEpoch = 20260619;
    private const uint CircuitNumericId = 7;
    private static readonly byte[] CredentialRoot = Enumerable.Repeat((byte)0xC3, 32).ToArray();
    private static readonly byte[] RevocationRoot = Enumerable.Repeat((byte)0xD4, 32).ToArray();
    private static readonly byte[] CredentialCommitment = SHA256.HashData("fixture-circuit-native-credential-commitment"u8.ToArray());
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private static readonly string PolicyHash = AnonymousCommentPolicySnapshotHash.Compute(AnonymousCommentPolicySnapshot.Default with
    {
        ZkAnonymousEnabled = true
    });

    [Fact]
    public async Task WrapperFixture_HappyPath_NativeVerifierTicketSubmitCreatesPendingAnonymousComment()
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

        Assert.True(ticket.Issued);
        Assert.Equal(1, nativeLibrary.CallCount);
        Assert.Equal("strong_anonymous", ticket.Response.CredentialLevel);

        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, ArticleId);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentService commentService = CreateCommentService(db, ticketService, nullifiers, dispatcher);

        bool created = await commentService.CreateAnonymousCommentAsync(
            CreateSubmitRequest(ticket.Response.Ticket),
            RegionDecision(),
            CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Null(comment.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
        Assert.Equal(Hex(nullifier), comment.AnonymousNullifierHash);
        Assert.Equal("article:42", comment.AnonymousScope);
        Assert.Equal("strong_anonymous", comment.CredentialLevel);
        Assert.Equal("rep-low", comment.ReputationBucket);
        Assert.Equal(CommentModerationStatus.Pending, comment.ModerationStatus);

        CommentRegionCompliance compliance = Assert.Single(db.Queryable<CommentRegionCompliance>().ToList());
        Assert.Equal(comment.Id, compliance.CommentId);
        Assert.Equal(RegionCodes.Singapore, compliance.SubmitRegion);
        Assert.True(compliance.RequiresManualReview);

        var increment = Assert.Single(nullifiers.Increments);
        Assert.Equal(Hex(nullifier), increment.NullifierHash);
        Assert.Equal("article:42", increment.Scope);
        Assert.Equal(comment.Id, increment.CommentId);

        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Equal(ArticleId, scope.ArticleId);
        Assert.Null(scope.UserId);
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
        Assert.True(ticket.Issued);

        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, ArticleId);
        CommentService commentService = CreateCommentService(db, ticketService, nullifiers);
        AnonymousCommentCreateRequestCoreModel request = CreateSubmitRequest(ticket.Response.Ticket);

        Assert.True(await commentService.CreateAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None));
        Assert.False(await commentService.CreateAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None));

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
        Assert.NotEqual(first.Response.ModerationSubjectHash, second.Response.ModerationSubjectHash);
        Assert.Equal(2, nativeLibrary.CallCount);
    }

    [Fact]
    public void WrapperFixture_FeatureFlagOffIsExpectedUnavailable()
    {
        using TempNativeZkFixture temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        IZkAnonymousProofService proofService = CreateProofService(temp, nativeLibrary, zkProdEnabled: false);

        ZkProdPolicySnapshot policy = proofService.CurrentZkProdPolicy;

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
        IConfiguration configuration = BuildConfiguration(temp.VerifyingKeySha256);
        return new AnonymousCommentTicketService(
            cache ?? new CapturingUnifiedCache(time),
            new FixedRootService(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(CreateRootSnapshot(temp, time))),
            CreateProofService(temp, nativeLibrary),
            nullifiers ?? new RecordingNullifierService(),
            configuration,
            time);
    }

    private static IZkAnonymousProofService CreateProofService(
        TempNativeZkFixture temp,
        HashingNativeGroth16FixtureLibrary nativeLibrary,
        bool zkProdEnabled = true)
    {
        IConfiguration configuration = BuildConfiguration(temp.VerifyingKeySha256, zkProdEnabled);
        var rootReader = new FixedRootReader(Hex(CredentialRoot), CredentialEpoch);
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
            new StaticOptionsMonitor<ZkProdOptions>(ZkProdOptions.FromConfiguration(configuration)),
            rootReader);
    }

    private static CommentService CreateCommentService(
        SqlSugarClient db,
        IAnonymousCommentTicketService ticketService,
        RecordingNullifierService nullifierService,
        RecordingCacheInvalidationDispatcher? dispatcher = null)
        => new(
            db,
            NullLogger<CommentService>.Instance,
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            dispatcher ?? new RecordingCacheInvalidationDispatcher(),
            new RegionLegalModerationService(),
            anonymousNullifierService: nullifierService,
            anonymousCommentTicketService: ticketService,
            anonymousDisplayNameGenerator: new CommentAnonymousDisplayNameGenerator());

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
            CredentialEpoch: CredentialEpoch,
            CircuitNumericId: CircuitNumericId,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            ActionContext: AnonymousPrivacyContract.CommentCreateActionContext,
            Scope: $"article:{articleId}",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: temp.VerifyingKeySha256,
            NullifierHash: nullifier,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            RevocationRoot: RevocationRoot,
            CredentialLevel: "strong_anonymous",
            ReputationBucket: "rep-low",
            Groth16Proof: proof,
            PublicInputs: PublicInputs(articleId, nullifier, temp.VerifyingKeySha256));

    private static AnonymousCommentCreateRequestCoreModel CreateSubmitRequest(byte[] ticket)
        => new(
            ArticleId,
            "anonymous ZK production smoke comment",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            CredentialEpoch,
            "article:42",
            "en",
            [.. ticket]);

    private static byte[] PublicInputs(int articleId, byte[] nullifier, string verifyingKeyHash)
        => NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            ActionContext: "comment.create",
            Scope: $"article:{articleId}",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            CredentialEpoch: CredentialEpoch,
            NullifierHash: Hex(nullifier),
            CredentialCommitment: Hex(CredentialCommitment),
            CredentialRoot: Hex(CredentialRoot),
            CredentialLevel: "strong_anonymous",
            ReputationBucket: "rep-low",
            PolicyHash: PolicyHash,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Hex(RevocationRoot),
            IssuerPublicKeyHash: IssuerPublicKeyHash)).ToArray();

    private static byte[] ComputeFixtureProof(TempNativeZkFixture temp, int articleId, byte[] nullifier)
    {
        var request = new ProductionZkProofBackendRequest(
            ActionContext: "comment.create",
            Scope: $"article:{articleId}",
            CircuitId: AnonymousPrivacyContract.CircuitId,
            VerifyingKeyHash: temp.VerifyingKeySha256,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            CredentialEpoch: CredentialEpoch,
            NullifierHash: Hex(nullifier),
            CredentialCommitment: Hex(CredentialCommitment),
            CredentialRoot: Hex(CredentialRoot),
            CredentialLevel: "strong_anonymous",
            ReputationBucket: "rep-low",
            PolicyHash: PolicyHash,
            Proof: ReadOnlyMemory<byte>.Empty,
            RevocationRoot: Hex(RevocationRoot),
            IssuerPublicKeyHash: IssuerPublicKeyHash);
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
            IssuerPublicKeyHash: IssuerPublicKeyHash,
            CredentialRoot: CredentialRoot,
            RevocationRoot: RevocationRoot,
            CircuitMetadata: []);

    private static IConfiguration BuildConfiguration(string verifyingKeyHash, bool zkProdEnabled = true)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:AnonymousCommentTicketTtlSeconds"] = "120",
                ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
                ["AnonymousIdentity:ZkVerifier:CircuitId"] = AnonymousPrivacyContract.CircuitId,
                ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = verifyingKeyHash,
                ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = AnonymousPrivacyContract.PublicInputLayoutVersion.ToString(),
                ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4096",
                ["AnonymousIdentity:ZkVerifier:Backend"] = ZkProdOptions.NativeGroth16Backend,
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "1000",
                ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = "2",
                ["AnonymousIdentity:ZkProd:Enabled"] = zkProdEnabled.ToString(),
                ["AnonymousIdentity:ZkProd:VerifierBackend"] = ZkProdOptions.NativeGroth16Backend,
                ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = verifyingKeyHash,
                ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "true",
                ["AnonymousIdentity:ZkProd:CredentialReady"] = "true"
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

    private static SqlSugarClient CreateDb()
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(Path.GetTempPath(), $"fsus-zk-prod-smoke-{Guid.NewGuid():N}.db")}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateTables(SqlSugarClient db)
    {
        db.Ado.ExecuteCommand("""
            CREATE TABLE article (
                id INTEGER PRIMARY KEY,
                IsDeleted INTEGER NOT NULL,
                status INTEGER NOT NULL,
                published_at TEXT NULL,
                scheduled_publish_at TEXT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE comment (
                id INTEGER PRIMARY KEY,
                article_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                create_time TEXT NOT NULL,
                user_id INTEGER NULL,
                author_mode TEXT NOT NULL,
                public_handle TEXT NULL,
                anonymous_handle TEXT NULL,
                anonymous_display_name TEXT NULL,
                anonymous_display_language TEXT NULL,
                anonymous_nullifier_hash TEXT NULL,
                anonymous_scope TEXT NULL,
                moderation_subject_hash TEXT NULL,
                credential_level TEXT NULL,
                reputation_bucket TEXT NULL,
                account_age_bucket TEXT NULL,
                parent_id INTEGER NULL,
                root_id INTEGER NULL,
                reply_to_user_id INTEGER NULL,
                reply_to_comment_id INTEGER NULL,
                depth INTEGER NOT NULL,
                is_deleted INTEGER NOT NULL,
                delete_reason TEXT NULL,
                delete_time TEXT NULL,
                moderation_status INTEGER NOT NULL,
                moderation_reason TEXT NULL,
                moderated_by_user_id INTEGER NULL,
                moderated_at TEXT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE comment_region_compliance (
                id INTEGER PRIMARY KEY,
                comment_id INTEGER NOT NULL,
                submit_region TEXT NOT NULL,
                submit_region_confidence REAL NOT NULL,
                region_provider TEXT NOT NULL,
                submit_ip_hash TEXT NULL,
                policy_version TEXT NOT NULL,
                can_publish INTEGER NOT NULL,
                requires_manual_review INTEGER NOT NULL,
                hide_until_reviewed INTEGER NOT NULL,
                blocked_regions TEXT NOT NULL,
                risk_labels TEXT NOT NULL,
                decision_reason TEXT NULL,
                rule_hits_json TEXT NULL,
                created_at_utc TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            );
            """);
    }

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article (id, IsDeleted, status, published_at, scheduled_publish_at)
            VALUES (@Id, 0, @Status, @PublishedAt, NULL);
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
        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot { get; } = new(
            [new AnonymousCredentialAcceptedRoot(acceptedEpoch, acceptedRoot, Hex(RevocationRoot), IssuerPublicKeyHash, AnonymousCredentialRootStatuses.Active, DateTimeOffset.UtcNow.AddHours(1))],
            1,
            DateTimeOffset.UtcNow);

        public Task RefreshAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch)
            => epoch == acceptedEpoch && string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal);

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => IsRootAccepted(rootHash, epoch) &&
                string.Equals(revocationRootHash, Hex(RevocationRoot), StringComparison.Ordinal) &&
                string.Equals(issuerPublicKeyHash, IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase);
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

    // Wrapper-only fixture: release gates reject this hashing proof as production evidence.
    private sealed class HashingNativeGroth16FixtureLibrary : INativeGroth16VerifierLibrary
    {
        public bool IsLoaded => true;

        public int CallCount { get; private set; }

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

    private sealed class StaticOptionsMonitor<TOptions>(TOptions value) : IOptionsMonitor<TOptions>
    {
        public TOptions CurrentValue { get; } = value;

        public TOptions Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<TOptions, string?> listener) => null;
    }

    private sealed class TempNativeZkFixture : IDisposable
    {
        private TempNativeZkFixture(string directoryPath, byte[] verifyingKeyBytes)
        {
            DirectoryPath = directoryPath;
            VerifyingKeyBytes = verifyingKeyBytes;
            VerifyingKeyPath = Path.Combine(directoryPath, "comment.v2.vk");
            NativeLibraryPath = Path.Combine(directoryPath, "libfsus_zk_groth16.so");
            VerifyingKeySha256 = Hex(SHA256.HashData(verifyingKeyBytes));
            Directory.CreateDirectory(directoryPath);
            File.WriteAllBytes(VerifyingKeyPath, verifyingKeyBytes);
        }

        public string DirectoryPath { get; }

        public string VerifyingKeyPath { get; }

        public string NativeLibraryPath { get; }

        public byte[] VerifyingKeyBytes { get; }

        public string VerifyingKeySha256 { get; }

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
