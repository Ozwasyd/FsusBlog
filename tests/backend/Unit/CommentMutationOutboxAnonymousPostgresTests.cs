using System.Collections.Concurrent;
using System.Security.Cryptography;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Governance;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentMutationOutboxAnonymousPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";
    private readonly PostgresSchemaMigrationFixture _fixture = fixture;

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task StrongAnonymousSubmissions_CommitBeforeBlockedOutboxInvalidationAndDeliverExactlyOnce()
    {
        const int Attempts = 24;
        string connectionString = await CreateAnonymousCommentDatabaseAsync();
        var invalidations = new BlockingCacheInvalidationDispatcher(connectionString);
        using var barrier = new Barrier(Attempts);

        Task[] submissions = Enumerable.Range(0, Attempts)
            .Select(index => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = CreateAnonymousClient(connectionString);
                string nullifierHash = CreateNullifierHash(index);
                CommentCommandService service = CreateAnonymousCommentService(
                    db,
                    new FixedTicketService(CreateTicketPayload(nullifierHash)),
                    new CommentAnonymousNullifierService(db, BuildAnonymousConfiguration()),
                    invalidations,
                    new CommentMutationOutboxWriter(db));
                bool created = await service.CreateStrongAnonymousCommentAsync(
                    CreateAnonymousCommentRequest(CreateTicket(index), $"anonymous outbox {index}"),
                    RegionDecision(),
                    CancellationToken.None);
                Assert.True(created);
            }))
            .ToArray();

        await Task.WhenAll(submissions).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(Attempts, submissions.Count(static task => task.IsCompletedSuccessfully));
        Assert.Equal(0, invalidations.CallCount);

        using ServiceProvider provider = BuildAnonymousWorkerServices(connectionString, invalidations);
        var worker = CreateWorker(provider);
        Task<int> firstBatch = worker.ProcessPendingAsync(CancellationToken.None);
        await invalidations.Entered.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.False(firstBatch.IsCompleted);
        Assert.Equal(Attempts, submissions.Count(static task => task.IsCompletedSuccessfully));
        Assert.Equal(1, invalidations.CallCount);
        CacheDispatchObservation blockedDispatch = Assert.Single(invalidations.Observations);
        AssertBlockedAnonymousWorkerState(connectionString, Attempts, blockedDispatch);
        AssertAnonymousCommitState(connectionString, Attempts, expectedProcessedEvents: 0);

        invalidations.Release();
        int processed = await firstBatch.WaitAsync(TimeSpan.FromSeconds(30));
        int nextBatch;
        do
        {
            nextBatch = await worker.ProcessPendingAsync(CancellationToken.None);
            processed += nextBatch;
        }
        while (nextBatch > 0);

        Assert.Equal(Attempts * 2, processed);
        Assert.Equal(Attempts * 2, invalidations.CallCount);
        Assert.Equal(Attempts * 2, invalidations.Scopes.Count);
        AssertAnonymousDeliveryState(connectionString, Attempts);
        AssertAnonymousCacheProjectionState(connectionString, invalidations, Attempts);

        int callsBeforeDuplicate = invalidations.CallCount;
        Assert.Equal(0, await worker.ProcessPendingAsync(CancellationToken.None));
        Assert.Equal(callsBeforeDuplicate, invalidations.CallCount);
        AssertAnonymousDeliveryState(connectionString, Attempts);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "transactional-rollback-boundary")]
    public async Task StrongAnonymousSubmission_OutboxCommitFailureRollsBackAllAuthoritativeRows()
    {
        string connectionString = await CreateAnonymousCommentDatabaseAsync();
        using SqlSugarClient db = CreateAnonymousClient(connectionString);
        db.Ado.ExecuteCommand(
            "ALTER TABLE comment_mutation_outbox ADD CONSTRAINT reject_issue_2362_outbox CHECK (false);");
        var invalidations = new BlockingCacheInvalidationDispatcher(connectionString);
        CommentCommandService service = CreateAnonymousCommentService(
            db,
            new FixedTicketService(CreateTicketPayload(CreateNullifierHash(100))),
            new CommentAnonymousNullifierService(db, BuildAnonymousConfiguration()),
            invalidations,
            new CommentMutationOutboxWriter(db));

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateAnonymousCommentRequest(CreateTicket(100), "outbox rollback"),
            RegionDecision(),
            CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, invalidations.CallCount);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Equal(0, db.Queryable<CommentRevision>().Count());
        Assert.Equal(0, db.Queryable<CommentRegionCompliance>().Count());
        Assert.Equal(0, db.Queryable<CommentAnonymousNullifier>().Count());
        Assert.Equal(0, db.Queryable<CommentModerationEvent>().Count());
        Assert.Equal(0, db.Queryable<CommentMutationOutboxEvent>().Count());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-strong-anonymous-submission-worker-retry-and-restart-preserve-committed-comment-and-checkpoints")]
    public async Task StrongAnonymousSubmission_WorkerRetryAndRestartPreserveCommittedCommentAndCheckpoints()
    {
        string connectionString = await CreateAnonymousCommentDatabaseAsync();
        var invalidations = new FailOnceCacheInvalidationDispatcher(connectionString);
        using (SqlSugarClient db = CreateAnonymousClient(connectionString))
        {
            CommentCommandService service = CreateAnonymousCommentService(
                db,
                new FixedTicketService(CreateTicketPayload(CreateNullifierHash(200))),
                new CommentAnonymousNullifierService(db, BuildAnonymousConfiguration()),
                invalidations,
                new CommentMutationOutboxWriter(db));
            Assert.True(await service.CreateStrongAnonymousCommentAsync(
                CreateAnonymousCommentRequest(CreateTicket(200), "restart recovery"),
                RegionDecision(),
                CancellationToken.None));
        }
        Assert.Equal(0, invalidations.CallCount);

        using ServiceProvider firstProcess = BuildAnonymousWorkerServices(connectionString, invalidations);
        int initiallyProcessed = await CreateWorker(firstProcess).ProcessPendingAsync(CancellationToken.None);
        Assert.Equal(1, initiallyProcessed);
        AnonymousRetrySnapshot retry = AssertAnonymousRetryableFailureState(connectionString, invalidations);
        using (SqlSugarClient failedState = CreateAnonymousClient(connectionString))
        {
            Assert.Equal(1, failedState.Queryable<Comment>().Count());
            Assert.Equal(1, failedState.Queryable<CommentRegionCompliance>().Count());
            Assert.Equal(1, failedState.Queryable<CommentAnonymousNullifier>().Count());
            Assert.Single(failedState.Queryable<CommentMutationOutboxEvent>()
                .Where(item => item.Status == CommentMutationOutboxStatus.Failed)
                .ToList());
            CommentMutationOutboxEvent failed = failedState.Queryable<CommentMutationOutboxEvent>()
                .Single(item => item.Status == CommentMutationOutboxStatus.Failed);
            failedState.Ado.ExecuteCommand(
                "UPDATE comment_mutation_outbox SET next_attempt_at = @Now WHERE id = @Id;",
                new SugarParameter("@Now", DateTime.UtcNow.AddMinutes(-1)),
                new SugarParameter("@Id", failed.Id));
        }

        using ServiceProvider restartedProcess = BuildAnonymousWorkerServices(connectionString, invalidations);
        CommentMutationOutboxWorker restartedWorker = CreateWorker(restartedProcess);
        Assert.Equal(1, await restartedWorker.ProcessPendingAsync(CancellationToken.None));
        Assert.Equal(0, await restartedWorker.ProcessPendingAsync(CancellationToken.None));
        Assert.Equal(3, invalidations.CallCount);
        AssertAnonymousDeliveryState(connectionString, expectedComments: 1);
        AssertAnonymousRecoveredRetryState(connectionString, invalidations, retry);
    }
    private static ServiceProvider BuildAnonymousWorkerServices(string connectionString, ICacheInvalidationDispatcher invalidations)
    {
        var services = new ServiceCollection();
        services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        services.AddSingleton(invalidations);
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        services.AddSingleton(notifications);
        services.AddScoped<ICommentModerationService>(provider => new CommentModerationService(
            provider.GetRequiredService<ISqlSugarClient>(),
            new RegionLegalModerationService(),
            invalidations,
            notifications,
            NullLogger<CommentModerationService>.Instance));
        return services.BuildServiceProvider();
    }

    private static CommentMutationOutboxWorker CreateWorker(ServiceProvider provider)
        => new(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<IBackgroundWorkerLease>(),
            new CommentMutationOutboxRuntimeState(),
            TimeProvider.System,
            new ConfigurationBuilder().Build(),
            NullLogger<CommentMutationOutboxWorker>.Instance);

    private static SqlSugarClient CreateAnonymousClient(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);

    private async Task<string> CreateAnonymousCommentDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(_fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticlePublicationRecord),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance),
            typeof(CommentModerationEvent),
            typeof(CommentAnonymousNullifier),
            typeof(CommentMutationOutboxEvent),
            typeof(CommentMutationOutboxDelivery));
        db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fsus_append_comment_moderation_event()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE event_name varchar(24);
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    event_name := 'create';
                ELSIF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
                    event_name := CASE WHEN NEW.is_deleted THEN 'delete' ELSE 'restore' END;
                ELSIF NEW.moderation_status IS DISTINCT FROM OLD.moderation_status THEN
                    event_name := CASE NEW.moderation_status WHEN 0 THEN 'pending' WHEN 1 THEN 'approve' WHEN 2 THEN 'reject' ELSE 'hide' END;
                ELSE
                    RETURN NEW;
                END IF;
                INSERT INTO comment_moderation_event(
                    comment_id, event_type, previous_status, next_status, actor_type, reason_code,
                    policy_version, model_version, transition_source, admin_principal_id, occurred_at_utc)
                VALUES (
                    NEW.id, event_name,
                    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.moderation_status END,
                    NEW.moderation_status,
                    CASE WHEN NEW.moderated_by_admin_principal_id IS NOT NULL THEN 'admin'
                         WHEN COALESCE(NEW.moderation_reason, '') LIKE 'model_policy:%' THEN 'model' ELSE 'system' END,
                    COALESCE(NEW.moderation_reason, NEW.delete_reason),
                    current_setting('fsus.moderation_policy_version', true),
                    current_setting('fsus.moderation_model_version', true),
                    CASE WHEN TG_OP = 'INSERT' THEN 'initial'
                         WHEN NEW.moderated_by_admin_principal_id IS NOT NULL THEN 'admin'
                         WHEN COALESCE(NEW.moderation_reason, '') LIKE 'model_policy:%' THEN 'model' ELSE 'system' END,
                    NEW.moderated_by_admin_principal_id,
                    COALESCE(NEW.moderated_at, NEW.delete_time, NEW.create_time, now() AT TIME ZONE 'utc'));
                RETURN NEW;
            END; $$;

            DROP TRIGGER IF EXISTS trg_comment_moderation_event ON comment;
            CREATE TRIGGER trg_comment_moderation_event
            AFTER INSERT OR UPDATE OF moderation_status, is_deleted ON comment
            FOR EACH ROW EXECUTE FUNCTION fsus_append_comment_moderation_event();
            """);
        db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (42, 'anonymous outbox article', 1, 0, @PublishedAt, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));
        return connectionString;
    }

    private static CommentCommandService CreateAnonymousCommentService(
        SqlSugarClient db,
        IAnonymousCommentTicketService tickets,
        ICommentAnonymousNullifierService nullifiers,
        ICacheInvalidationDispatcher invalidations,
        ICommentMutationOutbox outbox)
    {
        IConfiguration configuration = BuildAnonymousConfiguration();
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default with
        {
            AnonymousCommentsEnabled = true,
            ZkAnonymousEnabled = true
        };
        var policyService = Substitute.For<IAnonymousCommentPolicyService>();
        policyService.GetCurrentAsync(Arg.Any<CancellationToken>()).Returns(policy);
        var proofService = Substitute.For<IZkAnonymousProofService>();
        proofService.CurrentZkCommentPolicy.Returns(new ZkCommentPolicySnapshot(
            Enabled: true,
            NativeVerifierConfigured: true,
            TrustedSetupVerified: true,
            CredentialRequired: true,
            CredentialRootReady: true,
            UnavailableReason: string.Empty));
        ICommentNotificationService notifications = Substitute.For<ICommentNotificationService>();
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            invalidations,
            notifications,
            NullLogger<CommentModerationService>.Instance,
            anonymousPolicy: policyService,
            mutationOutbox: outbox);
        var attribution = new CommentAttributionPrivacyService(
            NullLogger<CommentAttributionPrivacyService>.Instance,
            policy: policyService,
            nullifiers: nullifiers,
            tickets: tickets,
            displayNames: new CommentAnonymousDisplayNameGenerator(),
            configuration: configuration,
            zkProofs: proofService);
        return new CommentCommandService(
            db,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution,
            invalidations,
            configuration,
            outbox);
    }

    private static IConfiguration BuildAnonymousConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:Pepper"] = ModerationPepper,
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum"
            })
            .Build();

    private static AnonymousCommentCreateRequestCoreModel CreateAnonymousCommentRequest(byte[] ticket, string content)
        => new(
            42,
            content,
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            AnonymousScope: AnonymousCommentScopePolicy.CreateTopLevelScope(42),
            DisplayLanguage: "en",
            Ticket: ticket);

    private static AnonymousCommentTicketPayload CreateTicketPayload(string nullifierHash)
        => new(
            ArticleId: 42,
            Scope: AnonymousCommentScopePolicy.CreateTopLevelScope(42),
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            NullifierHash: nullifierHash,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            ExpiresAtUnixMs: DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds());

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
            RequiresManualReview: false,
            HideUntilReviewed: false);

    private static byte[] CreateTicket(int seed)
        => Enumerable.Range(0, 32).Select(index => (byte)(index + seed + 1)).ToArray();

    private static string CreateNullifierHash(int seed)
        => Convert.ToHexStringLower(SHA256.HashData(BitConverter.GetBytes(seed)));

    private static Task StartBarrierTaskAsync(Barrier barrier, Func<Task> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for the anonymous outbox PostgreSQL start barrier.");
                await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static void AssertAnonymousCommitState(
        string connectionString,
        int expectedComments,
        int expectedProcessedEvents)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        List<Comment> comments = db.Queryable<Comment>().OrderBy(item => item.Id).ToList();
        List<CommentRevision> revisions = db.Queryable<CommentRevision>().ToList();
        List<CommentRegionCompliance> regions = db.Queryable<CommentRegionCompliance>().ToList();
        List<CommentModerationEvent> moderationEvents = db.Queryable<CommentModerationEvent>().ToList();
        List<CommentAnonymousNullifier> nullifiers = db.Queryable<CommentAnonymousNullifier>().ToList();
        List<CommentMutationOutboxEvent> events = db.Queryable<CommentMutationOutboxEvent>().ToList();

        Assert.Equal(expectedComments, comments.Count);
        Assert.Equal(expectedComments, revisions.Count);
        Assert.Equal(expectedComments, regions.Count);
        Assert.Equal(expectedComments, moderationEvents.Count);
        Assert.Equal(expectedComments, nullifiers.Count);
        Assert.Equal(expectedComments * 2, events.Count);
        Assert.Equal(expectedComments, comments.Select(item => item.Content).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(expectedComments, comments.Select(item => item.AnonymousNullifierHash).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(expectedComments * 2, events.Select(item => item.EventId).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(expectedProcessedEvents, events.Count(item => item.Status == CommentMutationOutboxStatus.Processed));
        Assert.All(comments, comment =>
        {
            Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
            Assert.Equal(42, comment.ArticleId);
            Assert.Equal(1, Assert.Single(nullifiers, item => item.NullifierHash == comment.AnonymousNullifierHash).UseCount);
            Assert.Single(regions, item => item.CommentId == comment.Id);
            CommentMutationOutboxEvent[] commentEvents = [.. events.Where(item => item.CommentId == comment.Id)];
            Assert.Equal(2, commentEvents.Length);
            Assert.All(commentEvents, item =>
            {
                Assert.Equal(comment.Id, item.RootId);
                Assert.Equal(42, item.ArticleId);
            });
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.Created);
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.VisibilityChanged);
        });
    }

    private static void AssertAnonymousDeliveryState(string connectionString, int expectedComments)
    {
        AssertAnonymousCommitState(connectionString, expectedComments, expectedComments * 2);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        List<CommentMutationOutboxEvent> events = db.Queryable<CommentMutationOutboxEvent>().ToList();
        List<CommentMutationOutboxDelivery> deliveries = db.Queryable<CommentMutationOutboxDelivery>().ToList();
        Assert.Equal(expectedComments * 7, deliveries.Count);
        Assert.All(deliveries, item =>
        {
            Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, item.Status);
            Assert.False(string.IsNullOrWhiteSpace(item.ResultDigest));
        });
        Assert.Equal(expectedComments * 2, deliveries.Count(item => item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion));
        Assert.Equal(events.Count, deliveries
            .Where(item => item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion)
            .Select(item => item.OutboxEventId)
            .Distinct()
            .Count());
    }

    private static void AssertBlockedAnonymousWorkerState(
        string connectionString,
        int expectedComments,
        CacheDispatchObservation blockedDispatch)
    {
        const int ClaimedBatchSize = 32;
        using SqlSugarClient db = CreateAnonymousClient(connectionString);
        List<CommentMutationOutboxEvent> events = db.Queryable<CommentMutationOutboxEvent>()
            .OrderBy(item => item.Id)
            .ToList();
        List<CommentMutationOutboxEvent> processing = events
            .Where(item => item.Status == CommentMutationOutboxStatus.Processing)
            .ToList();
        List<CommentMutationOutboxEvent> pending = events
            .Where(item => item.Status == CommentMutationOutboxStatus.Pending)
            .ToList();

        Assert.Equal(expectedComments * 2, events.Count);
        Assert.Equal(ClaimedBatchSize, processing.Count);
        Assert.Equal((expectedComments * 2) - ClaimedBatchSize, pending.Count);
        Assert.Equal(ClaimedBatchSize, processing.Select(item => item.ClaimToken).Distinct(StringComparer.Ordinal).Count());
        Assert.Single(processing.Select(item => item.ClaimedBy).Distinct(StringComparer.Ordinal));
        Assert.All(processing, item =>
        {
            Assert.False(string.IsNullOrWhiteSpace(item.ClaimToken));
            Assert.False(string.IsNullOrWhiteSpace(item.ClaimedBy));
            Assert.Equal(1, item.LeaseGeneration);
            Assert.NotNull(item.ClaimedAt);
            Assert.NotNull(item.LeaseExpiresAt);
            Assert.NotNull(item.LastHeartbeatAt);
        });
        Assert.All(pending, item =>
        {
            Assert.Null(item.ClaimToken);
            Assert.Null(item.ClaimedBy);
            Assert.Equal(0, item.LeaseGeneration);
        });

        CommentMutationOutboxEvent claimed = Assert.Single(events, item => item.Id == blockedDispatch.OutboxId);
        Assert.True(
            claimed.EventType is CommentMutationEventTypes.Created or CommentMutationEventTypes.VisibilityChanged);
        Assert.Equal(claimed.EventId, blockedDispatch.EventId);
        Assert.Equal(claimed.CommentId, blockedDispatch.CommentId);
        Assert.Equal(claimed.ArticleId, blockedDispatch.Scope.ArticleId);
        Assert.Equal(claimed.RootId, blockedDispatch.Scope.RootId);
        Assert.Null(blockedDispatch.Scope.AccountId);
        Assert.True(blockedDispatch.Scope.PublicArticleChanged);
        Assert.False(blockedDispatch.Scope.UserCommentsChanged);

        IReadOnlyList<string> requiredConsumers = CommentMutationOutboxConsumers.RequiredFor(claimed.EventType);
        int cacheIndex = requiredConsumers.ToList().FindIndex(
            static consumer => consumer == CommentMutationOutboxConsumers.CacheVersion);
        Assert.True(cacheIndex >= 0);
        List<CommentMutationOutboxDelivery> deliveries = db.Queryable<CommentMutationOutboxDelivery>()
            .Where(item => item.OutboxEventId == claimed.Id)
            .ToList();
        Assert.Equal(cacheIndex + 1, deliveries.Count);
        Assert.All(requiredConsumers.Take(cacheIndex), consumer =>
        {
            CommentMutationOutboxDelivery completed = Assert.Single(deliveries, item => item.ConsumerName == consumer);
            Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, completed.Status);
        });
        CommentMutationOutboxDelivery reservation = Assert.Single(deliveries, item =>
            item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion);
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Processing, reservation.Status);
        Assert.Equal(1, reservation.AttemptCount);
        Assert.Equal(claimed.ClaimToken, reservation.OwnerClaimToken);
        Assert.Equal(claimed.ClaimedBy, reservation.OwnerWorkerId);
        Assert.Equal(claimed.LeaseGeneration, reservation.LeaseGeneration);
        Assert.NotNull(reservation.StartedAt);
        Assert.NotNull(reservation.LeaseExpiresAt);
        Assert.Null(reservation.CompletedAt);
        Assert.Null(reservation.ResultDigest);
    }

    private static void AssertAnonymousCacheProjectionState(
        string connectionString,
        CacheInvalidationDispatcherProbe invalidations,
        int expectedComments)
    {
        using SqlSugarClient db = CreateAnonymousClient(connectionString);
        List<CommentMutationOutboxEvent> events = db.Queryable<CommentMutationOutboxEvent>()
            .OrderBy(item => item.Id)
            .ToList();
        IReadOnlyCollection<CacheDispatchObservation> observations = invalidations.Observations;
        Assert.Equal(expectedComments * 2, observations.Count);
        Assert.Equal(events.Count, observations.Select(item => item.OutboxId).Distinct().Count());
        Assert.All(observations, observation =>
        {
            CommentMutationOutboxEvent item = Assert.Single(events, candidate => candidate.Id == observation.OutboxId);
            Assert.Equal(item.EventId, observation.EventId);
            Assert.Equal(item.EventType, observation.EventType);
            Assert.Equal(item.CommentId, observation.CommentId);
            Assert.Equal(item.ArticleId, observation.Scope.ArticleId);
            Assert.Equal(item.RootId, observation.Scope.RootId);
            Assert.Null(observation.Scope.AccountId);
            Assert.True(observation.Scope.PublicArticleChanged);
            Assert.False(observation.Scope.UserCommentsChanged);
        });
        Assert.All(events.GroupBy(item => item.CommentId), commentEvents =>
        {
            Assert.Equal(2, commentEvents.Count());
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.Created);
            Assert.Contains(commentEvents, item => item.EventType == CommentMutationEventTypes.VisibilityChanged);
            Assert.Equal(2, observations.Count(item => item.CommentId == commentEvents.Key));
            Assert.Equal(2, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, $"article:42:root:{commentEvents.Key}"));
        });
        Assert.Equal(expectedComments * 2, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, "article:42"));
        CacheInvalidationRuntimeSnapshot runtime = invalidations.RuntimeState.Snapshot();
        Assert.Equal(expectedComments * 2, runtime.CommentMutationCount);
        Assert.Equal(expectedComments * 2, runtime.StatsCount);
    }

    private static AnonymousRetrySnapshot AssertAnonymousRetryableFailureState(
        string connectionString,
        FailOnceCacheInvalidationDispatcher invalidations)
    {
        using SqlSugarClient db = CreateAnonymousClient(connectionString);
        List<CommentMutationOutboxEvent> events = db.Queryable<CommentMutationOutboxEvent>()
            .OrderBy(item => item.Id)
            .ToList();
        CommentMutationOutboxEvent failed = Assert.Single(events, item => item.Status == CommentMutationOutboxStatus.Failed);
        Assert.Equal(CommentMutationEventTypes.Created, failed.EventType);
        Assert.Equal(1, failed.AttemptCount);
        Assert.Null(failed.ClaimToken);
        Assert.Null(failed.ClaimedAt);
        Assert.Null(failed.LeaseExpiresAt);
        Assert.Contains("TimeoutException: temporary-cache-outage", failed.LastError, StringComparison.Ordinal);
        Assert.Single(events, item => item.Status == CommentMutationOutboxStatus.Processed);

        CommentMutationOutboxDelivery delivery = db.Queryable<CommentMutationOutboxDelivery>()
            .Single(item => item.OutboxEventId == failed.Id
                && item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion);
        Assert.Equal(CommentMutationOutboxDeliveryStatus.RetryableFailed, delivery.Status);
        Assert.Equal(1, delivery.AttemptCount);
        Assert.False(string.IsNullOrWhiteSpace(delivery.OwnerClaimToken));
        Assert.False(string.IsNullOrWhiteSpace(delivery.OwnerWorkerId));
        Assert.Equal(1, delivery.LeaseGeneration);
        Assert.Null(delivery.LeaseExpiresAt);
        Assert.Null(delivery.CompletedAt);
        Assert.Null(delivery.ResultDigest);
        Assert.Equal(nameof(TimeoutException), delivery.LastFailureKind);
        Assert.Equal("TimeoutException: temporary-cache-outage", delivery.LastError);
        Assert.Equal(1, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, "article:42"));
        Assert.Equal(1, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, $"article:42:root:{failed.CommentId}"));
        Assert.Equal(1, invalidations.RuntimeState.Snapshot().CommentMutationCount);
        return new AnonymousRetrySnapshot(failed.Id, failed.EventId, failed.CommentId);
    }

    private static void AssertAnonymousRecoveredRetryState(
        string connectionString,
        FailOnceCacheInvalidationDispatcher invalidations,
        AnonymousRetrySnapshot retry)
    {
        using SqlSugarClient db = CreateAnonymousClient(connectionString);
        CommentMutationOutboxEvent recovered = db.Queryable<CommentMutationOutboxEvent>().InSingle(retry.OutboxId);
        Assert.Equal(retry.EventId, recovered.EventId);
        Assert.Equal(retry.CommentId, recovered.CommentId);
        Assert.Equal(CommentMutationOutboxStatus.Processed, recovered.Status);
        Assert.Equal(1, recovered.AttemptCount);
        Assert.NotNull(recovered.ProcessedAtUtc);
        Assert.Null(recovered.ClaimToken);
        Assert.Null(recovered.LastError);

        CommentMutationOutboxDelivery delivery = db.Queryable<CommentMutationOutboxDelivery>()
            .Single(item => item.OutboxEventId == retry.OutboxId
                && item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion);
        Assert.Equal(CommentMutationOutboxDeliveryStatus.Completed, delivery.Status);
        Assert.Equal(2, delivery.AttemptCount);
        Assert.Equal(CommentMutationOutboxWorker.BuildDeliveryResultDigest(recovered, CommentMutationOutboxConsumers.CacheVersion), delivery.ResultDigest);
        Assert.NotNull(delivery.CompletedAt);
        Assert.Null(delivery.LastFailureKind);
        Assert.Null(delivery.LastError);
        Assert.Equal(2, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, "article:42"));
        Assert.Equal(2, invalidations.Counters.Read(CachePolicyId.CommentCursorVersion, $"article:42:root:{retry.CommentId}"));
        Assert.Equal(2, invalidations.RuntimeState.Snapshot().CommentMutationCount);
        Assert.Equal(2, invalidations.Observations.Count(item => item.OutboxId == retry.OutboxId));
    }

    private sealed class FixedTicketService(AnonymousCommentTicketPayload payload) : IAnonymousCommentTicketService
    {
        private int _consumed;

        public Task<AnonymousCommentTicketIssueResult> IssueAsync(
            AnonymousCommentTicketRequestCoreModel request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ReadTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<AnonymousCommentTicketPayload>(true, payload));

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
            byte[] ticket,
            CancellationToken cancellationToken = default)
        {
            bool found = Interlocked.Exchange(ref _consumed, 1) == 0;
            return Task.FromResult(new CacheReadResult<AnonymousCommentTicketPayload>(found, found ? payload : default));
        }
    }

    private sealed record CacheDispatchObservation(
        long OutboxId,
        string EventId,
        string EventType,
        long CommentId,
        CommentCacheInvalidationScope Scope);

    private sealed record AnonymousRetrySnapshot(long OutboxId, string EventId, long CommentId);

    private abstract class CacheInvalidationDispatcherProbe : ICacheInvalidationDispatcher
    {
        private readonly string _connectionString;
        private readonly ConcurrentQueue<CacheDispatchObservation> _observations = new();
        private readonly CacheInvalidationDispatcher _inner;
        private int _callCount;

        protected CacheInvalidationDispatcherProbe(string connectionString)
        {
            _connectionString = connectionString;
            Counters = new InMemoryCacheCounterStore();
            RuntimeState = new CacheInvalidationRuntimeState();
            _inner = new CacheInvalidationDispatcher(
                Counters,
                Substitute.For<ICacheInvalidationStore>(),
                Substitute.For<IHttpCacheInvalidator>(),
                RuntimeState);
        }

        public int CallCount => Volatile.Read(ref _callCount);
        public IReadOnlyCollection<CommentCacheInvalidationScope> Scopes => _observations.Select(item => item.Scope).ToArray();
        public IReadOnlyCollection<CacheDispatchObservation> Observations => _observations.ToArray();
        public InMemoryCacheCounterStore Counters
        {
            get;
        }
        public CacheInvalidationRuntimeState RuntimeState
        {
            get;
        }

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public async Task InvalidateCommentMutationAsync(
            CommentCacheInvalidationScope? scope = null,
            CancellationToken cancellationToken = default)
        {
            Assert.NotNull(scope);
            CacheDispatchObservation observation = ObserveCacheReservation(_connectionString, scope);
            _observations.Enqueue(observation);
            int call = Interlocked.Increment(ref _callCount);
            await BeforeDispatchAsync(call, cancellationToken);
            await _inner.InvalidateCommentMutationAsync(scope, cancellationToken);
        }

        protected abstract Task BeforeDispatchAsync(int call, CancellationToken cancellationToken);

        private static CacheDispatchObservation ObserveCacheReservation(
            string connectionString,
            CommentCacheInvalidationScope scope)
        {
            using SqlSugarClient db = CreateAnonymousClient(connectionString);
            CommentMutationOutboxDelivery reservation = db.Queryable<CommentMutationOutboxDelivery>()
                .Single(item => item.ConsumerName == CommentMutationOutboxConsumers.CacheVersion
                    && item.Status == CommentMutationOutboxDeliveryStatus.Processing);
            CommentMutationOutboxEvent item = db.Queryable<CommentMutationOutboxEvent>().InSingle(reservation.OutboxEventId);
            Assert.Equal(item.ClaimToken, reservation.OwnerClaimToken);
            Assert.Equal(item.ClaimedBy, reservation.OwnerWorkerId);
            Assert.Equal(item.CommentId, scope.RootId);
            return new CacheDispatchObservation(item.Id, item.EventId, item.EventType, item.CommentId, scope);
        }

        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class BlockingCacheInvalidationDispatcher(string connectionString)
        : CacheInvalidationDispatcherProbe(connectionString)
    {
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Entered => _entered.Task;

        protected override async Task BeforeDispatchAsync(int call, CancellationToken cancellationToken)
        {
            _entered.TrySetResult();
            await _release.Task.WaitAsync(cancellationToken);
        }

        public void Release() => _release.TrySetResult();
    }

    private sealed class FailOnceCacheInvalidationDispatcher(string connectionString)
        : CacheInvalidationDispatcherProbe(connectionString)
    {
        protected override Task BeforeDispatchAsync(int call, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return call == 1
                ? Task.FromException(new TimeoutException("temporary-cache-outage"))
                : Task.CompletedTask;
        }
    }

    private sealed class InMemoryCacheCounterStore : ICacheCounterStore
    {
        private readonly ConcurrentDictionary<(CachePolicyId PolicyId, string Identity), long> _values = new();

        public Task<long> IncrementAsync(
            CachePolicyId policyId,
            string identity,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long updated = _values.AddOrUpdate((policyId, identity), value, (_, current) => current + value);
            return Task.FromResult(updated);
        }

        public long Read(CachePolicyId policyId, string identity)
            => _values.TryGetValue((policyId, identity), out long value) ? value : 0;
    }
}
